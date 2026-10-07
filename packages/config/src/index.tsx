import {
  AppIcon,
  Box,
  Button,
  ClientWindow,
  Image,
  ShaderEffect,
  Label,
  COMPOSITOR,
  WindowBorder,
  backdropSource,
  compileEffect,
  compileLayerEffect,
  dualKawaseBlur,
  type SSDStyle,
  type WaylandWindow,
  computed,
  useState,
  shaderStage,
  loadShader,
  layerSource,
  ManagedWindow,
  read,
  type DisplayConfigDraft,
  compilePopupEffect,
  popupSource,
  animationVariable,
  signal,
} from "shoji_wm";
import type {
  CompiledEffectHandle,
  CompositionRenderable,
  MaybeSignal,
  ManagedWindowRect,
  WindowEffectAssignment,
  WindowEffectHandle,
} from "shoji_wm/types";
import { createIpcServer } from "shoji_wm/ipc";
import {
  HybridWindowManager,
  TITLEBAR_HEIGHT,
  type HybridWindowManagerSnapshot,
  type WindowDecorationOutsets,
  WINDOW_BORDER_PX,
  WINDOW_STATE_FULLSCREEN,
  WINDOW_STATE_MINIMIZED,
  WINDOW_STATE_MINIMIZE_VISUAL_IDLE,
  WINDOW_STATE_TILE_DRAGGING,
  WINDOW_STATE_TILE_REORDERING,
  WINDOW_STATE_TILED,
  WINDOW_STATE_WORKSPACE_TILED,
  WINDOW_STATE_VISIBLE_OUTPUTS,
  WINDOW_STATE_RECT,
  WINDOW_STATE_WORKSPACE_VISIBLE,
  WINDOW_STATE_WORKSPACE_INPUT_ELIGIBLE,
  WINDOW_STATE_WORKSPACE_OFFSET_Y,
  WINDOW_STATE_WORKSPACE_OPACITY,
} from "./window-manager";
import { ISLAND_GLASS } from "./effect/island-glass";
import { createAmbientGlassEffect } from "./effect/ambient-content";
import {
  ACTIVE_COMPOSITION,
  AMBIENT_PERIOD_MS,
} from "./effect/ambient-composition";
import { createRainFrameEffect } from "./effect/rain-frame";
import { createRainWeatherEffect } from "./effect/rain-weather";
import { installDotCursorTrail } from "./effect/dot-cursor-trail";
import { RAIN_BORDER_PX } from "./effect/rain-layout";
import {
  RainCloseButton,
  RainMaximizeButton,
  RainMinimizeButton,
} from "./effect/rain-controls";
// Rainlit frame packs: the runtime module imports the four authored pack
// modules purely (no asset loading, no effect compilation, no selection side
// effects at load). With the default `{ id: null }` selection nothing here
// resolves a pack, so the legacy pipeline below is bit-for-bit unchanged.
import {
  headerPadding,
  rainlitFor,
  rainlitForgetInspection,
  rainlitSceneInspect,
  rainlitSelection,
  rainlitStatus,
  rainlitStop,
  selectedRainlitPack,
  setRainlitSelection,
  type RainlitEdges,
  type RainlitFrameId,
} from "./effect/rainlit/runtime";
import { RainlitDollControls, RainlitWoodControls } from "./effect/rainlit/controls";
import {
  WORKSPACES_PER_OUTPUT,
  globalWorkspaceIndex,
} from "./workspace-policy";

COMPOSITOR.env.apply({
  QT_QPA_PLATFORM: "wayland;xcb",
  QT_QPA_PLATFORMTHEME: "qt6ct",
  GLFW_IM_MODULE: "ibus",
  ELECTRON_OZONE_PLATFORM_HINT: "wayland",
});
COMPOSITOR.env.publish();

COMPOSITOR.cursor.configure({
  theme: "Dot-Dark",
  size: 24,
});
installDotCursorTrail();

COMPOSITOR.window.decoration.configure((_window, context) => {
  return { mode: context.clientPreference ?? "server" };
});

const ZERO_DECORATION_OUTSETS: WindowDecorationOutsets = {
  left: 0,
  right: 0,
  top: 0,
  bottom: 0,
};

/**
 * External decoration footprint per window: the selected Rainlit pack's
 * authored outsets for currently recognized targets, zero otherwise
 * (non-target apps, null selection, fullscreen). Derived from the selected
 * pack only — never from the rain-art toggle — so target geometry stays
 * stable when the art is switched off.
 */
function decorationOutsetsFor(window: WaylandWindow): WindowDecorationOutsets {
  if (
    window.isFullscreen() ||
    window.state[WINDOW_STATE_FULLSCREEN]() ||
    rainVariantFor(window.appId()) === undefined
  ) {
    return ZERO_DECORATION_OUTSETS;
  }
  return selectedRainlitPack()?.outsets ?? ZERO_DECORATION_OUTSETS;
}

const HYBRID_WINDOW_MANAGER = new HybridWindowManager(
  naturalRootRect,
  decorationOutsetsFor,
);
const HOT_RELOAD_WINDOW_MANAGER_STATE = "config.hybrid-window-manager";
const FULLSCREEN_Z_INDEX = 2_000_000_000;
const FLOATING_WINDOW_Z_INDEX_BASE = 1_500_000_000;
const WINDOW_STACK_Z_INDEX_RANGE = 100_000_000;
const FOCUSED_TILED_WINDOW_Z_INDEX = 1_000_000_000;
const REORDERING_TILED_WINDOW_Z_INDEX = -2_000_000_000;
const RAIN_EFFECTS_STATE = "config.rain-effects-enabled";
// Own reload key for the explicit Rainlit frame selection. The value is the
// full `{ id, reducedMotion }` policy; a restored `id: null` keeps the legacy
// frame. Nothing is auto-selected: only `rainlit.frames.select` (or the
// restore of a previously persisted selection) changes it.
const RAINLIT_SELECTION_STATE = "config.rainlit-selection";
const rainEffectsEnabled = signal(true);
const ambientPhase = animationVariable("ambient-shoji-phase");
const rainFrameCache = new WeakMap<
  WaylandWindow,
  {
    variant: RainVariant;
    titlebarHeight: number;
    assignment: WindowEffectAssignment;
  }
>();
const ambientGlassCache = new WeakMap<
  WaylandWindow,
  Record<string, CompiledEffectHandle>
>();
const legacyWeatherCache = new WeakMap<WaylandWindow, WindowEffectHandle>();
const legacyAmbientAssignmentCache =
  new WeakMap<WaylandWindow, WindowEffectAssignment>();

/**
 * App-surface identity: Kitty owns a compositor backdrop; Zen owns browser CSS.
 * Both share the same static structural frame.
 */
type RainVariant = "terminal" | "browser";

function rainVariantFor(appId: string | undefined): RainVariant | undefined {
  switch (appId?.toLowerCase()) {
    case "kitty":
      return "terminal";
    case "zen":
      return "browser";
    default:
      return undefined;
  }
}

/** Exact `rainlit.frames.select` / restore id validation (no coercion). */
function isRainlitFrameId(value: unknown): value is RainlitFrameId {
  return value === "02" || value === "06" || value === "07" || value === "09";
}

/**
 * Logical root insets for the unified frame come from the selected pack's
 * authored insets (26px sides/bottom, top 26 for 02/06/09 and 48 for the 07
 * beam); this constant is the legacy fixed 26px ring used when the selection
 * is null. Geometry is deliberately independent of the rain-art toggle, so
 * native chrome and the reserved opening never move when art is switched off.
 */
const LEGACY_RAIN_INSETS: RainlitEdges = {
  left: RAIN_BORDER_PX,
  right: RAIN_BORDER_PX,
  top: RAIN_BORDER_PX,
  bottom: RAIN_BORDER_PX,
};

/**
 * Compiled ambient backdrop handle for one window and one content-inset
 * bucket, created once and reused for that window's whole lifetime. The
 * per-window native animation signal is bound at creation; the parent only
 * starts/stops that signal, so no per-frame compilation or allocation happens
 * here.
 *
 * The bucket key is the inset totals (horizontal x vertical): a 26px <-> 52px
 * selection change resolves a different cached handle instead of rebuilding,
 * and — critically — each cached graph's mapped size proxies capture the
 * inset math of ITS bucket, so a callback can never read a later selection's
 * geometry from an earlier graph. At most two buckets are ever live per
 * window.
 */
function ambientGlassFor(
  window: WaylandWindow,
  insets: RainlitEdges,
): CompiledEffectHandle {
  const key = `${insets.left + insets.right}:${insets.top + insets.bottom}`;
  let buckets = ambientGlassCache.get(window);
  if (!buckets) {
    buckets = {};
    ambientGlassCache.set(window, buckets);
  }
  let glass = buckets[key];
  if (!glass) {
    // The ambient ShaderEffect (and the client opening it backs) sits inside
    // the frame's reserved rails, so its logical rect is the root minus the
    // selected pack's authored insets — 104 x 104 for pack 02's 52px timber on
    // every side, 52 x 52 for the legacy 26px ring plus 26px header row.
    // Mapped proxies, never cached values, so resizes keep flowing into the
    // uniform without recompiling; clamped to 1 so a degenerate rect can never
    // invert the lantern box or the rain grid.
    const contentSize = [
      window.state[WINDOW_STATE_RECT]((rect) =>
        Math.max(1, read(rect.width) - (insets.left + insets.right)),
      ),
      window.state[WINDOW_STATE_RECT]((rect) =>
        Math.max(1, read(rect.height) - (insets.top + insets.bottom)),
      ),
    ] as [MaybeSignal<number>, MaybeSignal<number>];
    glass = createAmbientGlassEffect(
      window.animation.variable(ambientPhase),
      ACTIVE_COMPOSITION,
      contentSize,
    );
    buckets[key] = glass;
  }
  return glass;
}

