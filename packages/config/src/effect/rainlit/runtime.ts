/**
 * Core Rainlit runtime: selection policy, per-window native motion tracks,
 * the generic frame effect and the Kitty interior (backdrop) effect.
 *
 * Owns only this module, `types.ts`, `frame.frag`, `interior.frag` and
 * `scene.frag` in this directory. Pack modules (FRAME_02/06/07/09) are imported pure and are
 * owned by the artwork workers; `index.tsx` integration is owned elsewhere.
 *
 * Ownership and lifecycle invariants (frozen):
 * - Selection defaults to `{ id: "02", reducedMotion: false }`; the legacy
 *   frame remains only as an explicit `null` selection. Nothing here applies
 *   or reloads anything on its own beyond that declared startup default.
 * - One BOUNDED runtime cache per window (WeakMap): at most one lazily built
 *   runtime per pack id (four) plus a per-window reduced-policy signal. The
 *   cached motion/graph proxies NEVER subscribe to any module-global
 *   selection or reduced signal — the accessor copies the policy value into
 *   the per-window signal. That keeps every window graph free of global roots
 *   so it can be collected with its window, and lets hide / fullscreen /
 *   minimize / null / reduced transitions stop the tracks WITHOUT deleting or
 *   rebuilding any graph.
 * - All derived scalar proxies (motion, layer forward kinematics, geometry)
 *   are created once per runtime inside `withoutCompositionOwnership`, so
 *   the composition-scope auto-dispose of `computed()` can never freeze or
 *   leak them. No per-tick object allocation, string cache key, image loading,
 *   shader compilation or IPC anywhere on the hot path.
 * - Frame geometry proxies are owned HERE, derived from the window's
 *   managed rect state (`WINDOW_STATE_RECT` from ../../window-manager), not
 *   from caller-supplied mapped proxies that a composition pass may dispose.
 * - Native tracks are module-scope `animationVariable` tokens; each window's
 *   `window.animation` controller keeps per-window values. The pack period
 *   clock is a native loop over the normalized 0..1 phase; a stop preserves
 *   the phase and a later resume plays the REMAINING segment to 1 and then
 *   restores the explicit full-range 0..1 loop (never a fixed truncated
 *   loop). The cached clock mode records this so repeated sync calls do not
 *   reset it.
 * - `sync()` starts motion only for visible, non-fullscreen targets; hidden,
 *   fullscreen and reduced states stop the owned tracks. Reduced policy
 *   stops the endless clock, snaps rest motion and makes focus/hover
 *   transitions immediate, and clears any press pulse.
 * - The Kitty interior glass is compiled only when the window's app-id is
 *   kitty at creation time AND the pack is not 02; it is a backdrop-source
 *   effect and never reads client glyphs or palette. It binds the ACTUAL
 *   client opening size (root minus insets) and samples `effect_content_uv`,
 *   which is exactly its own rect, so the root insets are never subtracted a
 *   second time. Pack 02's interior backdrop is the integrator-composed legacy
 *   ambient handle, so its unused interior graph is never compiled.
 * - Selection is runtime configuration only: `rainlitStatus()` always reports
 *   `runtimeVerified: false`.
 */
import {
  animationVariable,
  backdropSource,
  compileEffect,
  compileWindowEffect,
  computed,
  dualKawaseBlur,
  imageSource,
  loadShader,
  read,
  shaderStage,
  signal,
  uniformArray,
  windowSource,
  withoutCompositionOwnership,
  type AnimationVariable,
  type CompiledEffectHandle,
  type MaybeSignal,
  type ReadonlySignal,
  type ShaderUniformScalar,
  type ShaderUniformMap,
  type Signal,
  type WaylandWindow,
  type WindowEffectAssignment,
} from "shoji_wm";
import {
  WINDOW_STATE_FULLSCREEN,
  WINDOW_STATE_MINIMIZED,
  WINDOW_STATE_MINIMIZE_VISUAL_IDLE,
  WINDOW_STATE_RECT,
  WINDOW_STATE_WORKSPACE_VISIBLE,
} from "../../window-manager";
import { FRAME_02 } from "./frame-02";
import { FRAME_02_BAMBOO_ANCHORS, FRAME_02_BUTTON_SPAN } from "./frame-02-geometry";
import { FRAME_06 } from "./frame-06";
import { FRAME_07 } from "./frame-07";
import { FRAME_09 } from "./frame-09";
import type {
  FrameLayer,
  FrameMotion,
  FramePack,
  MotionInput,
  RainlitEdges,
  RainlitFrameId,
} from "./types";

export type {
  FrameLayer,
  FrameMotion,
  FramePack,
  MotionInput,
  RainlitEdges,
  RainlitFrameId,
} from "./types";

/**
 * Uniform-array bound. The four approved packs never exceed this (the widest,
 * 02, authors ten layers); packs above it fail validation loudly instead of
 * silently dropping layers.
 */
export const MAX_RAINLIT_LAYERS = 16;

/**
 * Shared pure header padding for the unified-frame header row, in logical px.
 * Used both by the native header composition (`index.tsx`) and by the
 * interior eye-reflection geometry here, so the reflections read the same
 * per-role button centres the native row lays out.
 */
export function headerPadding(rootW: number): number {
  return rootW < 190 ? 6 : rootW < 230 ? 12 : 18;
}

/** Current selection policy. Null keeps the legacy frame pipeline. */
export interface RainlitSelection {
  readonly id: RainlitFrameId | null;
  readonly reducedMotion: boolean;
}

export interface RainlitWindowRuntime {
  readonly pack: FramePack;
  readonly motion: FrameMotion;
  readonly assignment: WindowEffectAssignment;
  /**
   * Kitty interior backdrop effect; null for non-kitty app identities and for
   * pack 02, whose interior backdrop is the legacy ambient handle composed by
   * the integrator.
   */
  readonly glass: CompiledEffectHandle | null;
  /** Native hover track setter per action (smooth 200 ms, immediate when reduced). */
  setHoveredAction(action: "min" | "max" | "close", hovered: boolean): void;
  /** Immediate press pulse per action (set to 1, quick native decay; 0 when reduced). */
  pulseAction(action: "min" | "max" | "close"): void;
  /**
   * Lifecycle sync from the integrator: starts/stops owned native tracks for
   * visible non-fullscreen targets without resets on repeated calls, and
   * resumes a stopped remaining segment before restoring the full loop.
   * `terminal` is informational (interior relevance); frame motion is
   * app-independent per plan.
   */
  sync(visible: boolean, focused: boolean, terminal: boolean): void;
  /** Stops all owned tracks, preserving phase for a later resume. */
  stop(): void;
  /**
   * Activation-local reset: stops and zeroes EVERY owned track and clears
   * the cached retarget targets (focus/hover) plus the cached clock mode.
   * Used only on an actual pack activation so no phase or stale hover/focus
   * state leaks across packs; never called for same-id, reduced or hide
   * transitions.
   */
  resetForActivation(): void;
}

export interface RainlitCatalogEntry {
  readonly id: RainlitFrameId;
  readonly title: string;
  readonly version: FramePack["version"];
  readonly atlasSize: readonly [number, number];
  readonly insets: RainlitEdges;
  readonly outsets: RainlitEdges;
  readonly minimumRoot: readonly [number, number];
  readonly layerCount: number;
  readonly periodSeconds: number;
}

