/**
 * Frozen typed contracts for the four painterly native Rainlit frame packs
 * (02/06/07/09). Shared by the pack modules (`frame-{id}.ts`), the core
 * runtime (`runtime.ts`), the native doll controls (`controls.tsx`) and the
 * config integration. Nothing in this module constructs signals, loads
 * assets or compiles effects: it is types and pure constants only.
 *
 * Coordinate semantics (frozen by owner approval):
 * - All geometry is LOGICAL pixels. Atlas `Rect` cells are SOURCE pixels.
 * - A layer `anchor` is a POINT on the root frame: tl=(0,0), tr=(W,0),
 *   bl=(0,H), br=(W,H). `offset` is the layer TOP-LEFT translation from
 *   that point, signed +x right / +y down. No automatic subtraction of the
 *   layer size or corner anchoring is performed by the renderer.
 * - `pivot` is a local logical pixel point measured from the layer's own
 *   top-left; `angle` channels are radians.
 * - A child's `offset`/`pivot` are relative to the parent's UNROTATED
 *   top-left. The renderer maps the child's attachment by the parent's
 *   rotation about the parent's own pivot (pivot-inclusive FK) and accumulates
 *   child rotations, so a rotating parent never separates its chains.
 * - Core uniformly scales every ORNAMENT layer's size, pivot and offset
 *   (including chain attachment offsets) by `s = min(1, W/minW, H/minH)` for
 *   roots below the declared `minimumRoot`; root anchors stay at their corner.
 *   Rails, corner caps and native buttons never shrink.
 * - `emission` channels are RGB LIGHT GAIN (neutral ≈ 1). They multiply the
 *   sampled RGB of authored emissive overlay cells (real region alpha, never
 *   a full rectangle) and preserve mask alpha; they are NOT opacity pulses.
 * - `controls` strings are standalone asset paths relative to the config
 *   package root (same base as `atlas`): `./assets/rainlit-frames/{id}/…`.
 */
import type { MaybeSignal, ReadonlySignal } from "shoji_wm/types";

/** Identifiers of the four approved painterly frame packs. */
export type RainlitFrameId = "02" | "06" | "07" | "09";

/** Atlas cell `[x, y, width, height]` in SOURCE pixels. */
export type Rect = readonly [number, number, number, number];