/**
 * Compiled legacy weather handle for one window (pack 02 Kitty only). The
 * approved S-tier restoration reuses the original content-aware droplet optics
 * as the pack's `replace` assignment, compiled once per window with the same
 * stable mapped root-size proxies the legacy branch binds — never per tick.
 * `borderPx` is the reserved rail width the shaders keep clear of: pack 02
 * passes its authored 52px instead of the legacy 26px ring.
 */
function legacyWeatherFor(
  window: WaylandWindow,
  borderPx: number,
): WindowEffectHandle {
  let weather = legacyWeatherCache.get(window);
  if (!weather) {
    const frameSize = [
      window.state[WINDOW_STATE_RECT]((rect) => read(rect.width)),
      window.state[WINDOW_STATE_RECT]((rect) => read(rect.height)),
    ] as [MaybeSignal<number>, MaybeSignal<number>];
    weather = createRainWeatherEffect(
      window.animation.variable(ambientPhase),
      ACTIVE_COMPOSITION,
      frameSize,
      borderPx,
    );
    legacyWeatherCache.set(window, weather);
  }
  return weather;
}

COMPOSITOR.onDisable((event) => {
  if (event.isReloading) {
    const snapshot = HYBRID_WINDOW_MANAGER.snapshot();
    event.persist(HOT_RELOAD_WINDOW_MANAGER_STATE, snapshot);
    event.persist(RAIN_EFFECTS_STATE, rainEffectsEnabled.peek());
    // Persist the explicit frame policy; a `null` id persists as legacy.
    event.persist(RAINLIT_SELECTION_STATE, rainlitSelection.peek());
  }
  HYBRID_WINDOW_MANAGER.dispose();
});

COMPOSITOR.onEnable((event) => {
  if (event.isReloading) {
    // Rain policy first: every restored window's root insets and decoration
    // outsets derive from the selected pack, so the selection must be in
    // place before the manager snapshot re-applies any geometry.
    const rainEnabled = event.restore<boolean>(RAIN_EFFECTS_STATE);
    if (rainEnabled !== undefined) {
      rainEffectsEnabled.set(rainEnabled);
    }
    // Restore the known selection only if it validates exactly; a stale or
    // malformed value (or the previous `null`) leaves the legacy default.
    const restoredSelection = event.restore<unknown>(RAINLIT_SELECTION_STATE);
    if (restoredSelection && typeof restoredSelection === "object") {
      const { id, reducedMotion } = restoredSelection as {
        id?: unknown;
        reducedMotion?: unknown;
      };
      if (
        (id === null || isRainlitFrameId(id)) &&
        typeof reducedMotion === "boolean"
      ) {
        setRainlitSelection(id, reducedMotion);
      }
    }
    const snapshot = event.restore<HybridWindowManagerSnapshot>(
      HOT_RELOAD_WINDOW_MANAGER_STATE,
    );
    if (snapshot) {
      HYBRID_WINDOW_MANAGER.restore(snapshot);
    }
    // Re-fit restored tiled/maximized/snapped roots with the restored pack's
    // insets and outsets; owner state (floats, restore rects, focus) is kept.
    HYBRID_WINDOW_MANAGER.refreshUsableAreaLayouts(true);
  }
});

// ---------------------------------------------------------------------------
// External IPC: expose the workspace layout to clients such as the bar.
//   workspaces.get           -> WorkspacesView                     (request/response)
//   workspaces.switch        { direction: -1 | 1 }                 (command)
//   workspaces.activate      { monitor, index }  index is global      (command)
//   workspaces.toggleTiling  { monitor?: string }                  (command)
//   workspaces.changed       -> WorkspacesView                     (broadcast)
//   windows.activate         { windowId: string }                  (command)
//   dock.proximity           { monitor: string, inside: bool }    (broadcast)
// ---------------------------------------------------------------------------
const WORKSPACE_IPC = createIpcServer();
let lastWorkspacesJson = "";
let workspaceBroadcastQueued = false;

function broadcastWorkspaces() {
  const view = HYBRID_WINDOW_MANAGER.viewForIpc();
  const json = JSON.stringify(view);
  if (json === lastWorkspacesJson) {
    return;
  }
  lastWorkspacesJson = json;
  WORKSPACE_IPC.broadcast("workspaces.changed", view);
}

function reconfigureProtocolWorkspaces() {
  COMPOSITOR.workspace.reconfigure();
}

// Coalesce many state mutations within one tick into a single diffed broadcast.
function scheduleWorkspaceBroadcast() {
  // Protocol state must be staged before the current runtime response is
  // written; otherwise key bindings/Waybar activations only reach external
  // bars on a later, unrelated runtime request.
  reconfigureProtocolWorkspaces();
  if (workspaceBroadcastQueued) {
    return;
  }
  workspaceBroadcastQueued = true;
  void Promise.resolve().then(() => {
    workspaceBroadcastQueued = false;
    broadcastWorkspaces();
  });
}

// Workspace labels: DP-3 carries the CJK numerals 一..十 and DP-2 the ten
// heavenly stems 甲..癸, matching q's Noctalia bar (which renders the protocol
// `name`). Labels stay monitor-local, but protocol ids and coordinates use
// the global index from workspace-policy (DP-3 1..10, DP-2 11..20, further
// outputs 21+), so DP-3:1 and DP-2:11 stay distinct.
const WORKSPACE_LABELS: Record<string, string[]> = {
  "DP-3": ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"],
  "DP-2": ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"],
};

COMPOSITOR.workspace.configure(() => {
  const view = HYBRID_WINDOW_MANAGER.viewForIpc();
  // `viewForIpc` reports global workspace indices. Enumerate each output's
  // ten local slots, map them to their global index for the protocol id and
  // coordinates, and match the known set by that global index.
  const outputs = COMPOSITOR.output.list;
  return {
    groups: view.monitors.map((monitor) => {
      const known = new Map(
        monitor.workspaces.map((workspace) => [workspace.index, workspace]),
      );
      const workspaces = [];
      for (let local = 1; local <= WORKSPACES_PER_OUTPUT; local += 1) {
        const globalIndex = globalWorkspaceIndex(
          monitor.name,
          local,
          outputs,
        );
        const workspace = known.get(globalIndex);
        workspaces.push({
          id: `${monitor.name}:${globalIndex}`,
          name: WORKSPACE_LABELS[monitor.name]?.[local - 1] ?? String(local),
          coordinates: [globalIndex - 1],
          active: workspace?.active ?? false,
          // All ten slots stay advertised so the bar renders a stable,
          // persistent workspace strip rather than a shifting set.
          hidden: false,
        });
      }
      return {
        id: monitor.name,
        outputs: [monitor.name],
        workspaces,
      };
    }),
  };
});

// Protocol workspace ids are `monitor:globalIndex` (see workspace-policy), so
// the parsed suffix is already a global index at the external boundary.
COMPOSITOR.workspace.event.onActivate((event) => {
  const [monitor, rawIndex] = event.workspaceId.split(":");
  const index = Number(rawIndex);
  if (!monitor || !Number.isInteger(index) || index < 1) {
    return;
  }
  HYBRID_WINDOW_MANAGER.activate(monitor, index);
  scheduleWorkspaceBroadcast();
});

WORKSPACE_IPC.handle("workspaces.get", () =>
  HYBRID_WINDOW_MANAGER.viewForIpc(),
);
WORKSPACE_IPC.handle("workspaces.switch", (params) => {
  const direction = (params as { direction?: number } | undefined)?.direction;
  HYBRID_WINDOW_MANAGER.switchWorkspace(direction === -1 ? -1 : 1);
  scheduleWorkspaceBroadcast();
});
WORKSPACE_IPC.handle("workspaces.activate", (params) => {
  const request = params as { monitor?: string; index?: number } | undefined;
  // External clients address global indices; the manager converts them to
  // the monitor-local slot at this boundary.
  if (request?.monitor && typeof request.index === "number") {
    HYBRID_WINDOW_MANAGER.activate(request.monitor, request.index);
    scheduleWorkspaceBroadcast();
  }
});
WORKSPACE_IPC.handle("workspaces.toggleTiling", (params) => {
  const monitor = (params as { monitor?: string } | undefined)?.monitor;
  if (monitor) {
    HYBRID_WINDOW_MANAGER.toggleWorkspaceTilingForMonitor(monitor);
  } else {
    HYBRID_WINDOW_MANAGER.toggleCurrentWorkspaceTiling();
  }
  scheduleWorkspaceBroadcast();
});
WORKSPACE_IPC.handle("windows.activate", (params) => {
  const windowId = (params as { windowId?: string } | undefined)?.windowId;
  if (typeof windowId === "string") {
    HYBRID_WINDOW_MANAGER.activateWindowById(windowId);
    scheduleWorkspaceBroadcast();
  }
});