export interface RainlitStatus {
  readonly selectedId: RainlitFrameId | null;
  readonly reducedMotion: boolean;
  readonly catalog: RainlitCatalogEntry[];
  /** Selection is configuration, never proof of applied resources. */
  readonly runtimeVerified: false;
}

const PACKS: Record<RainlitFrameId, FramePack> = {
  "02": FRAME_02,
  "06": FRAME_06,
  "07": FRAME_07,
  "09": FRAME_09,
};

const FRAME_IDS: readonly RainlitFrameId[] = ["02", "06", "07", "09"];

/**
 * Startup selection: pack 02 is the declared default. `null` remains the
 * explicit legacy alternative (never auto-selected);
 * `setRainlitSelection` is the only other way it changes.
 */
export const rainlitSelection = signal<RainlitSelection>({
  id: "02",
  reducedMotion: false,
});

// Module-scope native animation tokens; per-window values live in each
// window's own animation controller store.
const TRACK_SECONDS = animationVariable("rainlit-seconds");
const TRACK_FOCUS = animationVariable("rainlit-focus");
const TRACK_HOVER: Record<"min" | "max" | "close", AnimationVariable> = {
  min: animationVariable("rainlit-hover-min"),
  max: animationVariable("rainlit-hover-max"),
  close: animationVariable("rainlit-hover-close"),
};
const TRACK_PRESS: Record<"min" | "max" | "close", AnimationVariable> = {
  min: animationVariable("rainlit-press-min"),
  max: animationVariable("rainlit-press-max"),
  close: animationVariable("rainlit-press-close"),
};
const OWNED_TRACKS: readonly AnimationVariable[] = [
  TRACK_SECONDS,
  TRACK_FOCUS,
  TRACK_HOVER.min,
  TRACK_HOVER.max,
  TRACK_HOVER.close,
  TRACK_PRESS.min,
  TRACK_PRESS.max,
  TRACK_PRESS.close,
];
const ACTIONS = ["min", "max", "close"] as const;
type RainlitAction = (typeof ACTIONS)[number];

function fail(pack: FramePack, message: string): never {
  throw new Error(`rainlit pack ${pack.id}: ${message}`);
}

/** Fails known-invalid packs loudly instead of silently dropping features. */
function validatePack(pack: FramePack): void {
  const [aw, ah] = pack.atlasSize;
  if (!(aw > 0 && ah > 0)) fail(pack, "atlasSize must be positive");
  const finite = (v: readonly number[]): boolean =>
    v.every((n) => Number.isFinite(n));
  const inAtlas = (cell: readonly number[], what: string) => {
    if (cell.length !== 4) fail(pack, `${what}: cell must be [x,y,w,h]`);
    const [x, y, w, h] = cell;
    if (!(w > 0 && h > 0)) fail(pack, `${what}: empty cell`);
    if (x < 0 || y < 0 || x + w > aw || y + h > ah) {
      fail(pack, `${what}: cell [${cell}] outside atlas ${aw}x${ah}`);
    }
  };
  for (const key of ["left", "right", "top", "bottom"] as const) {
    const inset = pack.insets[key];
    if (!(Number.isFinite(inset) && inset >= 0)) {
      fail(pack, `insets.${key} must be finite >= 0`);
    }
    if (!Number.isFinite(pack.outsets[key]) || pack.outsets[key] < 0) {
      fail(pack, `outsets.${key} must be finite >= 0`);
    }
  }
  for (const key of ["tl", "tr", "bl", "br"] as const) {
    inAtlas(pack.corners[key], `corners.${key}`);
  }
  const [ctw, cth] = pack.cornerSize.top;
  const [cbw, cbh] = pack.cornerSize.bottom;
  if (![ctw, cth, cbw, cbh].every((v) => Number.isFinite(v) && v > 0)) {
    fail(pack, "cornerSize entries must be finite > 0");
  }
  for (const key of ["top", "bottom", "left", "right"] as const) {
    inAtlas(pack.rails[key], `rails.${key}`);
  }
  if (!(pack.railPeriod.horizontal > 0 && pack.railPeriod.vertical > 0)) {
    fail(pack, "railPeriod entries must be > 0");
  }
  if (pack.layers.length > MAX_RAINLIT_LAYERS) {
    fail(pack, `${pack.layers.length} layers exceeds MAX_RAINLIT_LAYERS ${MAX_RAINLIT_LAYERS}`);
  }
  const indexById = new Map<string, number>();
  pack.layers.forEach((layer, i) => {
    if (indexById.has(layer.id)) fail(pack, `duplicate layer id "${layer.id}"`);
    indexById.set(layer.id, i);
    inAtlas(layer.cell, `layer ${layer.id}`);
    if (!finite(layer.offset)) fail(pack, `layer ${layer.id}: offset not finite`);
    if (!layer.size.every((n) => Number.isFinite(n) && n > 0)) {
      fail(pack, `layer ${layer.id}: size must be finite > 0`);
    }
    if (!finite(layer.pivot)) fail(pack, `layer ${layer.id}: pivot not finite`);
    if (
      layer.revealMode !== undefined &&
      layer.revealMode !== "clip" &&
      layer.revealMode !== "slide"
    ) {
      fail(
        pack,
        `layer ${layer.id}: unsupported revealMode ${JSON.stringify(layer.revealMode)}`,
      );
    }
    if (layer.parent !== undefined) {
      const p = indexById.get(layer.parent);
      if (p === undefined) fail(pack, `layer ${layer.id}: unknown parent "${layer.parent}"`);
      if (p >= i) {
        fail(pack, `layer ${layer.id}: parent chain not topologically sorted`);
      }
    }
  });
  if (!(Number.isFinite(pack.periodSeconds) && pack.periodSeconds > 0)) {
    fail(pack, "periodSeconds must be finite > 0");
  }
  if (!pack.minimumRoot.every((n) => Number.isFinite(n) && n > 0)) {
    fail(pack, "minimumRoot must be finite > 0");
  }
  const interior = pack.interior;
  if (
    !Number.isFinite(interior.rainStrength) ||
    !Number.isFinite(interior.coolness) ||
    !Number.isFinite(interior.edgeShade) ||
    !finite(interior.lightColor)
  ) {
    fail(pack, "interior profile contains non-finite values");
  }
  // A pack may author a `lightPlacement`, the normalized pair, or no lamp at
  // all; validate only what is present, but keep the normalized pair all-or-
  // nothing.
  if ((interior.lightAnchor === undefined) !== (interior.lightSpread === undefined)) {
    fail(pack, "interior lightAnchor/lightSpread must be authored together");
  }
  if (interior.lightAnchor !== undefined && !finite(interior.lightAnchor)) {
    fail(pack, "interior.lightAnchor must be finite");
  }
  if (interior.lightSpread !== undefined && !finite(interior.lightSpread)) {
    fail(pack, "interior.lightSpread must be finite");
  }
  const placement = interior.lightPlacement;
  if (placement) {
    if (!finite(placement.offset) || !finite(placement.spread)) {
      fail(pack, "interior.lightPlacement offset/spread must be finite");
    }
    if (
      placement.anchor !== "tl" &&
      placement.anchor !== "tr" &&
      placement.anchor !== "bl" &&
      placement.anchor !== "br"
    ) {
      fail(pack, "interior.lightPlacement anchor must be tl/tr/bl/br");
    }
  }
}

