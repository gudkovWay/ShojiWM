//! Native DRM output power ("Screen Off") lease endpoint.
//!
//! Screen Off is a *power* state, deliberately independent of both the
//! configured output mode and `ShojiWM::tty_session_active` (VT/suspend
//! state). While a lease is held the compositor must not touch the CRTCs:
//! no render, no cursor-plane commit, no deferred submit, no mode change.
//! The outputs are cleared once (`DrmCompositor::clear()` sets DPMS off and
//! disables every plane) and re-enabled by the next real commit when the
//! lease ends.
//!
//! Protocol:
//!
//! * A same-UID abstract Unix socket named
//!   `shojiwm-output-power-<euid>-<FNV1a64 of the Wayland socket path>`.
//! * Newline-framed commands: `off`, `on`, `state`, `identity` and
//!   `temperature <integer>`. A line is bounded to [`MAX_COMMAND_BYTES`];
//!   anything longer, empty, non-UTF-8, non-integer or out of range is a
//!   protocol error and closes the connection.
//! * Replies: `ok off` / `ok on` (for `state` the native current power state),
//!   `ok temperature` / `ok identity` / `ok deferred`, or `error <message>`.
//! * The connection that sends `off` owns the lease; another `off` cannot
//!   replace it. Any same-UID connection may send `on`.
//! * The owner's disconnect (EOF) or a protocol violation restores the
//!   outputs. `off` is acknowledged only after the DRM clear actually
//!   succeeded.
//! * `temperature <integer>` sets the whole-output DRM CTM to the warm gain
//!   matrix for that color temperature (Kelvin, 1000..=20000) and `identity`
//!   restores each output's original transform. Unlike the power lease this
//!   target is *not* tied to the connection: closing it leaves the target
//!   applied, and a target already applied is a no-op for the hardware. While
//!   the outputs are dark or the VT is inactive no property is written: the
//!   target is recorded and answered `ok deferred`, then applied when the
//!   outputs come back. A real ioctl/driver failure — or a driver without
//!   CTM support — is always an `error` reply, never `ok`. See
//!   `crate::night_color`.
//! * Reads and writes are nonblocking and allocation-free on the common path:
//!   a client can never stall the compositor event loop, and a reply the
//!   socket will not take immediately closes the connection instead of being
//!   buffered (the lease EOF then restores the outputs).

use std::{
    collections::HashMap,
    ffi::OsStr,
    io::ErrorKind,
    os::{
        fd::AsFd,
        linux::net::SocketAddrExt,
        unix::ffi::OsStrExt,
        unix::net::{SocketAddr, UnixListener, UnixStream},
    },
    path::{Path, PathBuf},
};

use smithay::reexports::{
    calloop::{EventLoop, Interest, Mode, PostAction, generic::Generic},
    rustix::{
        io::{Errno, read as rustix_read, write as rustix_write},
        net::sockopt::socket_peercred,
    },
};
use tracing::{debug, info, warn};

use crate::night_color::ColorTarget;
use crate::state::ShojiWM;

/// Largest accepted request line, in bytes (newline included). A connection
/// that fills this without a newline is answered with an error and closed.
const MAX_COMMAND_BYTES: usize = 1024;

/// Native output power state plus the connections currently holding or
/// watching the darkness lease.
///
/// This is UI-independent native state: it lives on `ShojiWM` rather than
/// inside a single output's `SurfaceData`, because the lease covers every
/// output and must survive surface rebuilds (hotplug, VT resume).
pub struct OutputPowerState {
    /// Whether the outputs are currently *requested* dark. Only set once the
    /// corresponding DRM clear succeeded; cleared as soon as any path restores
    /// the outputs.
    off: bool,
    /// Connection id that owns the current `off` lease, if any.
    owner: Option<u64>,
    next_connection_id: u64,
    connections: HashMap<u64, OutputPowerConnection>,
}

impl Default for OutputPowerState {
    fn default() -> Self {
        Self {
            off: false,
            owner: None,
            next_connection_id: 0,
            connections: HashMap::new(),
        }
    }
}

impl OutputPowerState {
    /// Whether native output power is currently dark.
    ///
    /// Callers that can cause a DRM commit must consult this and skip the
    /// commit entirely while it is `true`.
    pub fn is_off(&self) -> bool {
        self.off
    }
}

struct OutputPowerConnection {
    /// Incoming bytes not yet consumed. Fixed size, so a client can never make
    /// the compositor grow memory with a partial line.
    buffer: [u8; MAX_COMMAND_BYTES],
    buffered: usize,
}

impl Default for OutputPowerConnection {
    fn default() -> Self {
        Self {
            buffer: [0u8; MAX_COMMAND_BYTES],
            buffered: 0,
        }
    }
}

