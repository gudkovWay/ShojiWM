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
import { RAIN_BORDER_PX } from "./effect/rain-layout";
import {
  RainCloseButton,
  RainMaximizeButton,
  RainMinimizeButton,
} from "./effect/rain-controls";
// Rainlit frame packs: the runtime module imports the four authored pack
// modules purely (no asset loading, no effect compilation, no selection side
// effects at load). Pack 02 is the declared startup default; an explicit
// `{ id: null }` selection keeps the legacy pipeline below.
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
import {
  RainlitDollControls,
  RainlitWoodControls,
} from "./effect/rainlit/controls";

COMPOSITOR.env.apply({
  QT_QPA_PLATFORM: "wayland;xcb",
  QT_QPA_PLATFORMTHEME: "qt6ct",
  QT_IM_MODULE: "fcitx",
  XMODIFIERS: "@im=fcitx",
  SDL_IM_MODULE: "fcitx",
  GLFW_IM_MODULE: "ibus",
  ELECTRON_OZONE_PLATFORM_HINT: "wayland",
});
COMPOSITOR.env.publish();

COMPOSITOR.cursor.configure({
  theme: "Bibata-Modern-Ice",
  size: 24,
});

COMPOSITOR.process.once("GTK-CSD-control-buttons", {
  command: "gsettings set org.gnome.desktop.wm.preferences button-layout ':minimize,maximize,close'",
  runPolicy: "once-per-session",
});

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
// full `{ id, reducedMotion }` policy; the startup default is pack "02", and a
// restored `id: null` keeps the legacy frame. Only `rainlit.frames.select`
// (or the restore of a previously persisted selection) changes it.
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
 * authored insets (52px for 02, 26px for 06/09, and 48px top for 07);
 * this constant is the legacy 26px ring used when the selection is null.
 * Geometry is deliberately independent of the rain-art toggle, so
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
    // Restore only a valid policy. Missing or malformed state keeps startup
    // pack 02; an explicit null remains the legacy alternative.
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
//   workspaces.activate      { monitor: string, index: number }    (command)
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

COMPOSITOR.workspace.configure(() => {
  const view = HYBRID_WINDOW_MANAGER.viewForIpc();
  return {
    groups: view.monitors.map((monitor) => ({
      id: monitor.name,
      outputs: [monitor.name],
      workspaces: monitor.workspaces.map((workspace) => ({
        id: `${monitor.name}:${workspace.index}`,
        name: String(workspace.index),
        coordinates: [Math.max(0, workspace.index - 1)],
        active: workspace.active,
        hidden: !workspace.active && workspace.windowCount === 0,
      })),
    })),
  };
});

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
// Pack 02 is the cold-start default. IPC selections survive hot reload only;
// no picker or frame-selection keybinding is registered here.
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

COMPOSITOR.process.once("fcitx5", {
  command: "fcitx5 -d",
  runPolicy: "once-per-session",
});

// shoji-bar-3, the session's shell: bar, wallpaper, notification daemon and
// tray host.
//
// The shader is compiled first. The built .qsb is not in the repository, and
// without it the islands have no silhouette at all. The two are sequenced with
// `;` rather than `&&` on purpose: if the build fails, starting anyway with a
// previously built .qsb is far better than a session with no shell in it.
COMPOSITOR.process.once("shell", {
  command: "cd ~/.config/shoji-bar-3 && bash build.sh; exec quickshell --path .",
  runPolicy: "once-per-session",
});
// cliphist clipboard history watchers. Text and image need separate watchers;
// run as services so they are restarted if they ever exit.
COMPOSITOR.process.service("cliphist-text", {
  command: ["wl-paste", "--type", "text", "--watch", "cliphist", "store"],
  restart: "on-exit",
});
COMPOSITOR.process.service("cliphist-image", {
  command: ["wl-paste", "--type", "image", "--watch", "cliphist", "store"],
  restart: "on-exit",
});

COMPOSITOR.key.bind("terminal", "Super+T", () => {
  COMPOSITOR.process.spawn({ command: ["kitty"] });
});

// if kwallet6 is used as the password store, be sure to add the --password-store=kwallet6 flag
COMPOSITOR.key.bind("chrome", "Super+B", () => {
  COMPOSITOR.process.spawn({
    command:
      "google-chrome-stable --enable-features=OzonePlatform --ozone-platform=wayland",
  });
});

COMPOSITOR.key.bind("discord", "Super+D", () => {
  COMPOSITOR.process.spawn({
    command:
      "discord --enable-features=UseOzonePlatform --ozone-platform=wayland --enable-wayland-ime --disable-gpu",
  });
});

COMPOSITOR.key.bind("dolphin", "Super+E", () => {
  COMPOSITOR.process.spawn({ command: "dolphin" });
});

COMPOSITOR.key.bind("play", "XF86AudioPlay", () => {
  COMPOSITOR.process.spawn({ command: "playerctl play-pause" });
});
COMPOSITOR.key.bind("pause", "XF86AudioPause", () => {
  COMPOSITOR.process.spawn({ command: "playerctl play-pause" });
});
COMPOSITOR.key.bind("next", "XF86AudioNext", () => {
  COMPOSITOR.process.spawn({ command: "playerctl next" });
});
COMPOSITOR.key.bind("prev", "XF86AudioPrev", () => {
  COMPOSITOR.process.spawn({ command: "playerctl previous" });
});