/**
 * Channel resolution: a layer channel name must exist in the authored
 * motion state; a missing channel is an invalid pack (no silent statics).
 * Returns neutral scalars when the layer declares no channel.
 */
function channelSignal(
  pack: FramePack,
  motion: FrameMotion,
  layer: FrameLayer,
  kind: "angle" | "reveal" | "emission",
): ShaderUniformScalar {
  const name = layer[kind];
  if (name === undefined) {
    return kind === "reveal" || kind === "emission" ? 1 : 0;
  }
  const table =
    kind === "angle" ? motion.angles : kind === "reveal" ? motion.reveals : motion.emissions;
  const value = table[name];
  if (value === undefined) {
    fail(pack, `layer ${layer.id}: ${kind} channel "${name}" missing from authored motion`);
  }
  return computed(() => read(value));
}

interface RuntimeCacheEntry {
  /** At most one lazily built runtime per pack id (bounded: four). */
  readonly packs: Partial<Record<RainlitFrameId, RainlitWindowRuntime>>;
  /**
   * Per-window reduced policy. This is the ONLY reduced signal cached graphs
   * see, so they carry no dependency on the module-global selection and can be
   * collected with their window. The accessor copies the live policy into it;
   * changing the value informs the graphs without rebuilding them.
   */
  readonly reduced: Signal<boolean>;
  /** Currently activated pack id (phase owned by the shared native tokens). */
  activeId: RainlitFrameId | null;
}

const runtimes = new WeakMap<WaylandWindow, RuntimeCacheEntry>();

/**
 * Inspection-only registry of the CURRENT renderer-owned facade per live
 * window id. The manager dedups windows by id WITHOUT replacing its stored
 * object, so object identity between the manager's facade and the facade the
 * latest native effect factory built cannot be assumed. This Map holds at most
 * ONE facade per live id, refreshed by `rainlitFor` from the actual facade
 * whose runtime was just returned. `rainlitSceneInspect` resolves through it
 * and reads the EXISTING WeakMap entry for that facade (never building a
 * runtime, never seeking the clock).
 */
const inspectionWindows = new Map<string, WaylandWindow>();

/** Drops the inspection registry entry for a closed window id (bounded). */
export function rainlitForgetInspection(windowId: string): void {
  inspectionWindows.delete(windowId);
}