// ---------------------------------------------------------------------------
// Rainlit frame selection (bounded native API on the existing IPC server):
//   rainlit.frames.get     -> RainlitStatus  (configured selection + authored
//                            catalog; runtimeVerified is always false)
//   rainlit.frames.select  { id: null|'02'|'06'|'07'|'09', reducedMotion?: bool }
//                          (command) -> RainlitStatus
// Selection is configuration only: it is never auto-applied, no keybinding is
// registered, and no picker UI lives here (that is a later workstream).
// ---------------------------------------------------------------------------
WORKSPACE_IPC.handle("rainlit.frames.get", () => rainlitStatus());
WORKSPACE_IPC.handle("rainlit.frames.select", (params) => {
  const request = params as { id?: unknown; reducedMotion?: unknown } | undefined;
  if (!request || typeof request !== "object" || !("id" in request)) {
    throw new Error(
      "rainlit.frames.select: params must be an object with an id of null or 02/06/07/09",
    );
  }
  const { id, reducedMotion } = request;
  if (id !== null && !isRainlitFrameId(id)) {
    throw new Error(
      "rainlit.frames.select: id must be null or one of 02/06/07/09",
    );
  }
  if (reducedMotion !== undefined && typeof reducedMotion !== "boolean") {
    throw new Error(
      "rainlit.frames.select: reducedMotion must be a boolean when present",
    );
  }
  const current = rainlitSelection();
  // An omitted reducedMotion retains the current policy; on the very first
  // selection that is the default `false`.
  const nextReducedMotion =
    reducedMotion === undefined ? current.reducedMotion : reducedMotion;
  if (current.id !== id || current.reducedMotion !== nextReducedMotion) {
    setRainlitSelection(id, nextReducedMotion);
    // Re-apply window layouts so the new pack's insets AND per-window
    // decoration outsets take effect on already-open windows. `force` bypasses
    // the unchanged-tile-viewport optimization: a selection change alters
    // window geometry even when the viewport rect did not move.
    HYBRID_WINDOW_MANAGER.refreshUsableAreaLayouts(true);
  }
  return rainlitStatus();
});

// ---------------------------------------------------------------------------
//   rainlit.scene.inspect -> { scenes: RainlitSceneInspect & { output }[] }
// Read-only observation of ALREADY CACHED scene runtimes: native story-clock
// seconds/phase plus root/client/capture rects in GLOBAL OUTPUT logical
// coordinates (capture includes the pack's decoration outsets, ready for a
// scoped grim -g of the named window) and the carrying output's bounds and
// scale. No titles/text/palette, no runtime construction, no seek/control
// API; the inspector never changes selection.
// ---------------------------------------------------------------------------
WORKSPACE_IPC.handle("rainlit.scene.inspect", () => {
  const scenes = [];
  for (const window of HYBRID_WINDOW_MANAGER.listWindows()) {
    const info = rainlitSceneInspect(window);
    if (!info) continue;
    // Resolve the carrying output by the window centre in global logical
    // coordinates; `resolution / scale` is the logical size (see OutputInfo).
    const centerX = info.root.x + info.root.width / 2;
    const centerY = info.root.y + info.root.height / 2;
    let output: {
      name: string;
      scale: number;
      rect: { x: number; y: number; width: number; height: number };
    } | null = null;
    for (const name of COMPOSITOR.output.list) {
      const candidate = COMPOSITOR.output.current[name];
      if (!candidate?.resolution) continue;
      const ox = candidate.position.x;
      const oy = candidate.position.y;
      const ow = candidate.resolution.width / candidate.scale;
      const oh = candidate.resolution.height / candidate.scale;
      if (centerX >= ox && centerX < ox + ow && centerY >= oy && centerY < oy + oh) {
        output = {
          name,
          scale: candidate.scale,
          rect: { x: ox, y: oy, width: ow, height: oh },
        };
        break;
      }
    }
    scenes.push({ ...info, output });
  }
  return { scenes };
});

// ---------------------------------------------------------------------------
// Dock proximity: watch the pointer and broadcast enter/leave for the bottom
// strip of each monitor. The bar uses this in place of a layer-shell trigger
// surface (which would otherwise capture clicks meant for the windows below).
// ---------------------------------------------------------------------------
// Two thresholds with hysteresis:
//   - SHOW: pointer must be in the bottom 10px to trigger reveal
//   - HIDE: once visible, pointer must leave the bottom 120px to dismiss
// This gives a precise "reach for the dock" trigger while keeping the dock
// stable once the user is interacting with it (so brushing the cursor a few
// dozen pixels above the dock body does not flicker it away).
const DOCK_SHOW_ZONE_PX = 10;
const DOCK_HIDE_ZONE_PX = 120;
const dockProximityByMonitor = new Map<string, boolean>();

function pointerInBottomStrip(
  monitor: string,
  pointerX: number,
  pointerY: number,
  stripPx: number,
): boolean {
  const output = COMPOSITOR.output.get(monitor);
  if (!output || !output.resolution) {
    return false;
  }
  const width = output.resolution.width / output.scale;
  const height = output.resolution.height / output.scale;
  const left = output.position.x;
  const top = output.position.y;
  const right = left + width;
  const bottom = top + height;
  return (
    pointerX >= left &&
    pointerX < right &&
    pointerY >= bottom - stripPx &&
    pointerY < bottom
  );
}

function nextDockProximity(
  monitor: string,
  pointerX: number,
  pointerY: number,
  onTrackedMonitor: boolean,
): boolean {
  if (!onTrackedMonitor) return false;
  const wasInside = dockProximityByMonitor.get(monitor) === true;
  // While outside, only the narrow show-zone counts (10px).
  // While inside, the wide hide-zone keeps it open (120px).
  return pointerInBottomStrip(
    monitor,
    pointerX,
    pointerY,
    wasInside ? DOCK_HIDE_ZONE_PX : DOCK_SHOW_ZONE_PX,
  );
}

function updateDockProximity(monitor: string, inside: boolean) {
  if (dockProximityByMonitor.get(monitor) === inside) {
    return;
  }
  dockProximityByMonitor.set(monitor, inside);
  WORKSPACE_IPC.broadcast("dock.proximity", { monitor, inside });
}

// Snap-zone preview: broadcast the active snap rect (floating edge zones, or the
// opened tiling slot) to the bar, which renders the rounded preview overlay.
//   snap.preview  { monitor, rect: {x,y,w,h} | null, kind: "floating"|"tiling" }
let lastSnapJson = "";
HYBRID_WINDOW_MANAGER.setSnapPreviewBroadcaster((preview) => {
  const json = JSON.stringify(preview);
  if (json === lastSnapJson) {
    return;
  }
  lastSnapJson = json;
  WORKSPACE_IPC.broadcast("snap.preview", preview);
});

HYBRID_WINDOW_MANAGER.setWorkspaceChangeBroadcaster(() => {
  scheduleWorkspaceBroadcast();
});

COMPOSITOR.onDisable(() => {
  WORKSPACE_IPC.close();
});

// Noctalia, q's native shell: bar, wallpaper, notification daemon and tray.
// `shojiwm-noctalia` finalizes UWSM readiness with the live Wayland display and
// launches the installed native binary under the trial-only NOCTALIA_* roots.
COMPOSITOR.process.once("noctalia", {
  command: ["/home/q/.local/bin/shojiwm-noctalia"],
  runPolicy: "once-per-session",
});

// ---------------------------------------------------------------------------
// Compositor-global bindings for q.
//
// XKB owns layout switching (grp:caps_toggle in COMPOSITOR.input.configure), so
// every chord matches the physical raw-Latin key and works under both the US
// and RU groups. Noctalia IPC is addressed by the absolute installed binary so
// no PATH/upstream `noctalia` can capture a msg call; app openers go through
// UWSM. Held volume keys opt into native held-repeat below (250 ms delay,
// 100 ms interval); every other media key stays press-only.
// ---------------------------------------------------------------------------
const NOCTALIA_BIN = "/home/q/.local/opt/noctalia-jelly-cat/bin/noctalia";
const TMUS_BIN = "/home/q/.cargo/bin/tmus";
const LAUNCH_PREFIX = ["uwsm", "app", "--"] as const;

function noctaliaMsg(...args: string[]) {
  COMPOSITOR.process.spawn({ command: [NOCTALIA_BIN, "msg", ...args] });
}

function launchApp(...args: string[]) {
  COMPOSITOR.process.spawn({ command: [...LAUNCH_PREFIX, ...args] });
}

// Application openers.
COMPOSITOR.key.bind("terminal", "Super+Return", () => {
  launchApp("kitty");
});
COMPOSITOR.key.bind("file-manager", "Super+E", () => {
  launchApp("nemo");
});
COMPOSITOR.key.bind("telegram", "Super+T", () => {
  launchApp("AyuGram");
});
COMPOSITOR.key.bind("calculator", "Super+C", () => {
  launchApp("gnome-calculator");
});
COMPOSITOR.key.bind("browser", "Super+B", () => {
  launchApp("zen-browser");
});
COMPOSITOR.key.bind("calculator-key", "XF86Calculator", () => {
  launchApp("gnome-calculator");
});
COMPOSITOR.key.bind("btop", "Ctrl+Shift+Escape", () => {
  launchApp("kitty", "-e", "btop");
});