// shoji-bar-3's application launcher, on the monitor under the cursor.
//
// The bar answers on Quickshell's IPC socket, which is addressed by the config
// it was started with rather than by a running instance id, so this works
// whether the bar was started by hand or by a service.
//
//   quickshell -p ~/.config/shoji-bar-3 ipc show
//
// lists the rest of the target's functions (open / close / toggle, each also
// in a `...On <screen>` form). An empty screen name would open it everywhere.
function toggleLauncher() {
  const monitor = HYBRID_WINDOW_MANAGER.getCurrentMonitorName();
  COMPOSITOR.process.spawn({
    command: `quickshell -p ~/.config/shoji-bar-3 ipc call launcher toggleOn "${monitor}"`,
  });
}
COMPOSITOR.key.bind("launcher", "Super+A", toggleLauncher);
// Super tap (fires on release only, when no other key/button was pressed in between).
COMPOSITOR.key.bind("launcher-tap", "Super", toggleLauncher, {
  on: "release",
});
// The same launcher panel with its field pointed at the clipboard's history.
function toggleClipboard() {
  const monitor = HYBRID_WINDOW_MANAGER.getCurrentMonitorName();
  COMPOSITOR.process.spawn({
    command: `quickshell -p ~/.config/shoji-bar-3 ipc call launcher clipboardOn "${monitor}"`,
  });
}
COMPOSITOR.key.bind("clipboard", "Super+V", toggleClipboard);

// Lock the session. No monitor argument: a lock covers every screen there is,
// and the shell refuses to expose an unlock over the same socket.
COMPOSITOR.key.bind("lock", "Super+L", () => {
  COMPOSITOR.process.spawn({
    command: "quickshell -p ~/.config/shoji-bar-3 ipc call session lock",
  });
});

COMPOSITOR.key.bind("screenshot", "Super+P", () => {
  COMPOSITOR.process.spawn({
    command: "hyprshot -m region --raw | swappy -f -",
  });
});
COMPOSITOR.key.bind("screenshot-freeze", "Super+Ctrl+P", () => {
  COMPOSITOR.process.spawn({
    command: "hyprshot -m region --freeze --raw | swappy -f -",
  });
});
COMPOSITOR.key.bind("toggle-tiling-mode", "Super+S", () => {
  HYBRID_WINDOW_MANAGER.toggleCurrentWorkspaceTiling();
  scheduleWorkspaceBroadcast();
});
COMPOSITOR.key.bind("close-focused-window", "Super+Q", () => {
  HYBRID_WINDOW_MANAGER.closeFocusedWindow();
});
COMPOSITOR.key.bind("toggle-focused-window-maximize", "Super+M", () => {
  HYBRID_WINDOW_MANAGER.toggleFocusedWindowMaximize();
});
COMPOSITOR.key.bind("toggle-focused-window-fullscreen", "Super+F", () => {
  HYBRID_WINDOW_MANAGER.toggleFocusedWindowFullscreen();
});
COMPOSITOR.key.bind("tile-focus-left-quick", "Super+Left", () => {
  HYBRID_WINDOW_MANAGER.focusTile(-1);
});
COMPOSITOR.key.bind("tile-focus-right-quick", "Super+Right", () => {
  HYBRID_WINDOW_MANAGER.focusTile(1);
});
COMPOSITOR.key.bind("tile-focus-left", "Super+Ctrl+Left", () => {
  HYBRID_WINDOW_MANAGER.focusTile(-1);
});
COMPOSITOR.key.bind("tile-focus-right", "Super+Ctrl+Right", () => {
  HYBRID_WINDOW_MANAGER.focusTile(1);
});
COMPOSITOR.key.bind("tile-move-left", "Super+Shift+Left", () => {
  HYBRID_WINDOW_MANAGER.moveFocusedTile(-1);
  scheduleWorkspaceBroadcast();
});
COMPOSITOR.key.bind("tile-move-right", "Super+Shift+Right", () => {
  HYBRID_WINDOW_MANAGER.moveFocusedTile(1);
  scheduleWorkspaceBroadcast();
});
COMPOSITOR.key.bind("window-move-workspace-prev", "Super+Shift+Up", () => {
  HYBRID_WINDOW_MANAGER.moveFocusedWindowToWorkspace(-1);
  scheduleWorkspaceBroadcast();
});
COMPOSITOR.key.bind("window-move-workspace-next", "Super+Shift+Down", () => {
  HYBRID_WINDOW_MANAGER.moveFocusedWindowToWorkspace(1);
  scheduleWorkspaceBroadcast();
});
COMPOSITOR.key.bind("workspace-prev", "Super+Ctrl+Up", () => {
  HYBRID_WINDOW_MANAGER.switchWorkspace(-1);
  scheduleWorkspaceBroadcast();
});
COMPOSITOR.key.bind("workspace-next", "Super+Ctrl+Down", () => {
  HYBRID_WINDOW_MANAGER.switchWorkspace(1);
  scheduleWorkspaceBroadcast();
});

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

