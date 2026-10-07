//! Native whole-output color temperature ("night mode") via the DRM CTM
//! property.
//!
//! The color transform applied by this module covers the *entire* output:
//! the kernel's CTM (color transform matrix) runs on the CRTC after plane
//! composition, so it also affects the cursor plane and direct-scanout
//! clients — which is exactly what a shader-based approach cannot do. The
//! CRTC property is written through `ControlDevice::set_property`
//! (`DRM_MODE_SETPROPERTY`, the atomic-compatibility ioctl). Ordinary Smithay
//! commits do not clear it because their property set never includes the CTM,
//! which is why a write here survives page flips, modesets and DPMS — and why
//! lifecycle points force one reapply instead of it being maintained per frame.
//!
//! ShojiWM keeps one global [`ColorTarget`] on [`ShojiWM`](crate::state::ShojiWM)
//! and one [`OutputColorState`] per DRM surface:
//!
//! * The global target is what the native endpoint asked for. It is the target
//!   reapplied at output creation, surface rebuild, mode change, VT resume and
//!   Screen Off wake.
//! * The per-output state caches the CRTC's CTM property, the target currently
//!   applied to it, and the blob this module created (so it can be destroyed
//!   and replaced). It also snapshots the *bytes* of the transform the driver
//!   had before ShojiWM touched it, so `identity` restores the real original
//!   (or the driver default when the property was unset) instead of
//!   approximating it with a 6500 K matrix.
//!
//! Blobs are never borrowed: a kernel blob id read from a property is turned
//! into bytes immediately, and restoration re-creates a blob from those bytes.
//! A blob id owned by this module is destroyed as soon as it is replaced or
//! when the output goes away, so no kernel object leaks while the compositor
//! is running and no borrowed id is retained past another cleanup.
//!
//! The gains are the upstream Hyprsunset/Tanner-Helland RGB gains (gamma 1,
//! no DDC/brightness factor) encoded as the kernel's `drm_color_ctm` payload:
//! nine S31.32 fixed-point values with the gains on the diagonal. Applying the
//! same target twice is a no-op for the hardware — no blob, no ioctl.

use smithay::{
    backend::drm::DrmDeviceFd,
    reexports::drm::control::{Device as _, crtc, property},
};
use tracing::{debug, warn};

/// Lowest accepted color temperature, in Kelvin.
pub const MIN_KELVIN: u32 = 1_000;
/// Highest accepted color temperature, in Kelvin.
pub const MAX_KELVIN: u32 = 20_000;

/// One S31.32 fixed-point unit (`1 << 32`), the kernel CTM's fractional base.
const FIXED_ONE: f64 = 4_294_967_296.0;

/// The color target requested for every output.
///
/// `Identity` is the real pre-existing transform (captured per output) or the
/// driver default when the CRTC had no CTM blob; it is deliberately not a
/// "neutral" 6500 K matrix, which would still write a transform.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ColorTarget {
    /// Restore the output's original color transform.
    Identity,
    /// Warm shift for this color temperature, in Kelvin.
    Kelvin(u32),
}

impl Default for ColorTarget {
    fn default() -> Self {
        Self::Identity
    }
}

impl ColorTarget {
    /// Parse the argument of the `temperature <integer>` command.
    ///
    /// Strict: only a bare base-10 integer inside `MIN_KELVIN..=MAX_KELVIN`
    /// is accepted. Anything else is a protocol error, never a guessed target.
    pub fn from_kelvin_argument(argument: &str) -> Result<Self, &'static str> {
        // `u32::from_str` also accepts a leading `+`; the protocol promises a
        // bare base-10 integer, so require digits only.
        if argument.is_empty() || !argument.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err("invalid temperature value");
        }
        let kelvin: u32 = argument
            .parse()
            .map_err(|_| "temperature out of range")?;
        if !(MIN_KELVIN..=MAX_KELVIN).contains(&kelvin) {
            return Err("temperature out of range");
        }
        Ok(Self::Kelvin(kelvin))
    }
}

/// The pre-existing CTM captured by an output color state.
///
/// Kept so a state that replaces another one on the same CRTC (a reused CRTC
/// after a disconnect event that carried no CRTC left a stale surface behind)
/// cannot mistake this module's own applied transform for the driver's
/// original: the replaced state's capture is inherited instead of re-reading
/// the live blob.
pub enum CapturedCtm {
    /// The CRTC carried no CTM blob: the driver default.
    Unset,
    /// The CTM blob bytes present before this module wrote anything.
    Bytes(Vec<u8>),
}