// Noctalia panel / plugin openers.
COMPOSITOR.key.bind("settings-toggle", "Super+Z", () => {
  noctaliaMsg("settings-toggle");
});
COMPOSITOR.key.bind("control-center", "Super+X", () => {
  noctaliaMsg("panel-toggle", "control-center");
});
COMPOSITOR.key.bind("launcher", "Super+D", () => {
  noctaliaMsg("panel-toggle", "launcher");
});
COMPOSITOR.key.bind("launcher-emoji", "Super+period", () => {
  noctaliaMsg("panel-toggle", "launcher", "/emo");
});
COMPOSITOR.key.bind("window-switcher", "Super+Tab", () => {
  noctaliaMsg("window-switcher");
});
COMPOSITOR.key.bind("clipboard", "Super+V", () => {
  noctaliaMsg("panel-toggle", "clipboard");
});
COMPOSITOR.key.bind("notifications", "Super+N", () => {
  noctaliaMsg("panel-toggle", "control-center", "notifications");
});
COMPOSITOR.key.bind("notification-dnd", "Super+Alt+D", () => {
  noctaliaMsg("notification-dnd-toggle");
});
COMPOSITOR.key.bind("session", "Super+Alt+P", () => {
  noctaliaMsg("panel-toggle", "session");
});
COMPOSITOR.key.bind("lock", "Super+Alt+L", () => {
  noctaliaMsg("session", "lock");
});
COMPOSITOR.key.bind("calendar", "Super+Alt+C", () => {
  noctaliaMsg("panel-toggle", "control-center", "calendar");
});
COMPOSITOR.key.bind("bluetooth", "Super+Alt+B", () => {
  noctaliaMsg("panel-toggle", "control-center", "bluetooth");
});
COMPOSITOR.key.bind("network", "Super+Alt+N", () => {
  noctaliaMsg("panel-toggle", "control-center", "network");
});
COMPOSITOR.key.bind("ai-triage", "Super+Alt+A", () => {
  noctaliaMsg("panel-toggle", "q/ai-triage:triage");
});
COMPOSITOR.key.bind("tmus-panel", "Super+Alt+M", () => {
  noctaliaMsg("panel-toggle", "q/tmus:library");
});

// Audio volume, microphone and brightness belong to Noctalia.
COMPOSITOR.key.bind(
  "volume-up",
  "XF86AudioRaiseVolume",
  () => {
    noctaliaMsg("volume-up");
  },
  { repeat: { delayMs: 250, intervalMs: 100 } },
);
COMPOSITOR.key.bind(
  "volume-down",
  "XF86AudioLowerVolume",
  () => {
    noctaliaMsg("volume-down");
  },
  { repeat: { delayMs: 250, intervalMs: 100 } },
);
COMPOSITOR.key.bind("volume-mute", "XF86AudioMute", () => {
  noctaliaMsg("volume-mute");
});
COMPOSITOR.key.bind("mic-mute", "XF86AudioMicMute", () => {
  noctaliaMsg("mic-mute");
});
COMPOSITOR.key.bind("brightness-up", "XF86MonBrightnessUp", () => {
  noctaliaMsg("brightness-up");
});
COMPOSITOR.key.bind("brightness-down", "XF86MonBrightnessDown", () => {
  noctaliaMsg("brightness-down");
});

// Media goes straight to the tmus daemon, never through an MPRIS "active
// player" lookup: with AyuGram on the bus, `noctalia msg media` would route
// playback to Telegram.
COMPOSITOR.key.bind("media-toggle", "XF86AudioPlay", () => {
  COMPOSITOR.process.spawn({ command: [TMUS_BIN, "toggle"] });
});
COMPOSITOR.key.bind("media-toggle-pause", "XF86AudioPause", () => {
  COMPOSITOR.process.spawn({ command: [TMUS_BIN, "toggle"] });
});
COMPOSITOR.key.bind("media-next", "XF86AudioNext", () => {
  COMPOSITOR.process.spawn({ command: [TMUS_BIN, "next"] });
});
COMPOSITOR.key.bind("media-prev", "XF86AudioPrev", () => {
  COMPOSITOR.process.spawn({ command: [TMUS_BIN, "prev"] });
});
COMPOSITOR.key.bind("media-stop", "XF86AudioStop", () => {
  COMPOSITOR.process.spawn({ command: [TMUS_BIN, "stop"] });
});

// Screenshots through Noctalia.
COMPOSITOR.key.bind("screenshot-region", "Print", () => {
  noctaliaMsg("screenshot-region");
});
COMPOSITOR.key.bind("screenshot-fullscreen", "Super+Print", () => {
  noctaliaMsg("screenshot-fullscreen");
});

// Window management. Directional focus/move reuse the same full modifier
// strings on both arrows and the physical HJKL Latin keys, so the chords work
// identically under the US and RU groups (XKB owns group switching).
COMPOSITOR.key.bind("close-focused-window", "Super+Q", () => {
  HYBRID_WINDOW_MANAGER.closeFocusedWindow();
});
COMPOSITOR.key.bind("toggle-focused-window-maximize", "Super+M", () => {
  HYBRID_WINDOW_MANAGER.toggleFocusedWindowMaximize();
});
COMPOSITOR.key.bind("toggle-focused-window-fullscreen", "Super+F", () => {
  HYBRID_WINDOW_MANAGER.toggleFocusedWindowFullscreen();
});
COMPOSITOR.key.bind("toggle-focused-window-floating", "Super+A", () => {
  HYBRID_WINDOW_MANAGER.toggleFocusedWindowFloating();
  scheduleWorkspaceBroadcast();
});
COMPOSITOR.key.bind("toggle-focused-window-split", "Super+Alt+J", () => {
  HYBRID_WINDOW_MANAGER.toggleFocusedWindowSplit();
  scheduleWorkspaceBroadcast();
});

// Directional focus: Super + arrow or HJKL.
COMPOSITOR.key.bind("focus-window-left-arrow", "Super+Left", () => {
  HYBRID_WINDOW_MANAGER.focusWindow("left");
});
COMPOSITOR.key.bind("focus-window-right-arrow", "Super+Right", () => {
  HYBRID_WINDOW_MANAGER.focusWindow("right");
});
COMPOSITOR.key.bind("focus-window-up-arrow", "Super+Up", () => {
  HYBRID_WINDOW_MANAGER.focusWindow("up");
});
COMPOSITOR.key.bind("focus-window-down-arrow", "Super+Down", () => {
  HYBRID_WINDOW_MANAGER.focusWindow("down");
});
COMPOSITOR.key.bind("focus-window-left-key", "Super+H", () => {
  HYBRID_WINDOW_MANAGER.focusWindow("left");
});
COMPOSITOR.key.bind("focus-window-right-key", "Super+L", () => {
  HYBRID_WINDOW_MANAGER.focusWindow("right");
});
COMPOSITOR.key.bind("focus-window-up-key", "Super+K", () => {
  HYBRID_WINDOW_MANAGER.focusWindow("up");
});
COMPOSITOR.key.bind("focus-window-down-key", "Super+J", () => {
  HYBRID_WINDOW_MANAGER.focusWindow("down");
});

// Directional movement: Super+Shift + arrow or HJKL.
COMPOSITOR.key.bind("move-window-left-arrow", "Super+Shift+Left", () => {
  HYBRID_WINDOW_MANAGER.moveFocusedWindow("left");
  scheduleWorkspaceBroadcast();
});
COMPOSITOR.key.bind("move-window-right-arrow", "Super+Shift+Right", () => {
  HYBRID_WINDOW_MANAGER.moveFocusedWindow("right");
  scheduleWorkspaceBroadcast();
});
COMPOSITOR.key.bind("move-window-up-arrow", "Super+Shift+Up", () => {
  HYBRID_WINDOW_MANAGER.moveFocusedWindow("up");
  scheduleWorkspaceBroadcast();
});
COMPOSITOR.key.bind("move-window-down-arrow", "Super+Shift+Down", () => {
  HYBRID_WINDOW_MANAGER.moveFocusedWindow("down");
  scheduleWorkspaceBroadcast();
});
COMPOSITOR.key.bind("move-window-left-key", "Super+Shift+H", () => {
  HYBRID_WINDOW_MANAGER.moveFocusedWindow("left");
  scheduleWorkspaceBroadcast();
});
COMPOSITOR.key.bind("move-window-right-key", "Super+Shift+L", () => {
  HYBRID_WINDOW_MANAGER.moveFocusedWindow("right");
  scheduleWorkspaceBroadcast();
});
COMPOSITOR.key.bind("move-window-up-key", "Super+Shift+K", () => {
  HYBRID_WINDOW_MANAGER.moveFocusedWindow("up");
  scheduleWorkspaceBroadcast();
});
COMPOSITOR.key.bind("move-window-down-key", "Super+Shift+J", () => {
  HYBRID_WINDOW_MANAGER.moveFocusedWindow("down");
  scheduleWorkspaceBroadcast();
});

// Super+Ctrl+Left/Right stay intentional focus aliases.
COMPOSITOR.key.bind("focus-window-left-alias", "Super+Ctrl+Left", () => {
  HYBRID_WINDOW_MANAGER.focusWindow("left");
});
COMPOSITOR.key.bind("focus-window-right-alias", "Super+Ctrl+Right", () => {
  HYBRID_WINDOW_MANAGER.focusWindow("right");
});

// Alt+Tab cycles visible non-minimized windows; Alt+Shift+Tab reverses.
COMPOSITOR.key.bind("cycle-window-forward", "Alt+Tab", () => {
  HYBRID_WINDOW_MANAGER.cycleFocusedWindow(1);
});
COMPOSITOR.key.bind("cycle-window-backward", "Alt+Shift+Tab", () => {
  HYBRID_WINDOW_MANAGER.cycleFocusedWindow(-1);
});
COMPOSITOR.key.bind("workspace-prev", "Super+Ctrl+Up", () => {
  HYBRID_WINDOW_MANAGER.switchWorkspace(-1);
  scheduleWorkspaceBroadcast();
});
COMPOSITOR.key.bind("workspace-next", "Super+Ctrl+Down", () => {
  HYBRID_WINDOW_MANAGER.switchWorkspace(1);
  scheduleWorkspaceBroadcast();
});
COMPOSITOR.key.bind("workspace-wheel-prev", "Super+WheelScrollUp", () => {
  HYBRID_WINDOW_MANAGER.switchWorkspace(-1);
  scheduleWorkspaceBroadcast();
});
COMPOSITOR.key.bind("workspace-wheel-next", "Super+WheelScrollDown", () => {
  HYBRID_WINDOW_MANAGER.switchWorkspace(1);
  scheduleWorkspaceBroadcast();
});