function buildRuntime(
  window: WaylandWindow,
  pack: FramePack,
  reducedLocal: ReadonlySignal<boolean>,
): RainlitWindowRuntime {
  const ctrl = window.animation;

  // Persistent frame geometry proxies owned here, from the managed rect
  // state (not caller-mapped proxies that composition may dispose).
  const width = computed(
    () => read(window.state[WINDOW_STATE_RECT]().width),
  );
  const height = computed(
    () => read(window.state[WINDOW_STATE_RECT]().height),
  );

  const insets = pack.insets;
  const [minW, minH] = pack.minimumRoot;

  // Uniform ornament scale: roots below the declared minimum shrink every
  // ornament layer uniformly (sizes, pivots, offsets and chain attachments).
  // 1 on any supported size; rails, corner caps and native buttons never
  // shrink.
  const ornamentScale = computed(() => {
    const w = read(width);
    const h = read(height);
    return Math.min(1, w / minW, h / minH);
  });

  // The actual client opening: root minus the frame insets on each side. The
  // interior shader binds these dimensions and evaluates its own full rect.
  const clientW = computed(() =>
    Math.max(1, read(width) - insets.left - insets.right),
  );
  const clientH = computed(() =>
    Math.max(1, read(height) - insets.top - insets.bottom),
  );

  // Shared native motion tracks. The pack period clock is a native loop over
  // the normalized 0..1 phase; `sync` resumes the remaining segment and then
  // restores the full loop.
  const secondsSignal: ReadonlySignal<number> = computed(
    () => ctrl.variable(TRACK_SECONDS)() * pack.periodSeconds,
  );
  const focusSignal: ReadonlySignal<number> = ctrl.variable(TRACK_FOCUS);
  const input: MotionInput = {
    seconds: secondsSignal,
    focus: focusSignal,
    rootWidth: width,
    rootHeight: height,
    hoverMin: ctrl.variable(TRACK_HOVER.min),
    hoverMax: ctrl.variable(TRACK_HOVER.max),
    hoverClose: ctrl.variable(TRACK_HOVER.close),
    pressMin: ctrl.variable(TRACK_PRESS.min),
    pressMax: ctrl.variable(TRACK_PRESS.max),
    pressClose: ctrl.variable(TRACK_PRESS.close),
    reduced: reducedLocal,
  };

  const motion = pack.createMotion(input);

  // Layer forward kinematics with pivot-inclusive attachment: for a child,
  //   childTopLeft = parentWorldPivot
  //                + R(parentTotal) * (offset + childPivot - parentPivot)
  //                - childPivot
  // (all ornament geometry scaled by `ornamentScale`). This maps the child's
  // own pivot about the parent's pivot, so a rotating parent keeps chains
  // attached instead of displacing them by (I - R) * childPivot.
  const posX: Array<MaybeSignal<number>> = [];
  const posY: Array<MaybeSignal<number>> = [];
  const totalAngle: Array<ShaderUniformScalar> = [];
  const reveal: Array<ShaderUniformScalar> = [];
  const revealMode: number[] = [];
  const emission: Array<ShaderUniformScalar> = [];
  const deform: number[] = [];
  pack.layers.forEach((layer) => {
    const anchorX = layer.anchor === "tr" || layer.anchor === "br";
    const anchorY = layer.anchor === "bl" || layer.anchor === "br";
    const [offX, offY] = layer.offset;
    const baseX: MaybeSignal<number> = anchorX
      ? computed(() => read(width) + offX * ornamentScale())
      : computed(() => offX * ornamentScale());
    const baseY: MaybeSignal<number> = anchorY
      ? computed(() => read(height) + offY * ornamentScale())
      : computed(() => offY * ornamentScale());
    const ownAngle = channelSignal(pack, motion, layer, "angle");
    // Optional named translation channel: a LOGICAL ROOT displacement applied
    // to the layer's world top-left BEFORE forward kinematics. The value is
    // added verbatim (the scene author already expressed it in scaled logical
    // px), never multiplied by ornamentScale again. Children inherit the
    // parent translation through the parent's world pivot automatically.
    const tyName = layer.translateY;
    let ownTY: MaybeSignal<number> | undefined;
    if (tyName !== undefined) {
      const value = motion.translations?.[tyName];
      if (value === undefined) {
        fail(
          pack,
          `layer ${layer.id}: translation channel "${tyName}" missing from authored motion`,
        );
      }
      ownTY = computed(() => read(value));
    }
    const parentIndex =
      layer.parent === undefined
        ? undefined
        : pack.layers.findIndex((candidate) => candidate.id === layer.parent);
    if (parentIndex === undefined) {
      posX.push(baseX);
      posY.push(
        ownTY === undefined
          ? baseY
          : computed(() => read(baseY) + read(ownTY)),
      );
      totalAngle.push(ownAngle);
    } else {
      const [pivX, pivY] = pack.layers[parentIndex].pivot;
      const [cPivX, cPivY] = layer.pivot;
      const px = posX[parentIndex];
      const py = posY[parentIndex];
      const tp = totalAngle[parentIndex];
      posX.push(
        computed(() => {
          const s = ornamentScale();
          const a = read(tp);
          const ca = Math.cos(a);
          const sa = Math.sin(a);
          const dx = (offX + cPivX - pivX) * s;
          const dy = (offY + cPivY - pivY) * s;
          const parentWorldPivotX = read(px) + pivX * s;
          return parentWorldPivotX + (ca * dx - sa * dy) - cPivX * s;
        }),
      );
      posY.push(
        ownTY === undefined
          ? computed(() => {
              const s = ornamentScale();
              const a = read(tp);
              const ca = Math.cos(a);
              const sa = Math.sin(a);
              const dx = (offX + cPivX - pivX) * s;
              const dy = (offY + cPivY - pivY) * s;
              const parentWorldPivotY = read(py) + pivY * s;
              return parentWorldPivotY + (sa * dx + ca * dy) - cPivY * s;
            })
          : computed(() => {
              const s = ornamentScale();
              const a = read(tp);
              const ca = Math.cos(a);
              const sa = Math.sin(a);
              const dx = (offX + cPivX - pivX) * s;
              const dy = (offY + cPivY - pivY) * s;
              const parentWorldPivotY = read(py) + pivY * s;
              return parentWorldPivotY + (sa * dx + ca * dy) - cPivY * s + read(ownTY);
            }),
      );
      totalAngle.push(
        typeof tp === "number" && typeof ownAngle === "number"
          ? tp + ownAngle
          : computed(() => read(tp) + read(ownAngle)),
      );
    }
    reveal.push(channelSignal(pack, motion, layer, "reveal"));
    revealMode.push(layer.revealMode === "slide" ? 1 : 0);
    emission.push(channelSignal(pack, motion, layer, "emission"));
    deform.push(layer.deform === "cloth" ? 1 : 0);
  });

  const pad = (values: ShaderUniformScalar[]): ShaderUniformScalar[] => {
    const padded = values.slice(0, MAX_RAINLIT_LAYERS);
    while (padded.length < MAX_RAINLIT_LAYERS) padded.push(0);
    return padded;
  };
  const padVec2 = (
    values: ReadonlyArray<readonly [MaybeSignal<number>, MaybeSignal<number>]>,
  ): Array<readonly [ShaderUniformScalar, ShaderUniformScalar]> => {
    const padded = values.slice(0, MAX_RAINLIT_LAYERS).map(
      (entry) => entry as readonly [ShaderUniformScalar, ShaderUniformScalar],
    );
    const zero: readonly [ShaderUniformScalar, ShaderUniformScalar] = [0, 0];
    while (padded.length < MAX_RAINLIT_LAYERS) padded.push(zero);
    return padded;
  };
  const padVec4 = (
    values: ReadonlyArray<readonly [number, number, number, number]>,
  ): Array<
    readonly [ShaderUniformScalar, ShaderUniformScalar, ShaderUniformScalar, ShaderUniformScalar]
  > => {
    const padded = values.slice(0, MAX_RAINLIT_LAYERS) as Array<
      readonly [ShaderUniformScalar, ShaderUniformScalar, ShaderUniformScalar, ShaderUniformScalar]
    >;
    const zero: readonly [
      ShaderUniformScalar,
      ShaderUniformScalar,
      ShaderUniformScalar,
      ShaderUniformScalar,
    ] = [0, 0, 0, 0];
    while (padded.length < MAX_RAINLIT_LAYERS) padded.push(zero);
    return padded;
  };

  const rlSize = pack.layers.map((layer) => [
    computed(() => layer.size[0] * ornamentScale()),
    computed(() => layer.size[1] * ornamentScale()),
  ] as const);
  const rlPivot = pack.layers.map((layer) => [
    computed(() => layer.pivot[0] * ornamentScale()),
    computed(() => layer.pivot[1] * ornamentScale()),
  ] as const);

  const insetsVec: readonly [ShaderUniformScalar, ShaderUniformScalar, ShaderUniformScalar, ShaderUniformScalar] =
    [insets.left, insets.top, insets.right, insets.bottom];

  // The frame effect is compiled AFTER the optional scene uniforms below, so
  // a pack-02 scene stage can be appended to its pipeline (after the generic
  // frame shader) without a second draw or a duplicated atlas resource.

  // Interior lamp footprint. A `lightPlacement` is authored in logical root
  // coordinates and converted here to client-local normalized coordinates
  // (root corner + scaled offset, minus the root L/T insets); the legacy
  // normalized `lightAnchor`/`lightSpread` remain for packs authored directly
  // in client space. The shader always receives an already-client-local centre
  // and spread, never a root-space value it would inset twice.
  const { lightColor } = pack.interior;
  let lightAnchor: readonly [MaybeSignal<number>, MaybeSignal<number>] =
    pack.interior.lightAnchor ?? ([0, 0] as const);
  let lightSpread: readonly [MaybeSignal<number>, MaybeSignal<number>] =
    pack.interior.lightSpread ?? ([0, 0] as const);
  const placement = pack.interior.lightPlacement;
  if (placement) {
    const anchorRight = placement.anchor === "tr" || placement.anchor === "br";
    const anchorBottom = placement.anchor === "bl" || placement.anchor === "br";
    const [plOffX, plOffY] = placement.offset;
    const [plSpX, plSpY] = placement.spread;
    lightAnchor = [
      computed(() => {
        const rootX = (anchorRight ? read(width) : 0) + plOffX * ornamentScale();
        return Math.max(0, (rootX - insets.left) / clientW());
      }),
      computed(() => {
        const rootY = (anchorBottom ? read(height) : 0) + plOffY * ornamentScale();
        return Math.max(0, (rootY - insets.top) / clientH());
      }),
    ];
    lightSpread = [
      computed(() => (plSpX * ornamentScale()) / clientW()),
      computed(() => (plSpY * ornamentScale()) / clientH()),
    ];
  }

  // Interior eye reflections: the same per-role button centres the native
  // header row lays out (min left of max left of close), converted to
  // client-local normalized coordinates. The header sits above the client, so
  // the reflection is a bounded peripheral glow hugging the client top edge
  // (centre y = 0). Hues follow the min/max/close order.
  const [dollW, dollH] = pack.controls?.doll ?? [32, 44];
  const eyeCenters: readonly [
    MaybeSignal<number>,
    MaybeSignal<number>,
    MaybeSignal<number>,
  ] = ACTIONS.map((_action, i) =>
    computed(() => {
      const cw = clientW();
      const close = cw - headerPadding(read(width)) - 16;
      const cx = close - (2 - i) * 36;
      return Math.min(1, Math.max(0, cx / cw));
    }),
  ) as unknown as readonly [MaybeSignal<number>, MaybeSignal<number>, MaybeSignal<number>];
  const eyeRadius: readonly [MaybeSignal<number>, MaybeSignal<number>] = [
    computed(() => (dollW * 0.375) / clientW()),
    computed(() => (dollH * 0.375) / clientH()),
  ];
  const EYE_CENTER_Y = 0;

  // Kitty identity: read once here (the facade is fixed for this runtime) so
  // the optional pack-02 story scene — a Kitty-interior-only feature — is only
  // CONSTRUCTED for a kitty target. The interior glass below reuses the flag.
  // Non-kitty windows therefore allocate no scene graphs or atlas resources.
  const appId = read(window.appId)?.toLowerCase() ?? "";
  const isKitty = appId.includes("kitty");

  // --- Ambient speed + optional bamboo-girl scene (pack 02) ------------------
  // Pack 02 keeps its authored 20s ambient harmonics (rain scroll, lamp,
  // crane) while the story clock runs the full 120s scene period. 120 is an
  // exact multiple of 20, so wrapping the shared seconds into the ambient
  // period keeps the interior scroll seam-continuous AND at its original
  // speed. Every other pack binds the pack period unchanged.
  const AMBIENT_PERIOD_SECONDS = 20;
  const isAmbientWrap = pack.id === "02";
  const interiorSeconds: ReadonlySignal<number> = isAmbientWrap
    ? computed(() => read(secondsSignal) % AMBIENT_PERIOD_SECONDS)
    : secondsSignal;
  const interiorPeriodSeconds = isAmbientWrap
    ? AMBIENT_PERIOD_SECONDS
    : pack.periodSeconds;

  // Scene artwork/motion contract: a pack declaring scene artwork without
  // scene motion channels (or vice versa) is invalid.
  const sceneArt = pack.scene;
  const sceneMotion = motion.scene;
  if (sceneArt !== undefined && sceneMotion === undefined) {
    fail(pack, "pack declares scene artwork without scene motion channels");
  }

  // Scene geometry, computed once per runtime from the shared root proxies
  // and the same ornament/geometry formulas the motion module uses, so the
  // frame and interior stay continuous. All positions are converted to
  // client-local logical px exactly once (root minus the left/top insets)
  // before binding; the interior effect's rect IS the client opening.
  const BAMBOO_LAYER_IDS = [
    "bamboo-slat",
    "bamboo-roll",
    "tie-near",
    "tie-far",
  ] as const;
  let sceneUniforms: ShaderUniformMap | null = null;
  let sceneAtlasPath: string | null = null;
  if (isKitty && pack.id === "02" && sceneArt && sceneMotion) {
    const bambooIndex = BAMBOO_LAYER_IDS.map((id) => {
      const index = pack.layers.findIndex((layer) => layer.id === id);
      if (index < 0) fail(pack, `scene requires authored layer "${id}"`);
      return index;
    });
    const pressY = sceneArt.pressContact[1];
    const [cellW, cellH] = sceneArt.cellSize;
    const girlScale = computed(() =>
      Math.min(
        0.2,
        Math.max(0, read(clientH) - 2) / cellH,
        Math.max(0, read(clientW) - 2) / cellW,
      ),
    );
    const sceneScale = computed(() => read(girlScale) / 0.2);
    // Authored girl fade, shared with the decorative button: at rest / quiet /
    // reduced the channel is 0, so the ENTIRE client overlay (girl sprite,
    // button face, press halo, impacts) is exactly transparent.
    const girlOpacity = computed(() =>
      Math.min(1, Math.max(0, read(sceneMotion.girlOpacity))),
    );
    // Shared scene/floor geometry in ROOT logical px (feet baseline at the
    // authored floor line; decorative button above it at the press contact).
    // The floor is the client opening's own last row: the root minus the
    // bottom ring and one pixel, so it follows the pack's real inset on every
    // root size instead of a hardcoded ring.
    const floorRootY = computed(() => read(height) - pack.insets.bottom - 1);
    const buttonRootX = computed(
      () => insets.left + FRAME_02_BUTTON_SPAN * read(sceneScale),
    );
    const buttonRootY = computed(
      () => read(floorRootY) - (sceneArt.baseline - pressY) * read(girlScale),
    );
    // Girl top: baseline (feet) sits at the authored floor line, so the top
    // is floor minus the AUTHORED baseline (not the cell height).
    const girlTopRoot = computed(
      () => read(floorRootY) - sceneArt.baseline * read(girlScale),
    );
    // Girl atlas cell: 4x4 row-major index of cellSize cells, expressed as
    // element-level scalars (uniform vec4 x, y, w, h).
    const girlFrameIndex = computed(() =>
      Math.min(15, Math.max(0, Math.round(read(sceneMotion.girlFrame)))),
    );

    // Fixed upper suspension anchors (LOGICAL ROOT, shared as
    // `FRAME_02_BAMBOO_ANCHORS`, tie-near then tie-far) and the CURRENT
    // tie-pivot attachments for the two loosened loops, all converted to
    // client-local (root minus L/T insets) exactly like every other scene
    // position. The pivot world point is `pos + pivot`, invariant under the
    // loop's own rotation, so the moving attachment never drifts while the tie
    // swings; at rest each anchor coincides with its tie pivot (offset +
    // pivot), so the cord length is zero at the quiet seam, and both anchors
    // carries the shared ornament scale.
    sceneUniforms = {
      logical_size: [clientW, clientH],
      // Root logical size and the ring insets: the shader recovers the ROOT
      // logical pixel from the frame rect exactly like frame.frag, then
      // subtracts insets.xy once to reach the client-local space every other
      // scene uniform is already expressed in.
      scene_frame_size: [width, height],
      scene_insets: insetsVec,
      scene_scale: sceneScale,
      frame_atlas_size: pack.atlasSize,
      scene_atlas_size: sceneArt.atlasSize,
      sc_cell: uniformArray.vec4(
        bambooIndex.map((i) => pack.layers[i].cell),
      ),
      sc_size: uniformArray.vec2(bambooIndex.map((i) => rlSize[i])),
      sc_pivot: uniformArray.vec2(bambooIndex.map((i) => rlPivot[i])),
      sc_pos: uniformArray.vec2(
        bambooIndex.map(
          (i) =>
            [
              computed(() => read(posX[i]) - insets.left),
              computed(() => read(posY[i]) - insets.top),
            ] as const,
        ),
      ),
      sc_angle: uniformArray.float(bambooIndex.map((i) => totalAngle[i])),
      sc_reveal: uniformArray.float(bambooIndex.map((i) => reveal[i])),
      sc_reveal_mode: uniformArray.float(
        bambooIndex.map((i) => revealMode[i]),
      ),
      g_cell: [
        computed(() => (read(girlFrameIndex) % 4) * cellW),
        computed(() => Math.floor(read(girlFrameIndex) / 4) * cellH),
        cellW,
        cellH,
      ],
      g_pos: [
        computed(() => read(sceneMotion.girlX) - insets.left),
        computed(() => read(girlTopRoot) - insets.top),
      ],
      g_size: [
        computed(() => cellW * read(girlScale)),
        computed(() => cellH * read(girlScale)),
      ],
      g_facing: computed(() => read(sceneMotion.girlFacing)),
      g_opacity: girlOpacity,
      // The decorative button is part of the same event bubble: gating it by
      // the authored girl opacity keeps the client opening exactly
      // transparent at rest / quiet / reduced.
      b_opacity: girlOpacity,
      b_center: [
        computed(() => read(buttonRootX) - insets.left),
        computed(() => read(buttonRootY) - insets.top),
      ],
      b_size: [
        computed(() => 18 * read(sceneScale)),
        computed(() => 10 * read(sceneScale)),
      ],
      b_press: computed(() =>
        Math.min(1, Math.max(0, read(sceneMotion.buttonPress))),
      ),
      floor_impact: computed(() =>
        Math.min(1, Math.max(0, read(sceneMotion.floorImpact))),
      ),
      ceiling_impact: computed(() =>
        Math.min(1, Math.max(0, read(sceneMotion.ceilingImpact))),
      ),
      // Fixed suspension cords: the two shared root anchors, the two current
      // tie pivots (pos + pivot, client-local) and the floor-impact slack.
      cord_a0: [
        computed(
          () => FRAME_02_BAMBOO_ANCHORS[0][0] * read(ornamentScale) - insets.left,
        ),
        computed(
          () => FRAME_02_BAMBOO_ANCHORS[0][1] * read(ornamentScale) - insets.top,
        ),
      ],
      cord_a1: [
        computed(
          () => FRAME_02_BAMBOO_ANCHORS[1][0] * read(ornamentScale) - insets.left,
        ),
        computed(
          () => FRAME_02_BAMBOO_ANCHORS[1][1] * read(ornamentScale) - insets.top,
        ),
      ],
      cord_e0: [
        computed(
          () =>
            read(posX[bambooIndex[2]]) -
            insets.left +
            read(rlPivot[bambooIndex[2]][0]),
        ),
        computed(
          () =>
            read(posY[bambooIndex[2]]) -
            insets.top +
            read(rlPivot[bambooIndex[2]][1]),
        ),
      ],
      cord_e1: [
        computed(
          () =>
            read(posX[bambooIndex[3]]) -
            insets.left +
            read(rlPivot[bambooIndex[3]][0]),
        ),
        computed(
          () =>
            read(posY[bambooIndex[3]]) -
            insets.top +
            read(rlPivot[bambooIndex[3]][1]),
        ),
      ],
      cord_slack: computed(() =>
        Math.min(1, Math.max(0, read(sceneMotion.floorImpact))),
      ),
    };
    sceneAtlasPath = sceneArt.atlas;
  }

  // Unified frame effect: the generic frame shader always runs first (its
  // client opening is clipped transparent before any art). A pack-02 scene
  // stage is appended AFTER it exactly when the pack declared scene artwork,
  // so the girl/bamboo foreground composites over the frame art INSIDE the
  // client opening only; outside the opening the scene shader returns the
  // incoming frame art untouched, except for the fixed suspension cords, which
  // are the one overlay allowed to cross the native frame/client clip. Both
  // atlases are preloaded image sources bound once at compile time (no
  // per-tick texture load, no second draw).
  const frameEffect = compileWindowEffect({
    input: windowSource({ include: "full" }),
    alpha: "preserve",
    outsets: pack.outsets,
    invalidate: { kind: "on-source-damage-box", damagePadding: 0 },
    pipeline: [
      shaderStage(loadShader("./src/effect/rainlit/frame.frag"), {
        textures: { frame_atlas: imageSource(pack.atlas) },
        uniforms: {
          atlas_size: pack.atlasSize,
          logical_size: [width, height],
          insets: insetsVec,
          focused: focusSignal,
          wind: computed(() => read(motion.wind)),
          layer_count: pack.layers.length,
          rl_cell: uniformArray.vec4(
            padVec4(pack.layers.map((l) => l.cell)),
          ),
          rl_size: uniformArray.vec2(padVec2(rlSize)),
          rl_pivot: uniformArray.vec2(padVec2(rlPivot)),
          rl_pos: uniformArray.vec2(
            padVec2(posX.map((x, i) => [x, posY[i]] as const)),
          ),
          rl_angle: uniformArray.float(pad(totalAngle)),
          rl_reveal: uniformArray.float(pad(reveal)),
          rl_reveal_mode: uniformArray.float(pad(revealMode)),
          rl_emission: uniformArray.float(pad(emission)),
          rl_deform: uniformArray.float(pad(deform)),
          rl_corner_tl: pack.corners.tl,
          rl_corner_tr: pack.corners.tr,
          rl_corner_bl: pack.corners.bl,
          rl_corner_br: pack.corners.br,
          rl_corner_top_size: pack.cornerSize.top,
          rl_corner_bottom_size: pack.cornerSize.bottom,
          rl_rail_top: pack.rails.top,
          rl_rail_bottom: pack.rails.bottom,
          rl_rail_left: pack.rails.left,
          rl_rail_right: pack.rails.right,
          rl_rail_period: [pack.railPeriod.horizontal, pack.railPeriod.vertical],
        },
      }),
      ...(sceneUniforms && sceneAtlasPath !== null
        ? [
            shaderStage(loadShader("./src/effect/rainlit/scene.frag"), {
              // Both atlases are preloaded image sources bound once at
              // compile time; nothing loads a texture per tick.
              textures: {
                scene_atlas: imageSource(sceneAtlasPath),
                frame_atlas: imageSource(pack.atlas),
              },
              uniforms: sceneUniforms,
            }),
          ]
        : []),
    ],
  });

  // Kitty interior: backdrop source + supported dual-Kawase blur + the
  // interior profile shader, compiled once. Non-kitty identities get null.
  // Pack 02 also gets null: its approved ambient restoration is composed by
  // `index.tsx` from the legacy ambient handle, so compiling (and loading)
  // this unused interior.frag graph for 02 would be pure waste. The pack-02
  // story foreground does NOT live here: it is appended to the frame effect
  // pipeline, after the generic frame shader.
  const glass = isKitty && pack.id !== "02"
    ? compileEffect({
        input: backdropSource(),
        // Preserve the backdrop's alpha: the interior shader works directly on
        // the premultiplied RGB and unpremultiplies exactly once at its return.
        alpha: "preserve",
        pipeline: [
          dualKawaseBlur({ radius: 4, passes: 2 }),
          shaderStage(loadShader("./src/effect/rainlit/interior.frag"), {
            uniforms: {
              // The ShaderEffect wraps only ClientWindow, so its rect IS the
              // client opening: bind the real client size (root minus insets)
              // and evaluate the whole local rect from effect_content_uv.
              logical_size: [clientW, clientH],
              focused: focusSignal,
              seconds: interiorSeconds,
              period_seconds: interiorPeriodSeconds,
              wind: computed(() => read(motion.wind)),
              light: computed(() => read(motion.light)),
              shade: computed(() => read(motion.shade)),
              eyes: [
                computed(() => read(motion.eyes[0])),
                computed(() => read(motion.eyes[1])),
                computed(() => read(motion.eyes[2])),
              ],
              rain_strength: pack.interior.rainStrength,
              coolness: pack.interior.coolness,
              edge_shade: pack.interior.edgeShade,
              light_anchor: lightAnchor,
              light_spread: lightSpread,
              light_color: lightColor,
              eye_centers: eyeCenters,
              eye_center_y: EYE_CENTER_Y,
              eye_radius: eyeRadius,
            },
          }),
        ],
      })
    : null;

  // Smooth retargeting with no resets on repeated sync calls: native start
  // continues from the current value; the guards only skip no-op retargets
  // and always re-run a stopped, unfinished transition.
  let lastFocusTarget: number | null = null;
  const lastHoverTarget: Record<RainlitAction, number | null> = {
    min: null,
    max: null,
    close: null,
  };
  // Cached clock mode: "remainder" while the resumed tail plays, "full" while
  // the explicit 0..1 loop runs. A stop at an inner phase always resumes the
  // remainder; the flag drives the switch to the full loop on completion.
  let clockMode: "full" | "remainder" = "full";

  /**
   * Actual pack activation reset: stops and zeroes ALL owned tracks and
   * clears the activation-local cached targets. This guarantees a
   * reactivated pack never inherits a stale hover 1, a mid-decay press or a
   * focus-guard-consistent-but-wrong focus target from a previous pack.
   */
  const resetForActivation = (): void => {
    for (const track of OWNED_TRACKS) {
      ctrl.stop(track);
      ctrl.set(track, 0);
    }
    lastFocusTarget = null;
    for (const action of ACTIONS) lastHoverTarget[action] = null;
    clockMode = "full";
  };

  const startFullLoop = (): void => {
    clockMode = "full";
    ctrl.set(TRACK_SECONDS, 0);
    ctrl.start(TRACK_SECONDS, {
      from: 0,
      to: 1,
      duration: pack.periodSeconds * 1000,
      repeat: "loop",
    });
  };

  /**
   * Shared retarget guard: skips no-op retargets and always re-runs a
   * stopped, unfinished transition toward `target`. Used by hover events and
   * by `sync` when resuming tracks that a stop left mid-transition.
   */
  const retargetHover = (action: RainlitAction, target: number): void => {
    const variable = TRACK_HOVER[action];
    const running = ctrl.running(variable);
    const current = read(ctrl.variable(variable));
    if (
      lastHoverTarget[action] === target &&
      (running || Math.abs(current - target) <= 1e-4)
    ) {
      return;
    }
    lastHoverTarget[action] = target;
    ctrl.start(variable, { duration: 200, to: target });
  };

  const setHoveredAction = (action: RainlitAction, hovered: boolean): void => {
    const target = hovered ? 1 : 0;
    if (reducedLocal()) {
      lastHoverTarget[action] = target;
      ctrl.set(TRACK_HOVER[action], target);
      return;
    }
    retargetHover(action, target);
  };

  const pulseAction = (action: RainlitAction): void => {
    const variable = TRACK_PRESS[action];
    // Reduced motion has no transient pulse: keep the channel at rest so the
    // eye reflection can never stay stuck bright after an action.
    if (reducedLocal()) {
      ctrl.set(variable, 0);
      return;
    }
    ctrl.set(variable, 1);
    ctrl.start(variable, { duration: 180, from: 1, to: 0 });
  };

  const stopOwnedTracks = (): void => {
    for (const track of OWNED_TRACKS) ctrl.stop(track);
  };

  const sync = (visible: boolean, focused: boolean, terminal: boolean): void => {
    void terminal; // informational; frame motion is app-independent per plan
    const fullscreen = read(window.isFullscreen);
    if (!visible || fullscreen) {
      stopOwnedTracks();
      return;
    }
    if (reducedLocal()) {
      // Reduced: endless clock stops (rest snapshot); transitions immediate,
      // press cleared.
      stopOwnedTracks();
      clockMode = "full";
      const reducedFocus = focused ? 1 : 0;
      if (
        lastFocusTarget !== reducedFocus ||
        read(ctrl.variable(TRACK_FOCUS)) !== reducedFocus
      ) {
        lastFocusTarget = reducedFocus;
        ctrl.set(TRACK_FOCUS, reducedFocus);
      }
      for (const action of ACTIONS) {
        const hoverTarget = lastHoverTarget[action] ?? 0;
        if (read(ctrl.variable(TRACK_HOVER[action])) !== hoverTarget) {
          ctrl.set(TRACK_HOVER[action], hoverTarget);
        }
        if (read(ctrl.variable(TRACK_PRESS[action])) !== 0) {
          ctrl.set(TRACK_PRESS[action], 0);
        }
      }
      return;
    }
    if (!ctrl.running(TRACK_SECONDS)) {
      const phase = Math.min(1, Math.max(0, read(ctrl.variable(TRACK_SECONDS))));
      if (clockMode === "remainder" && phase >= 1 - 1e-4) {
        startFullLoop();
      } else if (phase > 1e-4 && phase < 1 - 1e-4) {
        // Resume the remaining segment with its actual remaining duration,
        // then the full loop restores on completion.
        clockMode = "remainder";
        ctrl.start(TRACK_SECONDS, {
          from: phase,
          to: 1,
          duration: Math.max(1, (1 - phase) * pack.periodSeconds * 1000),
        });
      } else {
        startFullLoop();
      }
    }
    const focusTarget = focused ? 1 : 0;
    if (
      lastFocusTarget !== focusTarget ||
      (!ctrl.running(TRACK_FOCUS) &&
        read(ctrl.variable(TRACK_FOCUS)) !== focusTarget)
    ) {
      lastFocusTarget = focusTarget;
      ctrl.start(TRACK_FOCUS, { duration: 300, to: focusTarget });
    }
    // Resume hover tracks a stop left unfinished: advance each toward the
    // cached last target (no allocation, no reset of running tracks).
    for (const action of ACTIONS) {
      const hoverTarget = lastHoverTarget[action];
      if (hoverTarget !== null) retargetHover(action, hoverTarget);
    }
    // Resume a press pulse a stop interrupted mid-decay (180 ms toward 0).
    for (const action of ACTIONS) {
      const variable = TRACK_PRESS[action];
      if (!ctrl.running(variable)) {
        const current = read(ctrl.variable(variable));
        if (current > 1e-4) {
          ctrl.start(variable, { duration: 180, from: current, to: 0 });
        }
      }
    }
  };

  return {
    pack,
    motion,
    assignment: { inFront: frameEffect },
    glass,
    setHoveredAction,
    pulseAction,
    sync,
    stop: stopOwnedTracks,
    resetForActivation,
  };
}