/** Logical inset/outset per side, in logical pixels. */
export interface RainlitEdges {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/**
 * One composited atlas layer on the anchored logical canvas.
 *
 * Layers are listed in compositing order (later draws over earlier).
 * Stationary foreground collars are placed AFTER the moving layer they
 * occlude. Static layers declare no angle/reveal/emission channel. Parent
 * chains are topologically sorted (a parent always precedes its children)
 * and finite. `deform: "cloth"` marks an authored cloth layer whose hem may
 * sway with the shared wind scalar while the head/root stays fixed.
 */
export interface FrameLayer {
  readonly id: string;
  /** Atlas cell in source pixels. */
  readonly cell: Rect;
  /** Root anchor point this layer hangs from. */
  readonly anchor: "tl" | "tr" | "bl" | "br";
  /** Signed top-left translation from the anchor point, logical px. */
  readonly offset: readonly [number, number];
  /** Drawn size in logical px. */
  readonly size: readonly [number, number];
  /** Rotation pivot, local logical px from the layer top-left. */
  readonly pivot: readonly [number, number];
  /** Optional parent layer id; chains are topologically sorted and finite. */
  readonly parent?: string;
  /** Angle channel name (radians) resolved through `FrameMotion.angles`. */
  readonly angle?: string;
  /** Reveal channel name (0..1) via `FrameMotion.reveals`. */
  readonly reveal?: string;
  /**
   * How the `reveal` channel is applied. `"clip"` (the default when absent)
   * keeps the frozen top-anchored wipe. `"slide"` translates the whole layer
   * DOWN from one full layer-height above its anchor (reveal 0, hidden behind
   * a later stationary layer) to its authored anchor (reveal 1), so real
   * material emerges with a moving leading edge instead of an alpha wipe.
   * Only the `clip`/`slide` modes are supported.
   */
  readonly revealMode?: "clip" | "slide";
  /**
   * Optional named translation channel resolved through
   * `FrameMotion.translations`: a signed LOGICAL ROOT pixel displacement
   * (+y down) added to the layer AFTER the ornament scale, so the layer
   * moves by the real on-screen distance the pack authored and is NEVER
   * multiplied again by `ornamentScale`. Resolved once per window like every
   * other channel; absent on packs without a translating layer group.
   */
  readonly translateY?: string;
  /** Light-gain channel name (neutral ≈ 1) via `FrameMotion.emissions`. */
  readonly emission?: string;
  /** Authored cloth layer: hem-only wind deformation, head/root fixed. */
  readonly deform?: "cloth";
}

/**
 * Shared per-window motion inputs. Every member is a native animation
 * track signal (or a constant policy signal); nothing here allocates per
 * frame. The same instance feeds the frame effect and the Kitty interior.
 */
export interface MotionInput {
  /**
   * Pack period clock in seconds, driven by the native loop clock over
   * `0..periodSeconds`. The native clock resets at the seam, so EVERY
   * time-dependent authored scalar MUST be an integer harmonic of this period
   * (arbitrary constant phase lags are allowed): a non-integer frequency makes
   * the loop jump when the clock wraps.
   */
  readonly seconds: ReadonlySignal<number>;
  /**
   * Current logical root width in logical px (the window root frame, insets
   * included). The same reactive root geometry the renderer lays the frame
   * out from, so a pack may author size-relative motion (a girl walking to a
   * real floor, a button at a root-relative anchor) without a second
   * measurement or any per-frame recomputation.
   */
  readonly rootWidth: ReadonlySignal<number>;
  /** Current logical root height in logical px; see `rootWidth`. */
  readonly rootHeight: ReadonlySignal<number>;
  /** Smooth native focus track, 0..1 (300 ms native transition). */
  readonly focus: ReadonlySignal<number>;
  /** Smooth native hover strengths (200 ms transitions) per action. */
  readonly hoverMin: ReadonlySignal<number>;
  readonly hoverMax: ReadonlySignal<number>;
  readonly hoverClose: ReadonlySignal<number>;
  /** Immediate press pulses per action (1 at press, quick native decay). */
  readonly pressMin: ReadonlySignal<number>;
  readonly pressMax: ReadonlySignal<number>;
  readonly pressClose: ReadonlySignal<number>;
  /** Reduced-motion policy for the current selection. */
  readonly reduced: ReadonlySignal<boolean>;
}

/**
 * Per-skin authored motion state. All fields are `MaybeSignal` scalars so
 * the renderer binds them once; derived proxies are created once per window
 * runtime, never per tick. Under reduced motion skins output rest angles /
 * rest reveal and calm light while focus and eyes remain useful.
 */
export interface FrameMotion {
  /** Rotation channels in radians, keyed by layer `angle` names. */
  readonly angles: Record<string, MaybeSignal<number>>;
  /** Reveal channels 0..1, applied with each layer's revealMode. */
  readonly reveals: Record<string, MaybeSignal<number>>;
  /**
   * Optional named LOGICAL ROOT pixel translation channels (+y down),
   * resolved through `FrameLayer.translateY`. Used by the frame-02 scene,
   * where the whole bamboo assembly creeps down, drops to the real floor and
   * rises again. Absent on packs whose layers never translate.
   */
  readonly translations?: Record<string, MaybeSignal<number>>;
  /**
   * Optional daughter-scene channels for packs that animate one (the 120s
   * bamboo girl on 02). Absent on every other pack, which stay untouched.
   */
  readonly scene?: BambooSceneMotion;
  /** Light-gain channels (neutral ≈ 1), keyed by layer names. */
  readonly emissions: Record<string, MaybeSignal<number>>;
  /**
   * Shared SIGNED wind scalar in [-1, 1] for sway / cloth hem deformation;
   * every skin MUST return exactly 0 under reduced motion. It only ever tilts
   * or deforms static geometry: it is NEVER multiplied into a position that
   * advances with time (no wind-modulated scroll speed), so the implied motion
   * stays bounded and seam-continuous.
   */
  readonly wind: MaybeSignal<number>;
  /** Shared local light scalar for the interior shader (≈ 0..1). */
  readonly light: MaybeSignal<number>;
  /** Shared interior shade scalar (≈ 0..1). */
  readonly shade: MaybeSignal<number>;
  /** Doll eye strengths in min/max/close order (opacity 0..1). */
  readonly eyes: readonly [
    MaybeSignal<number>,
    MaybeSignal<number>,
    MaybeSignal<number>,
  ];
}

/**
 * Per-window native channels of the optional daughter scene: rainlit 02's
 * 120s bamboo-girl story. Every field is a `MaybeSignal` scalar resolved once
 * per window (never per tick) and shares the ONE existing native
 * `TRACK_SECONDS` clock with the frame.
 *
 * Semantics (frozen): `girlX` is the LOGICAL ROOT x of the girl atlas cell's
 * top-left; the renderer converts it to the client local frame by subtracting
 * the root left inset exactly once. `girlFacing` is `1` for the original
 * authored sheet (facing LEFT) and `-1` for a uniform whole-sprite horizontal
 * mirror (facing RIGHT). `bambooOffsetY` is a signed logical root downward
 * (+y) displacement of the roll/slat only; upper bindings stay fixed.
 * `bambooReveal` and `bambooAngle` independently describe exposure and tilt.
 * Under reduced motion every channel is at its rest value (bamboo home, girl
 * hidden, all impact and button channels zero).
 */
export interface BambooSceneMotion {
  /** Logical ROOT x of the girl cell's top-left (client-converted once). */
  readonly girlX: MaybeSignal<number>;
  /** Atlas cell index 0..15 (0..7 walking row-major, 8..15 action). */
  readonly girlFrame: MaybeSignal<number>;
  /** 1 = authored sheet facing LEFT, -1 = whole-sprite mirror facing RIGHT. */
  readonly girlFacing: MaybeSignal<number>;
  /** Girl opacity 0..1; rests at 0 (hidden). */
  readonly girlOpacity: MaybeSignal<number>;
  /** Signed logical root displacement of the bamboo group (+y down). */
  readonly bambooOffsetY: MaybeSignal<number>;
  /** Bamboo exposure 0..1 (0 = rolled home, 1 = fully exposed). */
  readonly bambooReveal: MaybeSignal<number>;
  /** Rigid roll/slat tilt in radians around their common world pivot. */
  readonly bambooAngle: MaybeSignal<number>;
  /** Button contact 0..1 with distinct press and release edges. */
  readonly buttonPress: MaybeSignal<number>;
  /** Local floor-impact intensity 0..1; zero at the quiet boundaries. */
  readonly floorImpact: MaybeSignal<number>;
  /** Local ceiling-impact intensity 0..1; zero at the quiet boundaries. */
  readonly ceilingImpact: MaybeSignal<number>;
}

/**
 * Authoring metadata for the optional daughter-scene atlas, re-exported by
 * the pack from the asset module so the renderer samples the exact same cell
 * layout, finger contact and foot baseline the motion was computed against.
 * Shapes match the `SCENE_02_*` exports in `scene-02-assets.ts`.
 */
export interface BambooSceneArtwork {
  /** Scene atlas path relative to the config package root. */
  readonly atlas: string;
  /** Atlas dimensions in source pixels. */
  readonly atlasSize: readonly [number, number];
  /** One cell size in source pixels (4x4 grid). */
  readonly cellSize: readonly [number, number];
  /** Measured pressed index-finger point inside the press cell, source px. */
  readonly pressContact: readonly [number, number];
  /** Foot baseline measured from a cell top in source px. */
  readonly baseline: number;
  /** Authored source character height in source px. */
  readonly sourceHeight: number;
}

/** Native doll control row: three dolls, glyphs, live eyes. */
export interface RainlitPackControls {
  /** Minimize doll image path (config-root relative). */
  readonly min: string;
  /** Maximize/restore doll image path (config-root relative). */
  readonly max: string;
  /** Close doll image path (config-root relative). */
  readonly close: string;
  /** Eye overlay image for the min doll (drawn at `eyes[0]`). */
  readonly eyesMin: string;
  /** Eye overlay image for the max doll (drawn at `eyes[1]`). */
  readonly eyesMax: string;
  /** Eye overlay image for the close doll (drawn at `eyes[2]`). */
  readonly eyesClose: string;
  /** Full doll canvas size in logical px (all doll images share it). */
  readonly doll: readonly [number, number];
  /**
   * Eye overlay top-left positions in the shared canvas, in min/max/close
   * order; each entry aligns one eye image with its doll body.
   */
  readonly eyes: readonly [
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
  ];
}

/**
 * A complete declared frame pack supplied by one artwork owner module
 * (`frame-02.ts` … `frame-09.ts`). Pack modules are imported pure: no asset
 * loading, effect compilation or selection side effects at module load.
 */
export interface FramePack {
  readonly id: RainlitFrameId;
  readonly title: string;
  /* Pack authoring version: bumped when the authored geometry/art changes. */
  readonly version: 1 | 2;
  /** Atlas image path relative to the config package root. */
  readonly atlas: string;
  /** Atlas dimensions in source pixels. */
  readonly atlasSize: readonly [number, number];
  /** Logical insets reserving the frame ring around the client opening. */
  readonly insets: RainlitEdges;
  /** Logical outsets covering complete ornament swings outside the root. */
  readonly outsets: RainlitEdges;
  /** One-shot corner cells in source pixels. */
  readonly corners: {
    readonly tl: Rect;
    readonly tr: Rect;
    readonly bl: Rect;
    readonly br: Rect;
  };
  /** Corner cap sizes in logical px; top and bottom may differ (07). */
  readonly cornerSize: {
    readonly top: readonly [number, number];
    readonly bottom: readonly [number, number];
  };
  /** Repeatable neutral rail cells in source pixels. */
  readonly rails: {
    readonly top: Rect;
    readonly bottom: Rect;
    readonly left: Rect;
    readonly right: Rect;
  };
  /** Logical repeat periods for the rails (default convention 256 / 128). */
  readonly railPeriod: { readonly horizontal: number; readonly vertical: number };
  /** Ornament layers, compositing order, parent chains topologically sorted. */
  readonly layers: FrameLayer[];
  /** Native clock loop period in seconds feeding `MotionInput.seconds`. */
  readonly periodSeconds: number;
  /** Minimum root size in logical px below which support is declared, not faked. */
  readonly minimumRoot: readonly [number, number];
  /** Interior (Kitty backdrop) profile parameters. */
  readonly interior: {
    /** Rain streak intensity 0..1. */
    readonly rainStrength: number;
    /** Cool tint strength 0..1. */
    readonly coolness: number;
    /**
     * Lamp anchor in normalized client coordinates [0..1]². Optional: a pack
     * may author `lightPlacement` instead, or no lamp at all. When either this
     * or `lightSpread` is present, BOTH must be present and finite.
     */
    readonly lightAnchor?: readonly [number, number];
    /**
     * Lamp spread (normalized client units) as [radiusX, radiusY]. Optional as
     * above (paired with `lightAnchor`).
     */
    readonly lightSpread?: readonly [number, number];
    /**
     * Preferred lamp placement in LOGICAL ROOT coordinates: a root corner
     * (`anchor`) plus a signed top-left translation (`offset`) to the lamp
     * centre, and a radius pair (`spread`). The runtime converts the centre to
     * client-local normalized coordinates (subtracting the root L/T insets)
     * and scales `offset`/`spread` by the ornament scale `s`, so the interior
     * footprint tracks the real exterior object on every size. When present it
     * replaces `lightAnchor`/`lightSpread`; those remain for packs authored in
     * normalized client coordinates. Authored as ZERO light scalar (07/09)
     * means no lamp at all, and this field is then ignored.
     */
    readonly lightPlacement?: {
      readonly anchor: "tl" | "tr" | "bl" | "br";
      /** Signed top-left translation from the root anchor to the centre. */
      readonly offset: readonly [number, number];
      /** Lamp radius pair in logical px (scaled by ornament `s`). */
      readonly spread: readonly [number, number];
    };
    /** Lamp light color, linear 0..1 RGB. */
    readonly lightColor: readonly [number, number, number];
    /** Client-edge shade strength 0..1. */
    readonly edgeShade: number;
  };
  /** Present on 07: native doll controls and live eye overlays. */
  readonly controls?: RainlitPackControls;
  /** Present on 02: the 120s bamboo-girl daughter-scene atlas and anchors. */
  readonly scene?: BambooSceneArtwork;
  /** Per-skin authored motion over the shared native tracks. */
  readonly createMotion: (input: MotionInput) => FrameMotion;
}