// Relative transfer of the focused window to the previous/next workspace.
COMPOSITOR.key.bind(
  "window-to-workspace-prev-key",
  "Super+Ctrl+Shift+Left",
  () => {
    HYBRID_WINDOW_MANAGER.moveFocusedWindowToWorkspace(-1);
    scheduleWorkspaceBroadcast();
  },
);
COMPOSITOR.key.bind(
  "window-to-workspace-next-key",
  "Super+Ctrl+Shift+Right",
  () => {
    HYBRID_WINDOW_MANAGER.moveFocusedWindowToWorkspace(1);
    scheduleWorkspaceBroadcast();
  },
);
COMPOSITOR.key.bind(
  "window-to-workspace-prev-wheel",
  "Super+Ctrl+Shift+WheelScrollUp",
  () => {
    HYBRID_WINDOW_MANAGER.moveFocusedWindowToWorkspace(-1);
    scheduleWorkspaceBroadcast();
  },
);
COMPOSITOR.key.bind(
  "window-to-workspace-next-wheel",
  "Super+Ctrl+Shift+WheelScrollDown",
  () => {
    HYBRID_WINDOW_MANAGER.moveFocusedWindowToWorkspace(1);
    scheduleWorkspaceBroadcast();
  },
);

// Digit workspaces are the monitor's own ten workspaces: 1..0 maps to the
// local slot carrying that digit on the monitor under the pointer (DP-3
// 一..十, DP-2 甲..癸). The key chooses a monitor-local slot, so activation
// passes the corresponding global index to the manager.
function activateWorkspaceDigit(digit: number) {
  const monitor = HYBRID_WINDOW_MANAGER.getCurrentMonitorName();
  if (!monitor) {
    return;
  }
  HYBRID_WINDOW_MANAGER.activate(
    monitor,
    globalWorkspaceIndex(monitor, digit, COMPOSITOR.output.list),
  );
  scheduleWorkspaceBroadcast();
}

for (let digit = 1; digit <= 10; digit += 1) {
  COMPOSITOR.key.bind(`workspace-${digit}`, `Super+${digit % 10}`, () => {
    activateWorkspaceDigit(digit);
  });
  // Super+Shift+digit sends the focused window and follows it;
  // Super+Ctrl+digit sends it without leaving the current workspace.
  COMPOSITOR.key.bind(
    `workspace-${digit}-move-follow`,
    `Super+Shift+${digit % 10}`,
    () => {
      HYBRID_WINDOW_MANAGER.moveFocusedWindowToWorkspaceIndex(digit, true);
      scheduleWorkspaceBroadcast();
    },
  );
  COMPOSITOR.key.bind(
    `workspace-${digit}-move-silent`,
    `Super+Ctrl+${digit % 10}`,
    () => {
      HYBRID_WINDOW_MANAGER.moveFocusedWindowToWorkspaceIndex(digit, false);
      scheduleWorkspaceBroadcast();
    },
  );
}

let fpsCounter = false;
COMPOSITOR.key.bind("fps", "Super+Shift+F", () => {
  fpsCounter = !fpsCounter;
  COMPOSITOR.debug.fpsCounter = fpsCounter;
});

let profileEnabled = false;
COMPOSITOR.key.bind("profile", "Super+Shift+T", () => {
  profileEnabled = !profileEnabled;
  COMPOSITOR.debug.enableProfile(profileEnabled);
});

COMPOSITOR.key.bind("rain-effects-toggle", "Super+Alt+E", () => {
  rainEffectsEnabled.update((enabled) => !enabled);
});

COMPOSITOR.output.configure(() => {
  const display: DisplayConfigDraft = {};

  // q's two panels. DP-2 (ultrawide) sits at the origin and DP-3 (2560x1440
  // main) directly below it; both keep x=0 so XWayland never sees a negative
  // coordinate and Wine/UE5 games can pick the right monitor size.
  display["DP-2"] = {
    mode: "extend",
    resolution: { width: 3440, height: 1440, refreshRate: 180 },
    position: { x: 0, y: 0 },
    scale: 1,
  };
  display["DP-3"] = {
    mode: "extend",
    resolution: { width: 2560, height: 1440, refreshRate: 240 },
    position: { x: 0, y: 1440 },
    scale: 1,
  };

  return display;
});

COMPOSITOR.input.configure((input) => {
  input.global = {
    keyboard: {
      layout: "us,ru",
      options: "grp:caps_toggle,fkeys:basic_13-24",
      repeatRate: 55,
      repeatDelay: 250,
    },
    pointer: {
      pointerAccel: 0,
      accelProfile: "flat",
      naturalScroll: false,
    },
  };
});

HYBRID_WINDOW_MANAGER.configureWorkspaceGestureSpeed({
  workspaceSwitchFactor: 1,
  workspaceSwitchVelocityFactor: 1,
});

COMPOSITOR.effect.background_effect = compileEffect({
  input: backdropSource(),
  capturePadding: 24,
  invalidate: { kind: "on-source-damage-box", damagePadding: 8 },
  pipeline: [dualKawaseBlur({ radius: 4, passes: 2 })],
});

const LAYER_BLUR_MASK = compileLayerEffect({
  input: backdropSource(),
  capturePadding: 24,
  invalidate: { kind: "on-source-damage-box", damagePadding: 8 },
  // The mask stage intentionally outputs transparency (the blur is clipped
  // to the layer's own alpha), so the pipeline's alpha must survive the
  // finish/display passes instead of being forced opaque.
  alpha: "preserve",
  pipeline: [
    dualKawaseBlur({ radius: 4, passes: 2 }),
    shaderStage(loadShader("./src/effect/layer-blur-mask.frag"), {
      textures: {
        layer_mask: layerSource(),
      },
      uniforms: {
        opacity_threshold: 0.25,
        mask_feather: 0.04,
      },
    }),
  ],
});

COMPOSITOR.effect.layer = (layer) => {
  const namespace = layer.namespace();
  // Both the LiquidIsland experiment and shoji-bar-3 draw only a translucent
  // silhouette and let the compositor recover the shape from its alpha.
  if (namespace === "liquid-island-qs" || namespace === "shoji-bar-3") {
    return { behind: ISLAND_GLASS };
  }
  if (namespace === "no_blur") {
    return {};
  }

  return {
    behind: LAYER_BLUR_MASK,
  };
};

const POPUP_BLUR = compilePopupEffect({
  input: backdropSource(),
  capturePadding: 4 * 2 * 2 + 24 + 32,
  invalidate: { kind: "on-source-damage-box", damagePadding: 8 },
  // The mask stage intentionally outputs transparency (the blur is clipped
  // to the layer's own alpha), so the pipeline's alpha must survive the
  // finish/display passes instead of being forced opaque.
  alpha: "preserve",
  pipeline: [
    dualKawaseBlur({ radius: 4, passes: 2 }),
    shaderStage(loadShader("./src/effect/layer-blur-mask.frag"), {
      textures: {
        layer_mask: popupSource(),
      },
      uniforms: {
        opacity_threshold: 0.25,
        mask_feather: 0.04,
      },
    }),
  ],
});

COMPOSITOR.effect.popup = (popup) => {
  if (popup.parentKind === "window") {
    return {};
  }

  return {
    behind: POPUP_BLUR,
  };
};