/// A reply to a single command.
enum CommandReply {
    /// A fixed positive/negative acknowledgement.
    Static(&'static str),
    /// An error whose text is a fixed literal.
    StaticError(&'static str),
    /// A real DRM/apply failure; the only reply that needs owned text.
    Error(String),
}

/// A client request that survived protocol classification.
enum ClientCommand {
    Off,
    On,
    State,
    Identity,
    Temperature(ColorTarget),
}

/// Parse one command line strictly.
///
/// `Err` carries the protocol-error text the client receives; the caller then
/// closes the connection. A malformed or out-of-range temperature argument is
/// an error, never a guessed target.
fn parse_client_command(command: &str) -> Result<ClientCommand, &'static str> {
    match command {
        "off" => Ok(ClientCommand::Off),
        "on" => Ok(ClientCommand::On),
        "state" => Ok(ClientCommand::State),
        "identity" => Ok(ClientCommand::Identity),
        "" => Err("empty command"),
        "temperature" => Err("invalid temperature value"),
        _ => match command.strip_prefix("temperature ") {
            Some(argument) => {
                ColorTarget::from_kelvin_argument(argument).map(ClientCommand::Temperature)
            }
            None => Err("unknown command"),
        },
    }
}

/// Abstract socket name shared with the Screen Off client.
///
/// The identity is the canonicalized Wayland socket path, not the display
/// basename: two independent `XDG_RUNTIME_DIR`s can both hold a `wayland-1`,
/// and naming the endpoint after the basename alone would let a future nested
/// sandbox connect to the live compositor's lease. A relative `socket_name` is
/// joined onto `XDG_RUNTIME_DIR`, then canonicalized (resolving symlinks) so an
/// absolute `WAYLAND_DISPLAY` and a symlinked runtime directory land on the
/// same endpoint. A missing `XDG_RUNTIME_DIR` or a canonicalization failure
/// means the endpoint cannot be named (registration fails, the client fails
/// closed); returns `None` — never a fallback directory.
///
/// The canonical path bytes are folded with FNV-1a (64-bit) so the name is a
/// fixed `shojiwm-output-power-<euid>-<16 lowercase hex>`; the client derives
/// the same value with the same byte algorithm (`os.path.realpath` +
/// `os.fsencode` on the Python side).
pub fn endpoint_name_for_socket(socket_name: &OsStr) -> Option<String> {
    const FNV_OFFSET_BASIS: u64 = 14_695_981_039_346_656_037;

    let raw = if Path::new(socket_name).is_absolute() {
        PathBuf::from(socket_name)
    } else {
        let runtime_dir = std::env::var_os("XDG_RUNTIME_DIR")?;
        let mut path = PathBuf::from(runtime_dir);
        path.push(socket_name);
        path
    };
    let canonical = std::fs::canonicalize(&raw).ok()?;
    let hash = fnv1a64_update(FNV_OFFSET_BASIS, canonical.as_os_str().as_bytes());

    Some(format!(
        "shojiwm-output-power-{}-{:016x}",
        unsafe { libc::geteuid() },
        hash
    ))
}

fn fnv1a64_update(mut hash: u64, bytes: &[u8]) -> u64 {
    const FNV_PRIME: u64 = 1_099_511_628_211;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

/// Register the lease endpoint after the Wayland socket has been created, so
/// the endpoint name folds the actual socket path (see
/// [`endpoint_name_for_socket`]).
///
/// Registration failure is reported to the caller (which logs it and keeps
/// starting: the client then fails closed with the screens lit). A relative
/// socket with no `XDG_RUNTIME_DIR` cannot be named and fails here rather than
/// using a shared fallback directory.
pub fn register_output_power_endpoint(
    event_loop: &mut EventLoop<'static, ShojiWM>,
    socket_name: &OsStr,
) -> std::io::Result<()> {
    let name = endpoint_name_for_socket(socket_name).ok_or_else(|| {
        std::io::Error::other("XDG_RUNTIME_DIR is not set; cannot name the output power endpoint")
    })?;
    let address = SocketAddr::from_abstract_name(name.as_bytes())?;
    let listener = UnixListener::bind_addr(&address)?;
    listener.set_nonblocking(true)?;
    let uid = unsafe { libc::geteuid() };

    event_loop
        .handle()
        .insert_source(
            Generic::new(listener, Interest::READ, Mode::Level),
            move |_, listener, state| {
                match listener.accept() {
                    Ok((stream, _)) => match socket_peercred(&stream) {
                        Ok(peer) if peer.uid.as_raw() == uid => {
                            if let Err(error) = register_connection(state, stream) {
                                warn!(?error, "failed to register output power connection");
                            }
                        }
                        Ok(_) => warn!("rejected output power request from another user"),
                        Err(error) => {
                            warn!(?error, "failed to read output power peer credentials")
                        }
                    },
                    Err(error) if error.kind() == ErrorKind::WouldBlock => {}
                    Err(error) => warn!(?error, "failed to accept output power request"),
                }
                Ok(PostAction::Continue)
            },
        )
        .map_err(|error| std::io::Error::other(error.to_string()))?;

    info!(endpoint = %name, "registered output power lease endpoint");
    Ok(())
}

fn register_connection(state: &mut ShojiWM, stream: UnixStream) -> std::io::Result<()> {
    stream.set_nonblocking(true)?;
    let id = state.output_power.next_connection_id;
    state.output_power.next_connection_id = id.wrapping_add(1);

    let handle = state.loop_handle.clone();
    if let Err(error) = handle.insert_source(
        Generic::new(stream, Interest::READ, Mode::Level),
        move |_, stream, state| handle_connection_event(state, id, &*stream),
    ) {
        return Err(std::io::Error::other(error.to_string()));
    }

    state
        .output_power
        .connections
        .insert(id, OutputPowerConnection::default());
    debug!(connection = id, "output power lease client connected");
    Ok(())
}

fn handle_connection_event<S: AsFd>(
    state: &mut ShojiWM,
    id: u64,
    stream: &S,
) -> std::io::Result<PostAction> {
    // Take the connection out for the duration of the handler so its buffer
    // does not alias `state` while commands mutate it. Reinserted unless the
    // connection is closing.
    let Some(mut connection) = state.output_power.connections.remove(&id) else {
        return Ok(PostAction::Remove);
    };

    // Drain whatever the client has sent. Nonblocking: `WouldBlock` ends the
    // drain; `Interrupted` retries. EOF and hard errors close the connection.
    let mut eof = false;
    loop {
        if connection.buffered == MAX_COMMAND_BYTES {
            break;
        }
        match rustix_read(stream, &mut connection.buffer[connection.buffered..]) {
            Ok(0) => {
                eof = true;
                break;
            }
            Ok(read) => {
                connection.buffered += read;
            }
            Err(Errno::WOULDBLOCK) => break,
            Err(Errno::INTR) => continue,
            Err(_) => {
                eof = true;
                break;
            }
        }
    }

    // Consume complete newline-terminated commands, bounded by the buffer. A
    // malformed line or a reply the socket will not take closes the connection
    // immediately (the lease EOF then restores the outputs).
    let mut close = false;
    loop {
        let Some(newline) = connection.buffer[..connection.buffered]
            .iter()
            .position(|byte| *byte == b'\n')
        else {
            break;
        };

        let line = &connection.buffer[..newline];
        let (reply, malformed) = match std::str::from_utf8(line) {
            Ok(raw) => match parse_client_command(raw.trim()) {
                Ok(command) => (handle_command(state, id, command), false),
                Err(message) => (CommandReply::StaticError(message), true),
            },
            Err(_) => (CommandReply::StaticError("invalid command"), true),
        };

        let wrote = write_reply(stream, &reply);

        let consumed = newline + 1;
        let remaining = connection.buffered - consumed;
        connection
            .buffer
            .copy_within(consumed..connection.buffered, 0);
        connection.buffered = remaining;

        if malformed || !wrote {
            close = true;
            break;
        }
    }

    // A full buffer without a newline is an oversized line.
    if !close && connection.buffered == MAX_COMMAND_BYTES {
        let _ = write_reply(stream, &CommandReply::StaticError("command too long"));
        close = true;
    }
    if eof {
        close = true;
    }

    if close {
        connection_closed(state, id);
        Ok(PostAction::Remove)
    } else {
        state.output_power.connections.insert(id, connection);
        Ok(PostAction::Continue)
    }
}

fn handle_command(state: &mut ShojiWM, id: u64, command: ClientCommand) -> CommandReply {
    match command {
        ClientCommand::Off => request_output_off(state, id),
        ClientCommand::On => request_output_on(state),
        ClientCommand::State => CommandReply::Static(if state.output_power.off {
            "ok off"
        } else {
            "ok on"
        }),
        ClientCommand::Identity => request_color_target(state, ColorTarget::Identity),
        ClientCommand::Temperature(target) => request_color_target(state, target),
    }
}

/// Apply a color temperature target to every output, or defer it while the
/// hardware cannot be touched.
///
/// While the Screen Off lease is dark or the tty session is inactive no DRM
/// property is written: the target is recorded in the global state and the
/// client is told `ok deferred` (the power-on/resume paths reapply it). A
/// request that cannot be honoured for real is an error, never a success, and
/// a failed global apply leaves the previous target in place.
fn request_color_target(state: &mut ShojiWM, target: ColorTarget) -> CommandReply {
    if state.output_power.is_off() || !state.tty_session_active {
        state.night_color_target = target;
        info!(
            ?target,
            "night color target recorded while outputs are unavailable; deferred"
        );
        return CommandReply::Static("ok deferred");
    }
    if crate::backend::tty::tty_output_color_count(state) == 0 {
        return CommandReply::StaticError("no drm outputs");
    }

    match crate::backend::tty::apply_night_color_target(state, target) {
        Ok(()) => {
            state.night_color_target = target;
            info!(?target, "native night color target applied to all outputs");
            CommandReply::Static(match target {
                ColorTarget::Identity => "ok identity",
                ColorTarget::Kelvin(_) => "ok temperature",
            })
        }
        Err(message) => {
            warn!(
                ?target,
                %message,
                "failed to apply native night color to all outputs; previous target kept"
            );
            CommandReply::Error(message)
        }
    }
}

fn request_output_off(state: &mut ShojiWM, id: u64) -> CommandReply {
    if state.output_power.off {
        if state.output_power.owner == Some(id) {
            return CommandReply::Static("ok off");
        }
        // The lease already has an owner; a second client cannot steal it.
        return CommandReply::StaticError("already off");
    }

    match crate::backend::tty::apply_output_power_off(state) {
        Ok(()) => {
            state.output_power.off = true;
            state.output_power.owner = Some(id);
            info!(connection = id, "tty outputs powered off for screen-off lease");
            CommandReply::Static("ok off")
        }
        Err(message) => {
            // `apply_output_power_off` has already queued restoration of the
            // outputs; the native state stays power-on and the client fails
            // closed with the screens lit.
            warn!(
                connection = id,
                %message,
                "failed to power off tty outputs; screens left lit"
            );
            CommandReply::Error(message)
        }
    }
}

fn request_output_on(state: &mut ShojiWM) -> CommandReply {
    if !state.output_power.off {
        state.output_power.owner = None;
        return CommandReply::Static("ok on");
    }

    match crate::backend::tty::apply_output_power_on(state) {
        Ok(()) => {
            state.output_power.off = false;
            state.output_power.owner = None;
            info!("tty outputs powered on; full redraw queued");
            CommandReply::Static("ok on")
        }
        Err(message) => {
            warn!(%message, "failed to power on tty outputs");
            CommandReply::Error(message)
        }
    }
}

/// Drop a connection, restoring the outputs if it owned the lease.
fn connection_closed(state: &mut ShojiWM, id: u64) {
    state.output_power.connections.remove(&id);
    if state.output_power.owner != Some(id) {
        return;
    }

    state.output_power.owner = None;
    if state.output_power.off {
        match crate::backend::tty::apply_output_power_on(state) {
            Ok(()) => {
                state.output_power.off = false;
                info!(
                    connection = id,
                    "tty outputs restored after screen-off lease owner disconnected"
                );
            }
            Err(message) => {
                warn!(
                    connection = id,
                    %message,
                    "failed to restore tty outputs after lease owner disconnect"
                );
            }
        }
    }
}

/// Write one reply without ever blocking. Returns `false` when the socket
/// could not take the whole reply immediately (or errored); the caller then
/// closes the connection rather than queueing the remainder.
fn write_reply<S: AsFd>(stream: &S, reply: &CommandReply) -> bool {
    match reply {
        CommandReply::Static(text) => {
            let mut buffer = [0u8; 32];
            buffer[..text.len()].copy_from_slice(text.as_bytes());
            buffer[text.len()] = b'\n';
            write_all_nonblocking(stream, &buffer[..text.len() + 1])
        }
        CommandReply::StaticError(text) => {
            let prefix = b"error ";
            let mut buffer = [0u8; 64];
            buffer[..prefix.len()].copy_from_slice(prefix);
            buffer[prefix.len()..prefix.len() + text.len()].copy_from_slice(text.as_bytes());
            let end = prefix.len() + text.len();
            buffer[end] = b'\n';
            write_all_nonblocking(stream, &buffer[..end + 1])
        }
        CommandReply::Error(message) => {
            let mut text = String::with_capacity(message.len() + 8);
            text.push_str("error ");
            text.push_str(message);
            text.push('\n');
            write_all_nonblocking(stream, text.as_bytes())
        }
    }
}

fn write_all_nonblocking<S: AsFd>(stream: &S, bytes: &[u8]) -> bool {
    let mut written = 0;
    while written < bytes.len() {
        match rustix_write(stream, &bytes[written..]) {
            Ok(0) => return false,
            Ok(count) => written += count,
            Err(Errno::WOULDBLOCK) => return false,
            Err(Errno::INTR) => continue,
            Err(_) => return false,
        }
    }
    true
}