/// Per-output native color state.
///
/// Built once per DRM surface. It owns every blob it created and restores the
/// captured original transform on [`OutputColorState::restore`] (also from
/// `Drop`), so removing an output or shutting the compositor down does not
/// leave ShojiWM's color transform behind.
pub struct OutputColorState {
    /// The DRM node's file descriptor (an `Arc` clone, so this is cheap and
    /// does not open a second device).
    device: DrmDeviceFd,
    crtc: crtc::Handle,
    /// The CRTC's CTM property, once found. `None` means the driver exposes no
    /// CTM (or the probe failed and has not succeeded yet).
    ctm: Option<property::Handle>,
    /// Whether the CTM property lookup *and* the original-blob snapshot have
    /// been completed. Anything less stays retriable on the next `apply`.
    probed: bool,
    /// The target currently applied to the CRTC by this module. `None` means
    /// unknown, so the next `apply` writes the property again.
    applied: Option<ColorTarget>,
    /// A blob this module created and the CTM property currently references.
    owned_blob: Option<u64>,
    /// The CTM blob bytes the CRTC carried before this module wrote anything.
    /// `None` means the property was unset, i.e. the driver default.
    original: Option<Vec<u8>>,
    /// The capture of a state this one replaced on the same CRTC, used instead
    /// of reading the live blob once.
    inherited: Option<CapturedCtm>,
}

impl OutputColorState {
    /// Capture this output's CTM property and the transform it currently
    /// carries.
    ///
    /// `inherited` is the capture of a state this one replaces on the same
    /// CRTC (see [`CapturedCtm`]); pass `None` for a genuinely new output, in
    /// which case the live CTM blob is read as the original.
    ///
    /// Never fails the caller: a driver without CTM support (or a failed
    /// probe) only makes a later temperature request return an actionable
    /// error. Monitor creation must not depend on night color.
    pub fn new(device: DrmDeviceFd, crtc: crtc::Handle, inherited: Option<CapturedCtm>) -> Self {
        let mut state = Self {
            device,
            crtc,
            ctm: None,
            probed: false,
            applied: None,
            owned_blob: None,
            original: None,
            inherited,
        };
        if let Err(message) = state.probe() {
            warn!(?crtc, %message, "failed to probe output CTM property");
        }
        state
    }

    /// The pre-existing transform this state captured, for a state that
    /// replaces it on the same CRTC. `None` when there is no trustworthy
    /// capture (the probe never completed, or the driver exposes no CTM).
    pub fn captured_ctm(&self) -> Option<CapturedCtm> {
        if !self.probed || self.ctm.is_none() {
            return None;
        }
        match &self.original {
            Some(bytes) => Some(CapturedCtm::Bytes(bytes.clone())),
            None => Some(CapturedCtm::Unset),
        }
    }

    /// Whether `target` is already applied here.
    pub fn is_applied(&self, target: ColorTarget) -> bool {
        self.applied == Some(target)
    }

    /// Forget the cached application state so the next `apply` writes the CTM
    /// again. Used after lifecycle events (mode change, VT resume, Screen Off
    /// wake) that may have replaced the driver's view of the CRTC.
    pub fn invalidate(&mut self) {
        self.applied = None;
    }

    /// Find the CRTC's CTM property and snapshot the blob it currently carries.
    ///
    /// Completion (`probed`) is only reached once the CTM lookup *and* the
    /// original-blob snapshot are known: a failed snapshot stays retriable and
    /// makes every write fail closed, because treating "could not read" as
    /// "the property was unset" would silently drop the driver's real
    /// calibration and let a later `identity` destroy it.
    fn probe(&mut self) -> Result<(), String> {
        if self.probed {
            return Ok(());
        }
        let props = self
            .device
            .get_properties(self.crtc)
            .map_err(|err| err.to_string())?;

        let mut found = None;
        let mut current = 0u64;
        for (handle, value) in props.iter() {
            let info = self
                .device
                .get_property(*handle)
                .map_err(|err| err.to_string())?;
            if info.name().to_bytes() == b"CTM" {
                found = Some(*handle);
                current = *value;
                break;
            }
        }

        let Some(ctm) = found else {
            // Known unsupported: no property, so nothing to snapshot or write.
            self.probed = true;
            debug!(
                crtc = ?self.crtc,
                "crtc exposes no CTM property; native night color unavailable"
            );
            return Ok(());
        };
        self.ctm = Some(ctm);

        // A state that replaces another one on this CRTC must not re-read the
        // live blob: it may still carry the replaced state's applied
        // transform. Use its capture instead, and leave the application state
        // unknown so the next `apply` writes it explicitly.
        if let Some(captured) = self.inherited.take() {
            if let CapturedCtm::Bytes(bytes) = captured {
                self.original = Some(bytes);
            }
            self.applied = None;
            self.probed = true;
            return Ok(());
        }

        if current == 0 {
            // Property unset: the driver default is what `identity` restores,
            // and it is already in place.
            self.applied = Some(ColorTarget::Identity);
            self.probed = true;
            return Ok(());
        }

        let bytes = self
            .device
            .get_property_blob(current)
            .map_err(|err| format!("failed to snapshot the existing CTM: {err}"))?;
        self.original = Some(bytes);
        // The snapshot *is* the current hardware state.
        self.applied = Some(ColorTarget::Identity);
        self.probed = true;
        Ok(())
    }