COMPOSITOR.effect.window = (window) => {
  const variant = rainVariantFor(window.appId());
  const selectedPack = selectedRainlitPack();
  const visible =
    window.state[WINDOW_STATE_WORKSPACE_VISIBLE]() ||
    window.state[WINDOW_STATE_TILE_DRAGGING]();
  if (
    !variant ||
    !rainEffectsEnabled() ||
    window.isFullscreen() ||
    window.state[WINDOW_STATE_FULLSCREEN]() ||
    window.state[WINDOW_STATE_MINIMIZED]() ||
    window.state[WINDOW_STATE_MINIMIZE_VISUAL_IDLE]() ||
    !visible
  ) {
    // Disabled/hidden/fullscreen/minimized targets own no moving art: stop
    // the legacy ambient clock and every Rainlit pack track. `rainlitStop`
    // stops the owned tracks but KEEPS the bounded cached graphs, so
    // re-showing resumes the remaining phase instead of rebuilding.
    window.animation.stop(ambientPhase);
    rainlitStop(window);
    return null;
  }

  // A selected pack owns the unified frame: its runtime supplies the in-front
  // frame assignment and its own native motion tracks. Pack 02 Kitty is the
  // exception by owner imperative: it restores the approved S-tier ambient —
  // the ORIGINAL 96s ambient clock (started below) driving the legacy ambient
  // backdrop composed in `ambientGlassFor`, plus the legacy content-aware
  // weather `replace` compiled at pack 02's 52px rail width. The pack's own
  // 120s frame/story clock stays a SEPARATE intentional clock inside
  // `runtime.sync`. Every other selected pack keeps its tracks stopped and
  // returns the runtime assignment unchanged.
  if (selectedPack) {
    const runtime = rainlitFor(window);
    if (runtime) {
      // Focus is read here so this effect re-runs on focus changes and feeds
      // the runtime's smooth native focus track; `terminal` only marks the
      // Kitty interior as relevant (frame motion is app-independent).
      runtime.sync(visible, window.isFocused(), variant === "terminal");
      if (selectedPack.id === "02" && variant === "terminal") {
        // Reduced motion freezes the ambient clock: the frozen phase still
        // renders the static lantern/rain backdrop, exactly like the
        // runtime's own stopped rest snapshot.
        if (rainlitSelection().reducedMotion) {
          window.animation.stop(ambientPhase);
        } else if (!window.animation.running(ambientPhase)) {
          window.animation.start(ambientPhase, {
            duration: AMBIENT_PERIOD_MS,
            from: 0,
            to: 1,
            repeat: "loop",
          });
        }
        // The composed assignment is cached so its identity stays stable
        // across sync calls (the compositor is handed the same object, and
        // the weather handle is compiled once per window).
        let assignment = legacyAmbientAssignmentCache.get(window);
        if (!assignment) {
          assignment = {
            inFront: runtime.assignment.inFront,
            replace:
              ACTIVE_COMPOSITION !== "moonlit-ink"
                ? legacyWeatherFor(window, selectedPack.insets.left)
                : null,
          };
          legacyAmbientAssignmentCache.set(window, assignment);
        }
        return assignment;
      }
      window.animation.stop(ambientPhase);
      return runtime.assignment;
    }
    return null;
  }

  // Legacy selection (null): stop any pack runtime left over from a previous
  // selection, then continue the unchanged legacy pipeline below.
  rainlitStop(window);

  // One 96s ambient clock per visible Kitty target, driving the inner backdrop
  // composition. Zen has no compositor ambient, so its clock is always
  // stopped. The parent starts the clock here — before the backdrop handle is
  // selected in `ambientGlassFor` — and stops it under the disabled/hidden/
  // fullscreen/minimized gates above.
  if (variant === "terminal") {
    if (!window.animation.running(ambientPhase)) {
      window.animation.start(ambientPhase, {
        duration: AMBIENT_PERIOD_MS,
        from: 0,
        to: 1,
        repeat: "loop",
      });
    }
  } else {
    window.animation.stop(ambientPhase);
  }

  // Every window reaching this branch is a unified-frame target: the client
  // opening always starts at the 26px border with a 26px native header above
  // it, so the frame reserves titlebar 0 for both CSD and SSD targets.
  const titlebarHeight = 0;
  let cached = rainFrameCache.get(window);
  if (!cached || cached.variant !== variant || cached.titlebarHeight !== titlebarHeight) {
    // Mapped WINDOW_STATE_RECT proxies, never cached computed values.
    const frameSize = [
      window.state[WINDOW_STATE_RECT]((rect) => read(rect.width)),
      window.state[WINDOW_STATE_RECT]((rect) => read(rect.height)),
    ] as [MaybeSignal<number>, MaybeSignal<number>];
    // The assignment retains this handle for the window's lifetime. Kitty
    // alone gets local weather, sharing the frame's mapped geometry; Zen and
    // moonlit-ink keep their existing client rendering.
    const weather =
      variant === "terminal" && ACTIVE_COMPOSITION !== "moonlit-ink"
        ? createRainWeatherEffect(
            window.animation.variable(ambientPhase),
            ACTIVE_COMPOSITION,
            frameSize,
          )
        : null;
    cached = {
      variant,
      titlebarHeight,
      // The native foreground frame is static: it is composited in front of
      // the client, never replacing it, and is never animated. The ambient
      // motion lives in the inner backdrop ShaderEffect (`ambientGlassFor`).
      // Only Kitty additionally carries `replace`, which swaps the captured
      // client surface for the lamp-lit, rain-lensed version while keeping
      // the original alpha; the rain shaders only distort their local areas
      // inside the client opening.
      assignment: {
        inFront: createRainFrameEffect(
          window.isFocused((focused) => (focused ? 1 : 0)),
          frameSize,
        ),
        replace: weather,
      },
    };
    rainFrameCache.set(window, cached);
  }
  return cached.assignment;
};

// Chromium-family clients repaint their CSD shadow margins as transparent
// black — while still declaring the whole surface opaque — the moment they
// send set_minimized, assuming the surface will never be shown again. Honoring
// that declaration skips blending and paints the margins as a solid black
// ring during the minimize animation.
const isChromiumFamily = (appId: string): boolean => {
  const id = appId.toLowerCase();
  return (
    id.includes("chrome") || id.includes("chromium") || id.includes("electron")
  );
};

// GTK3 tooltips (waybar) declare their whole rect opaque despite transparent
// rounded corners, which paints the corners as a solid fill and culls the
// behind-blur. Ignore the declaration for layer-shell popups.
COMPOSITOR.rendering.surfacePolicy = (surface) => {
  if (surface.kind === "popup" && surface.parentKind === "layer") {
    return { opaqueRegion: "ignore" };
  }
  if (surface.kind === "toplevel") {
    const window = surface.window;
    // Minimized only: the restore animation fades in from opacity 0, so the
    // few frames where a stale black-margin buffer could still be on screen
    // after unminimize are effectively invisible.
    if (
      isChromiumFamily(window.appId() ?? "") &&
      (window.state[WINDOW_STATE_MINIMIZED]() ||
        window.state[WINDOW_STATE_MINIMIZE_VISUAL_IDLE]())
    ) {
      return { opaqueRegion: "ignore" };
    }
  }
  return null;
};

COMPOSITOR.event.onOpen((window) => {
  HYBRID_WINDOW_MANAGER.onOpen(window);
});

COMPOSITOR.event.onInitialConfigure((window) => {
  HYBRID_WINDOW_MANAGER.onInitialConfigure(window);
});

COMPOSITOR.event.onFirstCommit((window) => {
  HYBRID_WINDOW_MANAGER.onFirstCommit(window);
  scheduleWorkspaceBroadcast();
});

COMPOSITOR.event.onStartClose((window) => {
  HYBRID_WINDOW_MANAGER.onStartClose(window);
  scheduleWorkspaceBroadcast();
});

COMPOSITOR.event.onClose((window) => {
  HYBRID_WINDOW_MANAGER.onClose(window);
  // Drop the inspection registry entry for the closed id so a same-id window
  // created later starts from a clean slate (bounded lifetime, one per id).
  rainlitForgetInspection(window.id);
  scheduleWorkspaceBroadcast();
});

COMPOSITOR.event.onFocus((window, focused) => {
  const accepted = HYBRID_WINDOW_MANAGER.onFocus(window, focused);
  if (focused && accepted) {
    HYBRID_WINDOW_MANAGER.recordFocus(window.id);
    scheduleWorkspaceBroadcast();
  }
});

COMPOSITOR.event.onPointerMove((event) => {
  HYBRID_WINDOW_MANAGER.onPointerMove(event);

  // Dock proximity: update only the monitor the pointer is currently on,
  // and emit "leave" for other monitors that were previously inside. The
  // narrow/wide threshold is hysteretic per current state.
  const pointerX = event.position.x;
  const pointerY = event.position.y;
  for (const monitor of COMPOSITOR.output.list) {
    const inside = nextDockProximity(
      monitor,
      pointerX,
      pointerY,
      monitor === event.outputName,
    );
    updateDockProximity(monitor, inside);
  }
});

COMPOSITOR.event.onGestureSwipe((event) => {
  HYBRID_WINDOW_MANAGER.onGestureSwipe(event);
  scheduleWorkspaceBroadcast();
});

COMPOSITOR.event.onOutputChange((event) => {
  HYBRID_WINDOW_MANAGER.onOutputChange(event);
  scheduleWorkspaceBroadcast();
});

COMPOSITOR.event.onCreateLayer(() => {
  HYBRID_WINDOW_MANAGER.refreshUsableAreaLayouts();
});

COMPOSITOR.event.onUpdateLayer(() => {
  HYBRID_WINDOW_MANAGER.refreshUsableAreaLayouts();
});

COMPOSITOR.event.onDestroyLayer(() => {
  HYBRID_WINDOW_MANAGER.refreshUsableAreaLayouts();
});

COMPOSITOR.event.onWindowResize((event) => {
  HYBRID_WINDOW_MANAGER.onWindowResize(event);
});

COMPOSITOR.pointer.bindWindowMoveModifier("Super");
COMPOSITOR.pointer.bindWindowResizeModifier("Super");

COMPOSITOR.event.onWindowMove((event) => {
  HYBRID_WINDOW_MANAGER.onWindowMove(event);
});

COMPOSITOR.event.onWindowMaximizeRequest((event) => {
  HYBRID_WINDOW_MANAGER.onWindowMaximizeRequest(event);
});

COMPOSITOR.event.onWindowMinimizeRequest((event) => {
  HYBRID_WINDOW_MANAGER.onWindowMinimizeRequest(event);
});

COMPOSITOR.event.onWindowFullscreenRequest((event) => {
  HYBRID_WINDOW_MANAGER.onWindowFullscreenRequest(event);
});

COMPOSITOR.event.onWindowActivateRequest((event) => {
  HYBRID_WINDOW_MANAGER.onWindowActivateRequest(event);
  scheduleWorkspaceBroadcast();
});

function usesClientDecoration(window: WaylandWindow): boolean {
  const decoration = window.decoration();
  return decoration.mode === "client" &&
    !(decoration.clientPreference === "server" &&
      decoration.configuredMode === "server");
}