/**
 * Per-window runtime accessor. The bounded cache (WeakMap) keeps at most one
 * lazily built runtime per pack id plus the per-window reduced signal. The
 * accessor copies the live selection policy into that signal and activates
 * the selected pack; it never deletes or rebuilds cached graphs, so hide /
 * fullscreen / minimize / null / reduced transitions only stop or resume
 * tracks. Null selection stops the active pack and returns null so the legacy
 * frame keeps its current pipeline.
 *
 * There is no caller-supplied geometry argument: the runtime owns its
 * persistent geometry proxies from the window's managed rect state, so
 * caller-side mapped proxies can never be disposed underneath it.
 */
export function rainlitFor(window: WaylandWindow): RainlitWindowRuntime | null {
  const selection = rainlitSelection();
  let entry = runtimes.get(window);
  if (!entry) {
    entry = withoutCompositionOwnership(
      (): RuntimeCacheEntry => ({
        packs: {},
        reduced: signal(selection.reducedMotion),
        activeId: null,
      }),
    );
    runtimes.set(window, entry);
  }
  const cache = entry;
  // Copy the global policy into the per-window signal (the only reduced signal
  // the cached graphs depend on); a change informs them without a rebuild.
  cache.reduced.value = selection.reducedMotion;

  const id = selection.id;
  if (id === null) {
    if (cache.activeId !== null) {
      cache.packs[cache.activeId]?.stop();
      cache.activeId = null;
    }
    return null;
  }
  let runtime = cache.packs[id];
  if (!runtime) {
    const pack = PACKS[id];
    validatePack(pack);
    runtime = withoutCompositionOwnership(() =>
      buildRuntime(window, pack, cache.reduced),
    );
    cache.packs[id] = runtime;
  }
  if (cache.activeId !== id) {
    if (cache.activeId !== null) cache.packs[cache.activeId]?.stop();
    // An ACTUAL pack change resets every owned track through the new
    // runtime's own activation reset (shared native tokens zeroed, cached
    // focus/hover targets cleared, clock mode back to full), so no phase or
    // stale hover/focus state leaks across packs. Same-id, reduced-policy
    // and hide transitions never reach this branch.
    runtime.resetForActivation();
    cache.activeId = id;
  }
  // The facade whose runtime was just resolved is the CURRENT renderer-owned
  // object for this id. Record it for read-only inspection when the runtime
  // either owns a Kitty interior glass OR declares a scene (pack 02, whose
  // interior glass is intentionally not compiled — the declared scene is what
  // `rainlitSceneInspect` needs); one entry per live id, refreshed on every
  // call, never a runtime build.
  if (runtime.glass || runtime.pack.scene !== undefined) {
    inspectionWindows.set(window.id, window);
  }
  return runtime;
}