COMPOSITOR.output.configure((context) => {
  const display: DisplayConfigDraft = {};

  display["eDP-1"] = {
    mode: "extend",
    resolution: "best",
    position: "auto",
    scale: 1.8,
    transform: "normal",
  };
  display["eDP-2"] = {
    mode: "extend",
    resolution: "best",
    position: "auto",
    scale: 1.8,
  };
  display["HDMI-A-1"] = {
    mode: "extend",
    resolution: "best",
    position: "auto",
    scale: 1.5,
  };
  display["DP-1"] = {
    mode: "extend",
    resolution: "best",
    position: "auto",
    scale: 1.5,
  };
  display["DP-4"] = {
    mode: "extend",
    resolution: "best",
    position: "auto",
    scale: 1.5,
  };
  display["DP-2"] = {
    mode: "extend",
    resolution: "best",
    position: "auto",
    scale: 1.6,
  };

  const isDocked = context.connected.some(
    (output) => output.name === "HDMI-A-1",
  );
  if (isDocked) {
    display["eDP-1"] = { mode: "disabled" };
    display["eDP-2"] = { mode: "disabled" };
  }

  return display;
});

COMPOSITOR.input.configure((input, _context) => {
  input.global = {
    touchpad: {
      tapToClick: true,
      naturalScroll: true,
      scrollMethod: "twoFinger",
      disableWhileTyping: true,
      scrollFactor: 0.3,
    },
    pointer: {
      pointerAccel: 0.0,
      accelProfile: "flat",
      motionSpace: "logical",
    },
    keyboard: {
      options: "caps:ctrl_modifier",
      repeatRate: 60,
      repeatDelay: 250,
    },
  };

  input.device["Razer Razer Blade Keyboard"] = {
    keyboard: {
      layout: "us",
    },
  };
});

HYBRID_WINDOW_MANAGER.configureWorkspaceGestureSpeed({
  workspaceScrollFactor: 1.5,
  workspaceScrollKineticFactor: 1,
  workspaceSwitchFactor: 1,
  workspaceSwitchVelocityFactor: 1,
  // At or below this scroll speed (logical px/s) the workspace scroll
  // catches on tile snap positions (fully-on-screen edges; center for
  // maximized tiles). 0 disables snapping.
  workspaceScrollSnapMaxVelocity: 600,
  // Finger travel (logical px) needed to break out of a caught position.
  workspaceScrollSnapBreakoutPx: 48,
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
  HYBRID_WINDOW_MANAGER.onFocus(window, focused);
  if (focused) {
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

function naturalRootRect(window: WaylandWindow): ManagedWindowRect {
  const client = window.position;
  if (rainVariantFor(window.appId()) !== undefined) {
    // Unified frame: the selected pack's authored material ring (52px for 02,
    // 26px for 06/09, 48px top for 07), or the legacy 26px ring while the
    // selection is null. Positive L/R/B insets
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
  return {
    x: client.x - WINDOW_BORDER_PX,
    y: client.y - TITLEBAR_HEIGHT - WINDOW_BORDER_PX,
    width: client.width + WINDOW_BORDER_PX * 2,
    height: client.height + TITLEBAR_HEIGHT + WINDOW_BORDER_PX * 2,
  };
}

COMPOSITOR.window.composition = (window: WaylandWindow) => {
  const decoration = window.decoration();
  const useClientDecoration =
    decoration.mode === "client" &&
    !(
      decoration.clientPreference === "server" &&
      decoration.configuredMode === "server"
    );
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
  const rainTerminal =
    rainDecorated() && rainVariantFor(window.appId()) === "terminal";
  const ambientGlass =
    rainTerminal && (selectedPack === null || selectedPack.id === "02")
      ? ambientGlassFor(window, selectedPack?.insets ?? LEGACY_RAIN_INSETS)
      : null;

  const borderColor = window.isFocused((focused) =>
    focused ? "#d7ba7d" : "#4f5666",
  );
  const titlebarBackground = window.isFocused((focused) =>
    focused ? "#1f243080" : "#2a2f3a80",
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

  const backgroundShader = compileEffect({
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
      <ShaderEffect shader={backgroundShader} direction="column">
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
        interactive={inactive((value) => !value)}
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
        interactive={inactive((value) => !value)}
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
        interactive={inactive((value) => !value)}
      >
        <WindowBorder
          style={{
            border: { px: WINDOW_BORDER_PX, color: borderColor },
            borderRadius: 10,
            background: "#10131900",
            padding: 0,
            paddingX: 0,
            paddingRight: 0,
          }}
          interaction={{
            resizeHitArea: {
              edgePx: 8,
              cornerPx: 14,
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
      interactive={inactive((value) => !value)}
    >
      <WindowBorder
        style={{
          border: { px: WINDOW_BORDER_PX, color: borderColor },
          borderRadius: 10,
          background: "#10131900",
          padding: 0,
          paddingX: 0,
          paddingRight: 0,
        }}
        interaction={{
          resizeHitArea: {
            edgePx: 8,
            cornerPx: 14,
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