function naturalRootRect(window: WaylandWindow): ManagedWindowRect {
  const client = window.position;
  if (rainVariantFor(window.appId()) !== undefined) {
    // Unified frame: the selected pack's authored material ring (26px sides
    // and bottom; top 26 for 02/06/09, 48 for the 07 beam), or the legacy
    // fixed 26px ring while the selection is null. Positive L/R/B insets
    // reserve the rails and the native header occupies the top inset, so the
    // total overhead is left+right by top+bottom — and this is independent of
    // the rain-art toggle so target geometry never changes when art is off.
    const insets = selectedRainlitPack()?.insets ?? LEGACY_RAIN_INSETS;
    return {
      x: client.x - insets.left,
      y: client.y - insets.top,
      width: client.width + insets.left + insets.right,
      height: client.height + insets.top + insets.bottom,
    };
  }
  const border = WINDOW_BORDER_PX;
  const titlebar = TITLEBAR_HEIGHT;
  return {
    x: client.x - border,
    y: client.y - titlebar - border,
    width: client.width + border * 2,
    height: client.height + titlebar + border * 2,
  };
}

COMPOSITOR.window.composition = (window: WaylandWindow) => {
  const useClientDecoration = usesClientDecoration(window);
  const workspaceVisible = window.state[WINDOW_STATE_WORKSPACE_VISIBLE];
  const workspaceOffsetY = window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y];
  const workspaceOpacity = window.state[WINDOW_STATE_WORKSPACE_OPACITY];
  const tileDragging = window.state[WINDOW_STATE_TILE_DRAGGING];
  const managedRect = computed(() => {
    const rect = window.state[WINDOW_STATE_RECT]();
    return {
      x: read(rect.x),
      y: read(rect.y) + workspaceOffsetY(),
      width: read(rect.width),
      height: read(rect.height),
    };
  });
  const forceRectSize = computed(
    () => window.isResizable() && !window.isTransient(),
  );

  // force no corner rounding CSD
  const tiled = true;

  const stackZIndex = HYBRID_WINDOW_MANAGER.getWindowZIndex(window);
  const zIndex = computed(() => {
    if (!window.state[WINDOW_STATE_WORKSPACE_TILED]()) {
      return stackZIndex();
    }
    const stackOffset = Math.max(
      -WINDOW_STACK_Z_INDEX_RANGE,
      Math.min(WINDOW_STACK_Z_INDEX_RANGE, stackZIndex()),
    );
    if (!window.state[WINDOW_STATE_TILED]()) {
      return FLOATING_WINDOW_Z_INDEX_BASE + stackOffset;
    }
    if (window.state[WINDOW_STATE_TILE_REORDERING]()) {
      return REORDERING_TILED_WINDOW_Z_INDEX;
    }
    return window.isFocused()
      ? FOCUSED_TILED_WINDOW_Z_INDEX
      : stackOffset;
  });
  const minimizeVisualIdle = window.state[WINDOW_STATE_MINIMIZE_VISUAL_IDLE];
  const inactive = computed(
    () => minimizeVisualIdle() || (!workspaceVisible() && !tileDragging()),
  );
  const inputEligible = window.state[WINDOW_STATE_WORKSPACE_INPUT_ELIGIBLE];
  // Input target, not merely visual presence: an outgoing workspace keeps
  // WORKSPACE_VISIBLE true while its transition renders, but only the active
  // workspace may accept input. The dragged tile stays interactive across a
  // workspace change, matching the existing tile-drag exception in `inactive`.
  const interactive = computed(
    () => !inactive() && (inputEligible() || tileDragging()),
  );

  // Target identity is independent of the rain-art toggle: kitty/zen always
  // carry the unified frame and its native header, whether or not the
  // painted rain art is enabled. `rainDecorated` below only decides art.
  const targetVariant = rainVariantFor(window.appId());
  const targetChrome = targetVariant !== undefined;
  const rainDecorated = computed(
    () => rainEffectsEnabled() && rainVariantFor(window.appId()) !== undefined,
  );
  // Selected Rainlit pack: its authored root insets drive the unified-frame
  // geometry independently of the art toggle (`rootInsets` below); a null
  // selection keeps LEGACY_RAIN_INSETS.
  const selectedPack = selectedRainlitPack();
  const rootInsets = selectedPack?.insets ?? LEGACY_RAIN_INSETS;
  const borderWidth = computed(() => rainDecorated() ? RAIN_BORDER_PX : WINDOW_BORDER_PX);
  const borderRadius = computed(() => rainDecorated() ? 0 : 10);
  const resizeEdge = computed(() => rainDecorated() ? RAIN_BORDER_PX : 8);
  const resizeCorner = computed(() => rainDecorated() ? 28 : 14);
  const borderColor = computed(() =>
    rainDecorated()
      ? "#00000000"
      : window.isFocused() ? "#d7ba7d" : "#4f5666",
  );
  const titlebarBackground = computed(() =>
    rainDecorated()
      ? window.isFocused() ? "#1c2530b0" : "#1c253090"
      : window.isFocused() ? "#1f243080" : "#2a2f3a80",
  );
  const titleColor = window.isFocused((focused) =>
    focused ? "#f5f7fa" : "#c9d1d9",
  );

  const titlebarStyle: SSDStyle = {
    height: TITLEBAR_HEIGHT,
    paddingX: 8,
    gap: 8,
    alignItems: "center",
    background: titlebarBackground,
  };

  // Kitty's inner backdrop is the animated ambient glass, but only while the
  // effects toggle is on; with the toggle off Kitty renders a bare
  // ClientWindow like any other app. `null` doubles as the "do not wrap"
  // signal in the unified-frame branch below. The ambient handle is used by
  // the legacy (null) selection AND by pack 02, whose approved S-tier
  // restoration puts the original two-lamp/rain backdrop back inside its
  // timber ring; every other selected pack keeps its own runtime interior
  // glass (and no longer compiles an interior for 02 at all). The sizes are
  // keyed by the selected pack's actual insets, so the 26px legacy ring and
  // pack 02's 52px timber never share a cached graph.
  const rainTerminal = rainDecorated() && rainVariantFor(window.appId()) === "terminal";
  const ambientGlass =
    rainTerminal && (selectedPack === null || selectedPack.id === "02")
      ? ambientGlassFor(window, selectedPack?.insets ?? LEGACY_RAIN_INSETS)
      : null;

  // Legacy liquid-glass backdrop for the remaining non-target terminal windows
  // (ghostty); untouched by the ambient composition work.
  const legacyGlassShader = compileEffect({
    input: backdropSource(),
    capturePadding: 24,
    invalidate: { kind: "on-source-damage-box", damagePadding: 8 },
    pipeline: [
      dualKawaseBlur({ radius: 4, passes: 2 }),
      shaderStage(loadShader("./src/effect/liquid-glass.frag"), {
        uniforms: {
          glass_radius_px: 10.0,
          distortion_depth: 0.2,
          distortion_strength: 0.15,
          chromatic_shift_px: 3.0,
          glass_tint: 0.9,
        },
      }),
    ],
  });

  const titleOnlyShader = compileEffect({
    input: backdropSource(),
    capturePadding: 24,
    invalidate: { kind: "on-source-damage-box", damagePadding: 8 },
    pipeline: [dualKawaseBlur({ radius: 4, passes: 2 })],
  });

  // Legacy app icon for ordinary windows. The unified-frame targets (Kitty and
  // Zen) render no icon and no title — their header is a flexible spacer plus
  // the native min/max/close controls (see the `targetChrome` branch below).
  const appIcon = (
    <AppIcon icon={window.icon} style={{ width: 16, height: 16 }} />
  );
  const label = (
    <Label
      text={window.title}
      style={{
        color: titleColor,
        fontFamily: ["Noto Sans CJK JP", "Noto Color Emoji"],
        fontSize: 13,
        fontWeight: 600,
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 0,
      }}
    />
  );
  const minimizeButton = <MinimizeButton window={window} />;
  const maximizeButton = <MaximizeButton window={window} />;
  const closeButton = <CloseButton window={window} />;

  var innerComponents = (
    <Box direction="column">
      <ShaderEffect
        shader={titleOnlyShader}
        direction="row"
        style={titlebarStyle}
      >
        {appIcon}
        {label}
        {minimizeButton}
        {maximizeButton}
        {closeButton}
      </ShaderEffect>
      <ClientWindow />
    </Box>
  );

  const TERMINALS = ["kitty", "ghostty"];

  if (TERMINALS.includes(window.appId() ?? "")) {
    innerComponents = (
      <ShaderEffect shader={legacyGlassShader} direction="column">
        <Box direction="row" style={titlebarStyle}>
          {appIcon}
          {label}
          {minimizeButton}
          {maximizeButton}
          {closeButton}
        </Box>
        <ClientWindow />
      </ShaderEffect>
    );
  }

  // Fullscreen: drop all chrome (titlebar, border, rounded corners) and let
  // the client surface fill its managed rect edge to edge. The rect is set to
  // the whole output by onWindowFullscreenRequest. Rendering nothing but the
  // bare ClientWindow is also what lets the tty backend promote the client
  // buffer to the primary plane (direct scanout).
  if (window.state[WINDOW_STATE_FULLSCREEN]()) {
    return (
      <ManagedWindow
        rect={managedRect}
        zIndex={FULLSCREEN_Z_INDEX}
        visibleOutputs={window.state[WINDOW_STATE_VISIBLE_OUTPUTS]}
        opacity={workspaceOpacity}
        forceRectSize={forceRectSize}
        tiled={tiled}
        idle={inactive}
        interactive={interactive}
        // Permit low-latency tearing for fullscreen windows. The compositor only actually tears
        // once the window is on the direct-scanout fast path and is committing faster than the
        // refresh rate (i.e. games), so this is a no-op for ordinary fullscreen apps. Narrow it
        // per app if desired, e.g. `allowTearing={isGame(window.appId())}`.
        allowTearing={true}
      >
        <ClientWindow />
      </ManagedWindow>
    );
  }

  // Unified frame: the selected pack's authored insets on the sides, bottom
  // and top (52px for 02's substantial timber, 48px top for 07, 26px for the
  // legacy ring and other packs), all covered by the same painted material. The header
  // carries only the always-visible native close/min/max controls (no app
  // icon, no title) and is real captured native UI, so the frame shader can
  // paint it over the wood rail. It is deliberately independent of
  // `rainEffectsEnabled`: Zen's profile CSS hides its own window buttons, so
  // toggling the rain art off may only switch the rails to plain wooden
  // colours — it must never remove the controls or the reserved geometry.
  if (targetChrome) {
    const artActive = rainDecorated();
    const rootWidth = window.state[WINDOW_STATE_RECT]((rect) => read(rect.width));
    const headerStyle: SSDStyle = {
      height: rootInsets.top,
      // 02's physical brass controls sit left of its one-shot corner joinery.
      // Narrow roots return padding before the stable 120px control row clips;
      // other packs retain the original shared eye-reflection layout.
      paddingX: selectedPack?.id === "02" && artActive
        ? rootWidth((width) =>
            Math.min(64, Math.max(8, (width - rootInsets.left - rootInsets.right - 120) / 2)),
          )
        : rootWidth(headerPadding),
      gap: rootWidth((width) => (width < 190 ? 2 : 4)),
      alignItems: "center",
      background: artActive ? "#00000000" : "#49363F",
    };
    // The pack runtime is built only for a visible, non-fullscreen,
    // non-minimized target with art active — the same gates
    // `COMPOSITOR.effect.window` uses — so a hidden or fullscreen pass never
    // compiles effects. `runtime.glass` is non-null only for Kitty.
    const rainlitVisible =
      window.state[WINDOW_STATE_WORKSPACE_VISIBLE]() ||
      window.state[WINDOW_STATE_TILE_DRAGGING]();
    const rainlitRuntime =
      selectedPack !== null &&
      artActive &&
      rainlitVisible &&
      !window.isFullscreen() &&
      !window.state[WINDOW_STATE_MINIMIZED]() &&
      !window.state[WINDOW_STATE_MINIMIZE_VISUAL_IDLE]()
        ? rainlitFor(window)
        : null;
    const rainlitGlass = rainlitRuntime?.glass ?? null;
    // Selected art uses its material-matched native controls; toggle-off and
    // the other packs retain the standard plaques and their stable hit boxes.
    const headerControls: CompositionRenderable[] =
      artActive && selectedPack?.id === "07" && rainlitRuntime
        ? [<RainlitDollControls window={window} runtime={rainlitRuntime} />]
        : artActive && selectedPack?.id === "02" && rainlitRuntime
          ? [<RainlitWoodControls window={window} runtime={rainlitRuntime} />]
          : [
              <RainMinimizeButton window={window} />,
              <RainMaximizeButton window={window} />,
              <RainCloseButton window={window} />,
            ];

    return (
      <ManagedWindow
        rect={managedRect}
        zIndex={zIndex}
        visibleOutputs={window.state[WINDOW_STATE_VISIBLE_OUTPUTS]}
        opacity={workspaceOpacity}
        forceRectSize={forceRectSize}
        tiled={tiled}
        idle={inactive}
        interactive={interactive}
      >
        <WindowBorder
          style={{
            // Per-edge border widths are not implemented by this runtime.
            // Reserve the painted rails with supported positive insets instead;
            // the top is fully covered by the native header above the client.
            border: { px: 0, color: "#00000000" },
            paddingLeft: rootInsets.left,
            paddingRight: rootInsets.right,
            paddingBottom: rootInsets.bottom,
            paddingTop: 0,
            borderRadius: 0,
            background: artActive ? "#00000000" : "#49363F",
          }}
          interaction={{
            // A small resize band only: button actions win hit-testing, and
            // the rest of the 26px header stays draggable rather than acting
            // as a full-width resize surface.
            resizeHitArea: { edgePx: 4, cornerPx: 32 },
          }}
        >
          <Box direction="column">
            <Box direction="row" style={headerStyle}>
              {/* No icon or title for the unified-frame targets: a flexible
                  spacer keeps the genuine min/max/close controls flush right. */}
              <Box style={{ flexGrow: 1 }} />
              {headerControls}
            </Box>
            {rainlitGlass ? (
              // Selected pack (other than 02), Kitty only: the pack runtime's
              // own interior backdrop wraps the client exactly like the legacy
              // ambient handle. Pack 02 falls through to the approved legacy
              // ambient glass below, because its runtime interior is no longer
              // compiled.
              <ShaderEffect
                shader={rainlitGlass}
                direction="column"
                style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }}
              >
                <ClientWindow />
              </ShaderEffect>
            ) : ambientGlass ? (
              <ShaderEffect
                shader={ambientGlass}
                direction="column"
                style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }}
              >
                <ClientWindow />
              </ShaderEffect>
            ) : (
              <ClientWindow />
            )}
          </Box>
        </WindowBorder>
      </ManagedWindow>
    );
  }

  // use less Server-Side Decoration
  if (useClientDecoration) {
    return (
      <ManagedWindow
        rect={managedRect}
        zIndex={zIndex}
        visibleOutputs={window.state[WINDOW_STATE_VISIBLE_OUTPUTS]}
        opacity={workspaceOpacity}
        forceRectSize={forceRectSize}
        tiled={tiled}
        idle={inactive}
        interactive={interactive}
      >
        <WindowBorder
          style={{
            border: { px: borderWidth, color: borderColor },
            borderRadius,
            background: "#10131900",
            padding: 0,
            paddingX: 0,
            paddingRight: 0,
          }}
          interaction={{
            resizeHitArea: {
              edgePx: resizeEdge,
              cornerPx: resizeCorner,
            },
          }}
        >
          <ClientWindow />
        </WindowBorder>
      </ManagedWindow>
    );
  }

  // use full Server-Side Decoration
  return (
    <ManagedWindow
      rect={managedRect}
      zIndex={zIndex}
      visibleOutputs={window.state[WINDOW_STATE_VISIBLE_OUTPUTS]}
      opacity={workspaceOpacity}
      forceRectSize={forceRectSize}
      tiled={tiled}
      idle={inactive}
      interactive={interactive}
    >
      <WindowBorder
        style={{
          border: { px: borderWidth, color: borderColor },
          borderRadius,
          background: "#10131900",
          padding: 0,
          paddingX: 0,
          paddingRight: 0,
        }}
        interaction={{
          resizeHitArea: {
            edgePx: resizeEdge,
            cornerPx: resizeCorner,
          },
        }}
      >
        <Box direction="row">{innerComponents}</Box>
      </WindowBorder>
    </ManagedWindow>
  );
};