/**
 * Stops the window's owned Rainlit tracks (if a pack is active) while KEEPING
 * the bounded cached graphs, so a later re-show resumes instead of rebuilding.
 * This is a hide/fullscreen/art-disable stop: `activeId` and phase are
 * preserved UNLESS the current global selection is null — a null selection
 * roundtrip through this function is an actual deactivation, so `activeId`
 * is cleared only in that case.
 */
export function rainlitStop(window: WaylandWindow): void {
  const entry = runtimes.get(window);
  if (!entry || entry.activeId === null) return;
  entry.packs[entry.activeId]?.stop();
  if (rainlitSelection.value.id === null) {
    entry.activeId = null;
  }
}

/** Validates and applies an explicit selection (never called automatically). */
export function setRainlitSelection(
  id: RainlitFrameId | null,
  reducedMotion: boolean,
): void {
  if (id !== null && !FRAME_IDS.includes(id)) {
    throw new Error(`rainlit: unknown frame id ${JSON.stringify(id)}`);
  }
  rainlitSelection.value = { id, reducedMotion: Boolean(reducedMotion) };
}

/** Current selected pack, or null for the legacy frame. */
export function selectedRainlitPack(): FramePack | null {
  const id = rainlitSelection.value.id;
  return id === null ? null : PACKS[id];
}