    /// Apply `target` to this output.
    ///
    /// A target already applied here is a no-op: no blob is created and no
    /// property is written. Any real ioctl or driver failure is returned as
    /// error text — the caller must never report success on it.
    pub fn apply(&mut self, target: ColorTarget) -> Result<(), String> {
        self.probe()?;
        let Some(ctm) = self.ctm else {
            if target == ColorTarget::Identity {
                // Nothing to restore: an output without a CTM property is
                // already at the driver default, which is exactly what
                // `identity` means here. Record it so this stays a no-op.
                self.applied = Some(ColorTarget::Identity);
                return Ok(());
            }
            // A real temperature target cannot be delivered on this output:
            // never report that as success.
            return Err("CRTC exposes no CTM property".to_string());
        };
        if self.applied == Some(target) {
            return Ok(());
        }

        let blob = match target {
            ColorTarget::Identity => match &self.original {
                Some(bytes) => self.create_blob(bytes.as_slice())?,
                None => None,
            },
            ColorTarget::Kelvin(kelvin) => self.create_blob(&ctm_payload(kelvin))?,
        };

        if let Err(err) = self.device.set_property(self.crtc, ctm, blob.unwrap_or(0)) {
            // The new blob was never published; release our reference.
            if let Some(id) = blob {
                let _ = self.device.destroy_property_blob(id);
            }
            return Err(err.to_string());
        }

        // The property holds its own reference to the new blob now, so the
        // blob we replaced can be released and the new id kept as ours.
        self.destroy_owned_blob();
        self.owned_blob = blob;
        self.applied = Some(target);
        Ok(())
    }

    /// Put the output back to the color state captured at construction and
    /// release every blob this module owns. Best-effort and panic-free: called
    /// from `Drop`, where failures can only be logged.
    pub fn restore(&mut self) {
        if self.applied.is_none() && self.owned_blob.is_none() {
            return;
        }
        if self.applied != Some(ColorTarget::Identity) {
            if let Some(ctm) = self.ctm {
                // Re-create the original blob from the snapshot bytes rather
                // than retaining a borrowed kernel id: another cleanup (e.g.
                // Smithay dropping an old mode blob) may have released it.
                let blob = match &self.original {
                    Some(bytes) => self.create_blob(bytes.as_slice()).unwrap_or_else(|err| {
                        warn!(
                            crtc = ?self.crtc,
                            %err,
                            "failed to recreate the original CTM blob"
                        );
                        None
                    }),
                    None => None,
                };
                if let Err(err) = self.device.set_property(self.crtc, ctm, blob.unwrap_or(0)) {
                    warn!(crtc = ?self.crtc, %err, "failed to restore the original CTM");
                }
                if let Some(id) = blob {
                    let _ = self.device.destroy_property_blob(id);
                }
            }
        }
        self.destroy_owned_blob();
        self.applied = None;
    }

    fn create_blob<T: ?Sized>(&self, data: &T) -> Result<Option<u64>, String> {
        match self.device.create_property_blob(data) {
            Ok(property::Value::Blob(id)) => Ok(Some(id)),
            // Never fall back to a 0/unset CTM on an unexpected variant: that
            // would reset the output's transform and report success.
            Ok(_) => Err("DRM returned a non-blob value for the CTM property".to_string()),
            Err(err) => Err(err.to_string()),
        }
    }

    fn destroy_owned_blob(&mut self) {
        if let Some(id) = self.owned_blob.take() {
            if let Err(err) = self.device.destroy_property_blob(id) {
                warn!(crtc = ?self.crtc, %err, "failed to destroy an owned CTM blob");
            }
        }
    }
}

impl Drop for OutputColorState {
    fn drop(&mut self) {
        self.restore();
    }
}

/// Tanner-Helland RGB gains for a color temperature, matching upstream
/// Hyprsunset's `matrixForKelvin` (gamma 1, no DDC/brightness factor).
///
/// Returns the three channel gains, already divided by 255 and clamped to
/// `0.0..=1.0`. Positive diagonal only: no cross-channel mixing.
fn kelvin_gains(kelvin: u32) -> [f64; 3] {
    let temp = f64::from(kelvin) / 100.0;

    let (r, g, b) = if temp <= 66.0 {
        let r = 255.0;
        let g = (99.470_802_586_1 * temp.ln() - 161.119_568_166_1).clamp(0.0, 255.0);
        let b = if temp <= 19.0 {
            0.0
        } else {
            ((temp - 10.0).ln() * 138.517_731_223_1 - 305.044_792_730_7).clamp(0.0, 255.0)
        };
        (r, g, b)
    } else {
        let r = (329.698_727_446 * (temp - 60.0).powf(-0.133_204_759_2)).clamp(0.0, 255.0);
        let g = (288.122_169_528_3 * (temp - 60.0).powf(-0.075_514_849_2)).clamp(0.0, 255.0);
        (r, g, 255.0)
    };

    [r / 255.0, g / 255.0, b / 255.0]
}

/// Build the `drm_color_ctm` payload: nine S31.32 fixed-point values, the
/// positive channel gains on the diagonal.
fn ctm_payload(kelvin: u32) -> [u64; 9] {
    let [r, g, b] = kelvin_gains(kelvin);
    let fixed = |gain: f64| (gain * FIXED_ONE) as u64;
    [
        fixed(r),
        0,
        0,
        0,
        fixed(g),
        0,
        0,
        0,
        fixed(b),
    ]
}