const CloseButton = ({ window }: { window: WaylandWindow }) => {
  const [hover, setHover] = useState(false);

  const borderColor = hover((hover) => (hover ? "#00000000" : "#F0808030"));

  var icon: CompositionRenderable | null = null;
  if (hover()) {
    icon = (
      <Image
        src="./assets/x.svg"
        style={{
          width: 16,
          height: 16,
          position: "absolute",
          zIndex: 1,
          pointerEvents: "none",
        }}
      />
    );
  }

  return (
    <Box style={{ position: "relative", flexShrink: 0 }}>
      <Button
        onHoverChange={setHover}
        style={{
          width: 16,
          height: 16,
          borderRadius: 8,
          background: "#FFFFFF20",
          border: { px: 1, color: borderColor },
        }}
        onClick={window.close}
      />
      {icon}
    </Box>
  );
};

const MaximizeButton = ({ window }: { window: WaylandWindow }) => {
  const [hover, setHover] = useState(false);

  const borderColor = computed(() => {
    if (!window.isResizable()) {
      return "#00000000";
    }
    return hover() ? "#00000000" : "#00BFFF30";
  });
  const shouldHover = computed(() => hover() && window.isResizable());

  var icon: CompositionRenderable | null = null;
  if (shouldHover()) {
    const src = window.isMaximized((maximized) => {
      return maximized ? "./assets/minimize-2.svg" : "./assets/maximize-2.svg";
    });

    icon = (
      <Image
        src={src}
        style={{
          width: 16,
          height: 16,
          position: "absolute",
          zIndex: 1,
          pointerEvents: "none",
        }}
      />
    );
  }

  return (
    <Box style={{ position: "relative", flexShrink: 0 }}>
      <Button
        onHoverChange={setHover}
        style={{
          width: 16,
          height: 16,
          borderRadius: 8,
          background: "#FFFFFF20",
          border: { px: 1, color: borderColor },
        }}
        onClick={() => {
          if (!read(window.isResizable)) {
            return;
          }

          if (read(window.isMaximized)) {
            window.unmaximize();
          } else {
            window.maximize();
          }
        }}
      />
      {icon}
    </Box>
  );
};

const MinimizeButton = ({ window }: { window: WaylandWindow }) => {
  const [hover, setHover] = useState(false);

  const borderColor = hover((hover) => (hover ? "#00000000" : "#F8FF7530"));

  var icon: CompositionRenderable | null = null;
  if (hover()) {
    icon = (
      <Image
        src="./assets/minus.svg"
        style={{
          width: 16,
          height: 16,
          position: "absolute",
          zIndex: 1,
          pointerEvents: "none",
        }}
      />
    );
  }

  return (
    <Box style={{ position: "relative", flexShrink: 0 }}>
      <Button
        onHoverChange={setHover}
        style={{
          width: 16,
          height: 16,
          borderRadius: 8,
          background: "#FFFFFF20",
          border: { px: 1, color: borderColor },
        }}
        onClick={() => window.minimize()}
      />
      {icon}
    </Box>
  );
};

export default COMPOSITOR;