/** Authored catalog facts only: no rendered/applied/verified claims. */
export function rainlitCatalog(): RainlitCatalogEntry[] {
  return FRAME_IDS.map((id) => {
    const pack = PACKS[id];
    return {
      id: pack.id,
      title: pack.title,
      version: pack.version,
      atlasSize: pack.atlasSize,
      insets: pack.insets,
      outsets: pack.outsets,
      minimumRoot: pack.minimumRoot,
      layerCount: pack.layers.length,
      periodSeconds: pack.periodSeconds,
    };
  });
}

/** Selection state plus catalog; applying resources is never claimed. */
export function rainlitStatus(): RainlitStatus {
  return {
    selectedId: rainlitSelection.value.id,
    reducedMotion: rainlitSelection.value.reducedMotion,
    catalog: rainlitCatalog(),
    runtimeVerified: false,
  };
}

/** Rect in GLOBAL OUTPUT logical coordinates (usable directly for capture). */
export interface RainlitSceneRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Read-only snapshot of one window's cached scene runtime. Geometry is
 * resolved from the window's OWNED managed rect state at call time; the
 * phase is read from the existing native track value — nothing here builds
 * a runtime, starts a track or mutates any state.
 */
export interface RainlitSceneInspect {
  readonly windowId: string;
  readonly packId: RainlitFrameId;
  /** Native story clock seconds (0..pack period). */
  readonly seconds: number;
  readonly periodSeconds: number;
  /** Normalized 0..1 phase within the pack period. */
  readonly phase: number;
  /** Root logical rect in global output coordinates. */
  readonly root: RainlitSceneRect;
  /** Client opening (root minus pack insets), global coordinates. */
  readonly client: RainlitSceneRect;
  /**
   * Capture rect: root expanded by the pack's decoration outsets, global
   * coordinates — the rectangle a compositor screenshot of the decorated
   * window must cover.
   */
  readonly capture: RainlitSceneRect;
  readonly insets: RainlitEdges;
  readonly outsets: RainlitEdges;
}

/**
 * Cached-only inspection of an already built scene runtime for `window`.
 * The CURRENT renderer-owned facade is resolved by window id through the
 * inspection registry; there is NO fallback to the passed object (the manager
 * may hand us a stale facade, or call after close when the entry is gone).
 * A missing registry entry returns null. Restricted to the actual
 * scene target: pack 02 WITH declared scene artwork, a Kitty app identity,
 * and a currently render-eligible window (workspace-visible, not minimized /
 * minimize-visual-idle, not fullscreen by either the owned private state or
 * the native flag). Returns null otherwise; it NEVER constructs a runtime
 * just to inspect a hidden window and never seeks the clock.
 */
export function rainlitSceneInspect(
  window: WaylandWindow,
): RainlitSceneInspect | null {
  // Resolve the CURRENT renderer-owned facade for this id. There is NO
  // fallback to the caller's object: the manager may hand us a stale facade
  // (or one inspected after close, when the registry entry is already gone),
  // and inspecting it would report geometry from the very object we are
  // cutting over from. A missing registry entry honestly means no loaded
  // inspectable Kitty target.
  const target = inspectionWindows.get(window.id);
  if (!target) return null;
  const entry = runtimes.get(target);
  if (!entry || entry.activeId === null) return null;
  const runtime = entry.packs[entry.activeId];
  if (!runtime) return null;
  const pack = runtime.pack;
  if (pack.id !== "02" || pack.scene === undefined) return null;
  if (!(read(target.appId)?.toLowerCase() ?? "").includes("kitty")) {
    return null;
  }
  if (
    !read(target.state[WINDOW_STATE_WORKSPACE_VISIBLE]()) ||
    read(target.state[WINDOW_STATE_MINIMIZED]()) ||
    read(target.state[WINDOW_STATE_MINIMIZE_VISUAL_IDLE]()) ||
    read(target.state[WINDOW_STATE_FULLSCREEN]()) ||
    read(target.isFullscreen)
  ) {
    return null;
  }
  const rect = target.state[WINDOW_STATE_RECT]();
  const x = read(rect.x);
  const y = read(rect.y);
  const width = read(rect.width);
  const height = read(rect.height);
  const seconds = Math.min(
    pack.periodSeconds,
    Math.max(
      0,
      read(target.animation.variable(TRACK_SECONDS)) * pack.periodSeconds,
    ),
  );
  return {
    windowId: target.id,
    packId: pack.id,
    seconds,
    periodSeconds: pack.periodSeconds,
    phase: seconds / pack.periodSeconds,
    root: { x, y, width, height },
    client: {
      x: x + pack.insets.left,
      y: y + pack.insets.top,
      width: Math.max(1, width - pack.insets.left - pack.insets.right),
      height: Math.max(1, height - pack.insets.top - pack.insets.bottom),
    },
    capture: {
      x: x - pack.outsets.left,
      y: y - pack.outsets.top,
      width: width + pack.outsets.left + pack.outsets.right,
      height: height + pack.outsets.top + pack.outsets.bottom,
    },
    insets: pack.insets,
    outsets: pack.outsets,
  };
}
