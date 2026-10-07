import {
  createWindowStack,
  createWindowState,
  dropWindowState,
  cubicBezier,
  markWindowDirty,
  read,
  seconds,
  COMPOSITOR,
  type EasingFunction,
  type GestureSwipeEvent,
  type OutputChangeEvent,
  type PointerMoveEvent,
  type ReadonlySignal,
  type WaylandWindow,
  type WindowActivateRequestEvent,
  type WindowFullscreenRequestEvent,
  type WindowMaximizeRequestEvent,
  type WindowMinimizeRequestEvent,
  type WindowMoveEvent,
  type WindowResizeEvent,
  type WindowResizeRect,
} from "shoji_wm";
import type { ManagedWindowRect, WindowSizeConstraints } from "shoji_wm/types";
import {
  TileLayout,
  directionalNeighbor,
  type TileLayoutNode,
  type TileRect,
  type WindowDirection,
} from "./tile-layout";
import { playRectAnimation, stopRectAnimation } from "./window-animation";
import {
  WORKSPACES_PER_OUTPUT,
  globalWorkspaceIndex,
  localWorkspaceIndex,
  isOrdinaryWorkspaceIndex,
  isSpecialWorkspaceIndex,
} from "./workspace-policy";
import { windowPlacementFor } from "./window-rules";

export type SnapZone =
  | "maximize"
  | "left"
  | "right"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export const WINDOW_STATE_RECT = createWindowState<ManagedWindowRect>("rect", {
  default: (window) => window.rect,
});
export const WINDOW_STATE_RESTORE_RECT =
  createWindowState<ManagedWindowRect | null>("restoreRect", {
    default: null,
  });
export const WINDOW_STATE_MINIMIZED = createWindowState<boolean>("minimized", {
  default: false,
});
export const WINDOW_STATE_MINIMIZE_VISUAL_IDLE = createWindowState<boolean>(
  "minimizeVisualIdle",
  {
    default: false,
  },
);
export const WINDOW_STATE_MAXIMIZED = createWindowState<boolean>("maximized", {
  default: false,
});
export const WINDOW_STATE_FULLSCREEN = createWindowState<boolean>(
  "fullscreen",
  {
    default: false,
  },
);
// Pre-fullscreen rect, kept separate from WINDOW_STATE_RESTORE_RECT so a
// window that was maximized before going fullscreen restores back to its
// maximized rect (and the maximize restore rect underneath stays intact).
export const WINDOW_STATE_FULLSCREEN_RESTORE_RECT =
  createWindowState<ManagedWindowRect | null>("fullscreenRestoreRect", {
    default: null,
  });
export const WINDOW_STATE_WORKSPACE_VISIBLE = createWindowState<boolean>(
  "workspaceVisible",
  {
    default: true,
  },
);
/**
 * Whether this window's workspace is the monitor's active one and may accept
 * input. Deliberately separate from WINDOW_STATE_WORKSPACE_VISIBLE: that flag
 * stays true for the outgoing workspace while its native transition still
 * renders, so input eligibility has to follow the logical active workspace,
 * not the visual one.
 */
export const WINDOW_STATE_WORKSPACE_INPUT_ELIGIBLE = createWindowState<boolean>(
  "workspaceInputEligible",
  {
    default: true,
  },
);
export const WINDOW_STATE_WORKSPACE_OFFSET_Y = createWindowState<number>(
  "workspaceOffsetY",
  {
    default: 0,
  },
);
export const WINDOW_STATE_WORKSPACE_OPACITY = createWindowState<number>(
  "workspaceOpacity",
  {
    default: 1,
  },
);
export const WINDOW_STATE_TILE_DRAGGING = createWindowState<boolean>(
  "tileDragging",
  {
    default: false,
  },
);
export const WINDOW_STATE_TILE_REORDERING = createWindowState<boolean>(
  "tileReordering",
  {
    default: false,
  },
);
export const WINDOW_STATE_TILED = createWindowState<boolean>("tiled", {
  default: false,
});
/**
 * Per-window user override (Win+A): excludes exactly this window from
 * tiling, independent of its intrinsic dialog/non-resizable classification.
 * Persisted so the override survives snapshots, transfers and hot reloads.
 */
export const WINDOW_STATE_USER_FLOATING = createWindowState<boolean>(
  "userFloating",
  {
    default: false,
  },
);
export const WINDOW_STATE_WORKSPACE_TILED = createWindowState<boolean>(
  "workspaceTiled",
  {
    default: false,
  },
);
export const WINDOW_STATE_VISIBLE_OUTPUTS = createWindowState<string[] | null>(
  "visibleOutputs",
  {
    default: null,
  },
);
export const WINDOW_STATE_FLOATING_RECT =
  createWindowState<ManagedWindowRect | null>("floatingRect", {
    default: null,
  });
export const WINDOW_STATE_SNAP_ZONE = createWindowState<SnapZone | null>(
  "snapZone",
  {
    default: null,
  },
);
export const WINDOW_STATE_SNAP_MONITOR = createWindowState<string | null>(
  "snapMonitor",
  {
    default: null,
  },
);

const OPEN_CLOSE_ANIMATION_DURATION = seconds(0.5);
const WINDOW_MANAGEMENT_ANIMATION_DURATION = seconds(0.3);
const UNMAXIMIZE_GRAB_ANIMATION_DURATION = 90;
// See `lastRestoreAtMs`: a restore and an activate closer together than this
// are one taskbar click, so the minimize-raise toggle must not fire.
const RESTORE_ACTIVATE_GRACE_MS = 100;
const WINDOW_MANAGEMENT_EASING = cubicBezier(0.1, 0.9, 0.2, 1.0);
const WINDOW_OPEN_EASING = cubicBezier(0.1, 1.1, 0.1, 1.1);
const WINDOW_CLOSE_EASING = cubicBezier(0.3, -0.3, 0, 1);
const WINDOW_MINIMIZE_RECT_EASING = cubicBezier(0.3, -0.3, 0, 1);
const WINDOW_UNMINIMIZE_RECT_EASING = cubicBezier(0.1, 1.1, 0.1, 1.1);
const WINDOW_MINIMIZE_OPACITY_EASING = cubicBezier(0.3, -0.3, 0, 1);
const WINDOW_UNMINIMIZE_OPACITY_EASING = cubicBezier(0.1, 1.1, 0.1, 1.1);
export const TILE_ANIMATION_DURATION = seconds(0.5);
const WORKSPACE_SWITCH_ANIMATION_DURATION = seconds(0.5);
const WORKSPACE_GESTURE_FINGERS = 3;
const WORKSPACE_GESTURE_AXIS_LOCK_PX = 8;
const WORKSPACE_GESTURE_THRESHOLD_RATIO = 0.22;
const WORKSPACE_GESTURE_VELOCITY_THRESHOLD = 900;
const TILE_DRAG_WORKSPACE_EDGE_PX = 80;
const TILE_DRAG_WORKSPACE_SWITCH_INTERVAL_MS = 420;
const TILE_GAP = 12;
const TILE_MARGIN = 12;
// User-float (Win+A) placement: a fixed 1280x720 managed root rectangle,
// centered on the workspace and clamped to the usable area and the window's
// own size constraints.
const USER_FLOAT_WIDTH = 1280;
const USER_FLOAT_HEIGHT = 720;
// Floating directional movement step (Super+Shift+h/j/k/l on floats).
const FLOAT_MOVE_STEP_PX = 40;
const MANAGED_WINDOW_ONLY_REBUILD_SUPPRESSION = {
  allowManagedWindowOnly: true,
  onViolation: "fallback-last",
} as const;
const STRICT_MANAGED_WINDOW_ONLY_REBUILD_SUPPRESSION = {
  allowManagedWindowOnly: true,
  onViolation: "fallback",
} as const;
const MANAGED_WINDOW_ONLY_ANIMATION = {
  suppressSSDRebuild: true,
} as const;

// Windows-style edge snapping for floating drags. Distances are logical px.
//   - within SNAP_EDGE_PX of an edge triggers that edge's zone
//   - within SNAP_CORNER_PX of a corner (along both axes) triggers a quarter
//   - SNAP_GAP_PX is the gap left between adjacent halves/quarters
const SNAP_EDGE_PX = 16;
const SNAP_CORNER_PX = 140;
const SNAP_GAP_PX = 8;

// Lower MSI panel (2560x1440 at y=1440); the initial/fallback selected output.
const PREFERRED_DEFAULT_OUTPUT = "DP-3";


/** Monitor-local logical rect (relative to the monitor origin) for the bar. */
export interface SnapPreviewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SnapPreviewPayload {
  monitor: string;
  rect: SnapPreviewRect | null;
  kind: "floating" | "tiling";
}

export type SnapPreviewBroadcaster = (preview: SnapPreviewPayload) => void;
export type WorkspaceChangeBroadcaster = () => void;

type LayoutSnapZone = Exclude<SnapZone, "maximize">;
type SnapColumn = "left" | "right";

interface FloatingSnapLayout {
  splitX: number;
  leftSplitY: number;
  rightSplitY: number;
}

function markWindowCompositionDirty(window: WaylandWindow): void {
  markWindowDirty(window.id);
}

/**
 * A focus target must belong to the active workspace, be visually present and
 * not minimized. Outgoing transition windows still render but cannot receive
 * focus. Shared by focus selection and the `onFocus` acceptance guard.
 */
function isFocusableWindow(window: WaylandWindow): boolean {
  return (
    !window.state[WINDOW_STATE_MINIMIZED]() &&
    window.state[WINDOW_STATE_WORKSPACE_VISIBLE]() &&
    window.state[WINDOW_STATE_WORKSPACE_INPUT_ELIGIBLE]()
  );
}

interface LayoutOptions {
  suppressSSDRebuild?: boolean;
  animate?: boolean;
  preserveMissingActive?: boolean;
  cancelRectAnimations?: boolean;
  immediateFloatingWindowIds?: ReadonlySet<string>;
}

export interface HybridWindowManagerSnapshot {
  currentMonitor: string;
  activeWorkspaceByMonitor: [string, number][];
  workspaces: WorkspaceSnapshot[];
}

interface WorkspaceSnapshot {
  monitor: string;
  index: number;
  isTiled: boolean;
  activeWindowId: string | null;
  /** Binary split tree for the tiled mode; null for old snapshots (rebuilt
   * from live windows) and for floating workspaces. */
  tileLayout: TileLayoutNode | null;
  windows: WorkspaceWindowSnapshot[];
}

interface WorkspaceWindowSnapshot {
  id: string;
  floatingRect?: ManagedWindowRect | null;
  restoreRect?: ManagedWindowRect | null;
  snapZone?: SnapZone | null;
  snapMonitor?: string | null;
  minimized: boolean;
  maximized: boolean;
  fullscreen?: boolean;
  fullscreenRestoreRect?: ManagedWindowRect | null;
  userFloating?: boolean;
}

/**
 * Compact, serializable view of the workspace layout for external clients
 * (e.g. the bar) consumed over the IPC transport. Per-monitor so a per-output
 * bar can render just its own workspaces.
 */
export interface WorkspacesViewWindow {
  id: string;
  appId?: string;
  title: string;
  focused: boolean;
  /** epoch ms — most recent focus time for MRU ordering. 0 if never focused. */
  lastFocusedAt: number;
}

export interface WorkspacesViewWorkspace {
  index: number;
  windowCount: number;
  isTiled: boolean;
  active: boolean;
  windows: WorkspacesViewWindow[];
}

export interface WorkspacesViewMonitor {
  name: string;
  active: number;
  workspaces: WorkspacesViewWorkspace[];
}

export interface WorkspacesView {
  currentMonitor: string;
  monitors: WorkspacesViewMonitor[];
}

interface WorkspaceGestureState {
  monitor: string;
  currentIndex: number;
  direction: -1 | 1;
  distance: number;
  fromWorkspace: Workspace;
  toWorkspace: Workspace | null;
  fromOffsetY: number;
  toOffsetY: number;
  fromOpacity: number;
  toOpacity: number;
}

export interface WorkspaceGestureSpeedConfig {
  /**
   * Vertical three-finger swipe movement multiplier for workspace switching.
   */
  workspaceSwitchFactor?: number;
  /**
   * Vertical release velocity multiplier for deciding whether to commit a
   * workspace switch. Defaults to workspaceSwitchFactor when omitted.
   */
  workspaceSwitchVelocityFactor?: number;
}

interface ResolvedWorkspaceGestureSpeedConfig {
  workspaceSwitchFactor: number;
  workspaceSwitchVelocityFactor: number;
}

const DEFAULT_WORKSPACE_GESTURE_SPEED: ResolvedWorkspaceGestureSpeedConfig = {
  workspaceSwitchFactor: 1,
  workspaceSwitchVelocityFactor: 1,
};

function hotReloadDebugEnabled(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string> } })
    .process?.env;
  const value = env?.SHOJI_HOT_RELOAD_DEBUG;
  return value !== undefined && value !== "" && value !== "0";
}

function hotReloadDebug(
  message: string,
  details: Record<string, unknown> = {},
): void {
  if (!hotReloadDebugEnabled()) {
    return;
  }
  console.info(`hot-reload ${message}`, JSON.stringify(details));
}

function sanitizeGestureSpeedFactor(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

const OPEN_ANIMATION_CHANNEL = "window.open";
const CLOSE_ANIMATION_CHANNEL = "window.close";
const MINIMIZE_ANIMATION_CHANNEL = "window.minimize";
const WORKSPACE_VISUAL_ANIMATION_CHANNEL = "workspace.visual";
const WORKSPACE_VISUAL_RECT_ANIMATION_CHANNEL = `${WORKSPACE_VISUAL_ANIMATION_CHANNEL}.rect`;
const WORKSPACE_VISUAL_OPACITY_ANIMATION_CHANNEL = `${WORKSPACE_VISUAL_ANIMATION_CHANNEL}.opacity`;
export const WINDOW_BORDER_PX = 2;
export const TITLEBAR_HEIGHT = 30;
export const MAXIMIZED_WINDOW_PADDING = {
  top: 8,
  right: 8,
  bottom: 8,
  left: 8,
};

/**
 * Config-local readonly decoration footprint outside a window's root rect.
 * The config supplies a per-window callback (e.g. the selected Rainlit pack's
 * authored ornament outsets); the manager never imports the rainlit runtime.
 */
export interface WindowDecorationOutsets {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

const ZERO_DECORATION_OUTSETS: WindowDecorationOutsets = {
  left: 0,
  right: 0,
  top: 0,
  bottom: 0,
};

export class HybridWindowManager {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly activeWorkspaceByMonitor = new Map<string, number>();
  private readonly windowStack = createWindowStack();
  private readonly naturalRootRect: (rect: WaylandWindow) => ManagedWindowRect;
  private readonly decorationOutsetsFor: (
    window: WaylandWindow,
  ) => WindowDecorationOutsets;
  // Tracks MRU focus time per window id so the dock can pick "the most recent
  // window of an app" deterministically. Updated by recordFocus().
  private readonly lastFocusedAt = new Map<string, number>();
  private readonly pendingInitialFocusByWindowId = new Map<string, number>();
  private readonly initialFocusHandledWindowIds = new Set<string>();
  // Saved window id picked by restore() as the post-reload focus target; it is
  // focused exactly once, when that window has actually re-registered after a
  // hot reload. Existing windows are otherwise marked initial-focus-handled so
  // their replay cannot move focus first.
  private pendingReloadFocusWindowId: string | null = null;
  private readonly tileabilityByWindowId = new Map<string, boolean>();
  private readonly tileabilitySubscriptionsByWindowId = new Map<
    string,
    () => void
  >();
  private currentMonitor: string;
  // Output the user last stepped onto with the directional focus keys. When
  // that output has no focusable window, native window focus is cleared via
  // the nullable compositor focus API instead of leaving a stale focused
  // window behind; this marker keeps the next key press continuing from the
  // output actually navigated to. Real pointer motion or an accepted focus
  // event clears it.
  private keyboardNavigationMonitor: string | null = null;
  private isGrabbing = false;
  // Window id owning the in-flight interactive resize. Kept separate from
  // `isGrabbing` (movement) so focus-follows-pointer suppression and the
  // native max/full request guards can address resize grabs specifically.
  private resizingWindowId: string | null = null;
  private tileDrag: {
    window: WaylandWindow;
    workspace: Workspace;
    lastWorkspaceSwitchAt: number;
  } | null = null;
  private floatingDrag: {
    window: WaylandWindow;
    workspace: Workspace;
    lastWorkspaceSwitchAt: number;
  } | null = null;
  private maximizedMoveDrag: {
    windowId: string;
    width: number;
    height: number;
  } | null = null;
  private workspaceGesture: WorkspaceGestureState | null = null;
  /**
   * Axis locked by the active three-finger gesture. Horizontal gestures are
   * ignored outright (the scrolling ribbon is gone); only a vertically locked
   * gesture drives workspace switching.
   */
  private workspaceGestureAxis: "horizontal" | "vertical" | null = null;
  private workspaceGestureSpeed = { ...DEFAULT_WORKSPACE_GESTURE_SPEED };
  // Broadcasts the active snap-zone preview rect to external clients (the bar).
  private snapPreviewBroadcaster: SnapPreviewBroadcaster | null = null;
  private workspaceChangeBroadcaster: WorkspaceChangeBroadcaster | null = null;
  // Pending Windows-style snap decision for the in-flight floating drag.
  private floatingSnap: {
    windowId: string;
    monitor: string;
    zone: SnapZone;
    rect: ManagedWindowRect;
  } | null = null;

  public constructor(
    naturalRootRect: (rect: WaylandWindow) => ManagedWindowRect,
    decorationOutsetsFor: (
      window: WaylandWindow,
    ) => WindowDecorationOutsets = () => ZERO_DECORATION_OUTSETS,
  ) {
    this.currentMonitor = "";
    this.naturalRootRect = naturalRootRect;
    this.decorationOutsetsFor = decorationOutsetsFor;
    this.syncWorkspaces();
  }

  /** Per-window external decoration footprint (never null; zeros default). */
  private outsetsFor(window: WaylandWindow): WindowDecorationOutsets {
    return this.decorationOutsetsFor(window) ?? ZERO_DECORATION_OUTSETS;
  }

  public configureWorkspaceGestureSpeed(
    config: WorkspaceGestureSpeedConfig,
  ): void {
    const workspaceSwitchFactor = sanitizeGestureSpeedFactor(
      config.workspaceSwitchFactor,
      DEFAULT_WORKSPACE_GESTURE_SPEED.workspaceSwitchFactor,
    );
    this.workspaceGestureSpeed = {
      workspaceSwitchFactor,
      workspaceSwitchVelocityFactor: sanitizeGestureSpeedFactor(
        config.workspaceSwitchVelocityFactor,
        workspaceSwitchFactor,
      ),
    };
  }

  public onPointerMove(event: PointerMoveEvent) {
    // A zero-delta event (button/enter churn, or a window moving under a
    // stationary cursor) carries no new positional information: it must not
    // take selection ownership back from keyboard navigation nor re-run
    // follow-focus. Genuine motion and explicit focus still work.
    if (event.delta.x === 0 && event.delta.y === 0) {
      return;
    }
    // Real user navigation: a deferred reload focus grant must not fire later.
    this.cancelPendingReloadFocus();
    this.syncWorkspaces();
    this.currentMonitor = event.outputName ?? this.currentMonitor;
    // Real pointer motion takes focus ownership back from keyboard navigation.
    if (event.outputName) {
      this.keyboardNavigationMonitor = null;
    }
    this.focusWindowAtPointerTarget(event.target, event.outputName);
  }

  public onGestureSwipe(event: GestureSwipeEvent) {
    if (event.fingers !== WORKSPACE_GESTURE_FINGERS) {
      return;
    }

    this.cancelPendingReloadFocus();
    this.syncWorkspaces();

    if (event.phase === "begin") {
      this.workspaceGesture = null;
      this.workspaceGestureAxis = null;
      this.currentMonitor = this.gestureMonitor(event);
      return;
    }

    if (event.phase === "update") {
      // Horizontal gestures are ignored by the compositor: the scrolling
      // ribbon they panned no longer exists. Only a vertically locked
      // gesture switches workspaces.
      if (this.resolveWorkspaceGestureAxis(event) !== "vertical") {
        return;
      }
      this.updateWorkspaceGesture(event);
      return;
    }

    this.workspaceGestureAxis = null;
    this.finishWorkspaceGesture(event);
  }

  public onOutputChange(event: OutputChangeEvent) {
    const liveMonitors = new Set(
      event.outputs
        .filter((output) => output.enabled)
        .map((output) => output.name),
    );
    if (liveMonitors.size === 0) {
      return;
    }

    const preferred = this.preferredOutput();
    const fallbackMonitor =
      (this.currentMonitor && liveMonitors.has(this.currentMonitor)
        ? this.currentMonitor
        : undefined) ??
      (liveMonitors.has(preferred) ? preferred : undefined) ??
      Array.from(liveMonitors)[0];
    if (!fallbackMonitor) {
      return;
    }

    const orphanedWorkspaces = Array.from(this.workspaces.values()).filter(
      (workspace) => !liveMonitors.has(workspace.monitor),
    );
    if (orphanedWorkspaces.length === 0) {
      this.syncWorkspaces();
      this.refreshUsableAreaLayouts();
      return;
    }

    const orphanedActiveWorkspaceByMonitor = new Map(
      Array.from(this.activeWorkspaceByMonitor.entries()).filter(
        ([monitor]) => !liveMonitors.has(monitor),
      ),
    );

    for (const monitor of Array.from(this.activeWorkspaceByMonitor.keys())) {
      if (!liveMonitors.has(monitor)) {
        this.activeWorkspaceByMonitor.delete(monitor);
      }
    }

    for (const workspace of orphanedWorkspaces) {
      const oldKey = workspaceKey(workspace.monitor, workspace.index);
      this.workspaces.delete(oldKey);

      if (workspace.windowCount() === 0) {
        continue;
      }

      const targetMonitor = fallbackMonitor;
      const targetIndex = this.availableWorkspaceIndex(
        targetMonitor,
        workspace.index,
      );
      const wasActiveOnRemovedMonitor =
        orphanedActiveWorkspaceByMonitor.get(workspace.monitor) ===
        workspace.index;
      const destination = this.workspaces.get(workspaceKey(targetMonitor, targetIndex));
      if (destination && destination.windowCount() > 0) {
        // All ordinary slots may already be occupied; merge rather than invent
        // an eleventh slot or overwrite a workspace containing live windows.
        for (const window of workspace.listWindows()) {
          const moved = workspace.takeWindowForMove(window);
          if (!moved) {
            continue;
          }
          destination.addMovedWindow(window, {
            ...moved.snapshot,
            floatingRect: this.translateRectBetweenWorkspaces(moved.snapshot.floatingRect, workspace, destination, window),
            restoreRect: this.translateRectBetweenWorkspaces(moved.snapshot.restoreRect, workspace, destination, window),
            fullscreenRestoreRect: this.translateRectBetweenWorkspaces(moved.snapshot.fullscreenRestoreRect, workspace, destination, window),
            snapZone: null,
            snapMonitor: null,
          });
        }
      } else {
        workspace.moveToMonitor(targetMonitor, targetIndex);
        this.workspaces.set(workspaceKey(targetMonitor, targetIndex), workspace);
      }
      if (
        wasActiveOnRemovedMonitor ||
        !this.activeWorkspaceByMonitor.has(targetMonitor)
      ) {
        this.activeWorkspaceByMonitor.set(targetMonitor, targetIndex);
      }
      const targetWorkspace = this.ensureWorkspace(targetMonitor, targetIndex);
      targetWorkspace.setVisible(targetWorkspace.isActive());
      targetWorkspace.applyLayout({
        suppressSSDRebuild: false,
        animate: false,
        preserveMissingActive: true,
      });
    }

    if (!liveMonitors.has(this.currentMonitor)) {
      this.currentMonitor = fallbackMonitor;
    }
    this.syncWorkspaces();
    this.refreshUsableAreaLayouts();
    this.syncWorkspaceVisibility();
  }

  public onOpen(window: WaylandWindow) {
    this.trackWindowTileability(window);
    this.windowStack.add(window);

    window.setCloseAnimationDuration(OPEN_CLOSE_ANIMATION_DURATION);
  }

  private trackWindowTileability(window: WaylandWindow) {
    this.untrackWindowTileability(window.id);
    this.tileabilityByWindowId.set(
      window.id,
      window.isResizable.peek() && !window.isTransient.peek(),
    );

    const onChange = () => {
      const wasTileable = this.tileabilityByWindowId.get(window.id);
      const isTileable =
        window.isResizable.peek() && !window.isTransient.peek();
      if (wasTileable === undefined || wasTileable === isTileable) {
        return;
      }

      this.tileabilityByWindowId.set(window.id, isTileable);
      if (!isTileable) {
        this.pendingInitialFocusByWindowId.delete(window.id);
      }
      const workspace = this.findWorkspaceForWindow(window);
      if (!workspace) {
        return;
      }

      workspace.reclassifyWindow(window, wasTileable);
      this.applyWorkspaceStackPolicy(workspace);
    };

    const unsubscribeResizable = window.isResizable.subscribe(onChange);
    const unsubscribeTransient = window.isTransient.subscribe(onChange);
    this.tileabilitySubscriptionsByWindowId.set(window.id, () => {
      unsubscribeResizable();
      unsubscribeTransient();
    });
  }

  private untrackWindowTileability(windowId: string) {
    this.tileabilitySubscriptionsByWindowId.get(windowId)?.();
    this.tileabilitySubscriptionsByWindowId.delete(windowId);
    this.tileabilityByWindowId.delete(windowId);
  }

  public dispose() {
    for (const unsubscribe of this.tileabilitySubscriptionsByWindowId.values()) {
      unsubscribe();
    }
    this.tileabilitySubscriptionsByWindowId.clear();
    this.tileabilityByWindowId.clear();
    this.deferredInitialLayoutWindowIds.clear();
    this.initialFocusHandledWindowIds.clear();
  }

  private readonly restoredDuringInitialConfigure = new Set<string>();
  private readonly deferredInitialLayoutWindowIds = new Set<string>();

  /**
   * Windows that have presented at least one frame (`onFirstCommit`).
   *
   * A window's foreign-toplevel handle is created the moment the client makes
   * its `xdg_toplevel` — before it has committed a single buffer — so a dock
   * that focuses the window it just launched sends its `activate` while the
   * window is still invisible. Noctalia's dock does exactly this (it arms a
   * pending-launch-focus and activates as soon as a matching toplevel shows
   * up), and "launch or focus" docks generally behave the same way.
   *
   * Without this set the minimize-raise toggle read that launch hand-off as
   * "the user re-clicked the focused window's taskbar entry" and minimized a
   * window that had never been shown — apps appeared to launch straight into
   * the taskbar (issue #68). A taskbar entry the user can actually click
   * belongs, by definition, to a window that has already presented.
   */
  private readonly presentedWindowIds = new Set<string>();

  /**
   * When each window was last restored from minimized, by wall clock.
   *
   * sfwbar's taskbar click sends `unset_minimized` and `activate` as separate
   * requests in one flush (`foreign_toplevel_focus` → unset_minimized +
   * `foreign_toplevel_activate`, which sends unset_minimized + activate
   * again). By the time the activate handler runs, the unset_minimized has
   * already restored the window, so the `wasMinimized` guard in
   * `onWindowActivateRequest` sees an unminimized window — and since focus
   * never leaves a minimized window, the minimize-raise toggle read the
   * activate as "the user re-clicked the focused window's taskbar entry" and
   * re-minimized it (visible as a one-frame flash of the window).
   *
   * A restore and an activate that arrive within this grace period are one
   * gesture, never a toggle. Same-flush requests run back-to-back (< a few
   * ms); two intentional clicks are always further apart than this.
   */
  private readonly lastRestoreAtMs = new Map<string, number>();

  private initialWindowPlacement(window: WaylandWindow): {
    workspace: Workspace | undefined;
    silent: boolean;
  } {
    const restored = this.findWorkspaceRestoringWindow(window);
    if (restored) {
      return { workspace: restored, silent: true };
    }
    const parentId = window.parentId();
    const parent = parentId ? this.findWindowById(parentId) : undefined;
    const parentWorkspace = parent ? this.findWorkspaceForWindow(parent) : undefined;
    if (parentWorkspace) {
      return { workspace: parentWorkspace, silent: !parentWorkspace.isActive() };
    }
    const placement = windowPlacementFor(window.appId());
    if (placement) {
      const monitor =
        placement.monitor && COMPOSITOR.output.list.includes(placement.monitor)
          ? placement.monitor
          : this.getCurrentMonitorName();
      return {
        workspace: monitor ? this.ensureWorkspace(monitor, placement.index) : undefined,
        silent: placement.silent,
      };
    }
    return { workspace: this.getCurrentWorkspace(), silent: false };
  }

  private focusNewWindow(window: WaylandWindow): void {
    if (this.initialFocusHandledWindowIds.has(window.id)) {
      return;
    }
    this.initialFocusHandledWindowIds.add(window.id);
    // App ID and parent metadata arrive after role creation. Decide focus at
    // initial configure, not onOpen, so silent rules cannot queue a focus first.
    const { workspace, silent } = this.initialWindowPlacement(window);
    if (silent) {
      return;
    }
    if (workspace) {
      this.currentMonitor = workspace.monitor;
      this.switchWorkspaceTo(workspace.monitor, workspace.index, {
        focusActiveAfter: false,
      });
    }
    window.focus();
  }

  private initializeWindowLayout(window: WaylandWindow): {
    workspace: Workspace | undefined;
    restoredExistingWindow: boolean;
  } {
    const existingWorkspace = this.findWorkspaceForWindow(window);
    if (existingWorkspace) {
      return {
        workspace: existingWorkspace,
        restoredExistingWindow: this.restoredDuringInitialConfigure.has(
          window.id,
        ),
      };
    }

    let restoredExistingWindow = false;
    const { workspace, silent } = this.initialWindowPlacement(window);
    if (workspace) {
      restoredExistingWindow = workspace.addWindow(window, { activate: !silent });
      if (
        !restoredExistingWindow &&
        !silent &&
        workspace.isTiled &&
        workspace.isTileCandidate(window)
      ) {
        this.trackPendingInitialFocus(window);
      }
      if (
        restoredExistingWindow &&
        !workspace.isTiled &&
        isLayoutSnapZone(window.state[WINDOW_STATE_SNAP_ZONE]())
      ) {
        // A restored snapped float replays its saved root rect. Re-derive
        // the snap layout from the registered roots and re-apply the current
        // outsets once: boundaries are computed from the roots themselves,
        // so the roots stay where the snapshot put them and the derivation
        // is idempotent across later reloads (no double inset).
        this.refreshSnappedFloatingLayouts();
      }
      this.applyWorkspaceStackPolicy(workspace);
      this.syncWorkspaceVisibility();
    } else {
      window.state[WINDOW_STATE_RECT].set(this.naturalRootRect(window));
    }

    if (window.isMaximized()) {
      window.state[WINDOW_STATE_RESTORE_RECT].set(
        this.initialRestoreRectForMaximizedWindow(window),
      );
      window.state[WINDOW_STATE_RECT].set(this.maximizedRectForWindow(window));
      window.state[WINDOW_STATE_MAXIMIZED].set(true);
    }

    // A window that is already fullscreen when it joins keeps the fullscreen
    // rect. xwayland-satellite requests fullscreen at creation for an X window
    // sized like the output, and that request lands before the first commit,
    // so `onWindowFullscreenRequest` has already run — but `addWindow` above
    // just placed the window at its centered/floating rect, and that went out
    // as a Fullscreen configure carrying a windowed size (960x676 for a
    // 1600x1000 output). SDL2 treats a fullscreen configure at the wrong size
    // as a failed switch and leaves fullscreen ~1s later, which is why the
    // first entry into fullscreen only sometimes took.
    if (window.state[WINDOW_STATE_FULLSCREEN]() || window.isFullscreen()) {
      const fullscreenRect = this.fullscreenRectForWindow(window);
      window.state[WINDOW_STATE_FULLSCREEN].set(true);
      stopRectAnimation(window, WINDOW_STATE_RECT);
      window.state[WINDOW_STATE_RECT].set(fullscreenRect);
      workspace?.syncFloatingWindowRect(window, fullscreenRect);
    }

    if (restoredExistingWindow) {
      this.restoredDuringInitialConfigure.add(window.id);
    }
    return { workspace, restoredExistingWindow };
  }

  public onInitialConfigure(window: WaylandWindow) {
    this.focusNewWindow(window);
    if (this.shouldDeferInitialWindowLayout(window)) {
      this.deferredInitialLayoutWindowIds.add(window.id);
      return;
    }

    this.deferredInitialLayoutWindowIds.delete(window.id);
    const { workspace, restoredExistingWindow } =
      this.initializeWindowLayout(window);
    hotReloadDebug("hybrid-initial-configure", {
      windowId: window.id,
      title: window.title.peek(),
      workspace: workspace
        ? { monitor: workspace.monitor, index: workspace.index }
        : null,
      restoredExistingWindow,
      rect: window.state[WINDOW_STATE_RECT](),
    });
  }

  private shouldDeferInitialWindowLayout(window: WaylandWindow): boolean {
    if (this.findWorkspaceRestoringWindow(window)) {
      return false;
    }

    // Maximized/fullscreen windows need an output-sized initial configure.
    if (window.isMaximized.peek() || window.isFullscreen.peek()) {
      return false;
    }

    // In floating mode, the client must choose its remembered or natural size
    // before the window can be centered. Applying the fallback rect to the
    // initial configure would overwrite that size and can make fixed-size
    // dialogs temporarily huge.
    if (this.initialWindowPlacement(window).workspace?.isTiled !== true) {
      return true;
    }

    // A floating window must commit its natural client size before it can be
    // centered. Using the pre-commit geometry here feeds the degenerate-size
    // fallback into the initial configure and makes fixed-size dialogs huge.
    if (!window.isResizable.peek() || window.isTransient.peek()) {
      return true;
    }

    // With no min/max constraints, Wayland cannot yet distinguish an
    // unconstrained tiled window from a client that will declare a fixed size
    // on its first frame.
    return !this.hasInitialTileabilityDecision(window);
  }

  private hasInitialTileabilityDecision(window: WaylandWindow): boolean {
    const constraints = window.sizeConstraints.peek();
    return constraints.min != null || constraints.max != null;
  }

  public snapshot(): HybridWindowManagerSnapshot {
    const snapshot = {
      currentMonitor: this.currentMonitor,
      activeWorkspaceByMonitor: Array.from(
        this.activeWorkspaceByMonitor.entries(),
      ),
      workspaces: Array.from(this.workspaces.values()).map((workspace) =>
        workspace.snapshot(),
      ),
    };
    hotReloadDebug("hybrid-snapshot", {
      currentMonitor: snapshot.currentMonitor,
      workspaceCount: snapshot.workspaces.length,
      workspaces: snapshot.workspaces.map((workspace) => ({
        monitor: workspace.monitor,
        index: workspace.index,
        isTiled: workspace.isTiled,
        activeWindowId: workspace.activeWindowId,
        windowIds: workspace.windows.map((window) => window.id),
      })),
    });
    return snapshot;
  }

  public restore(snapshot: HybridWindowManagerSnapshot) {
    hotReloadDebug("hybrid-restore", {
      currentMonitor: snapshot.currentMonitor,
      workspaceCount: snapshot.workspaces.length,
      workspaces: snapshot.workspaces.map((workspace) => ({
        monitor: workspace.monitor,
        index: workspace.index,
        isTiled: workspace.isTiled,
        activeWindowId: workspace.activeWindowId,
        windowIds: workspace.windows.map((window) => window.id),
      })),
    });
    // The lower MSI panel is the explicit selection after a reload: replaying
    // saved windows must not drag currentMonitor to whichever workspace
    // re-registers first. Existing windows are marked initial-focus-handled so
    // `focusNewWindow` leaves them alone; the selected workspace's focus target
    // is focused once it actually re-registers (see
    // `maybeFocusPendingReloadTarget`).
    this.currentMonitor = this.preferredOutput();
    // Claim the selected output for the next directional/digit command as
    // well, so a replayed focus for a saved window on the other panel cannot
    // take navigation ownership while the reload target is still pending.
    this.keyboardNavigationMonitor = this.currentMonitor;
    this.activeWorkspaceByMonitor.clear();
    for (const [monitor, index] of snapshot.activeWorkspaceByMonitor) {
      this.activeWorkspaceByMonitor.set(monitor, this.restoredWorkspaceIndex(index));
    }
    this.workspaces.clear();
    const restored = new Map<string, WorkspaceSnapshot>();
    for (const saved of snapshot.workspaces) {
      const index = this.restoredWorkspaceIndex(saved.index);
      const key = workspaceKey(saved.monitor, index);
      const previous = restored.get(key);
      restored.set(key, previous
        ? {
            ...previous,
            tileLayout: null,
            windows: [...previous.windows, ...saved.windows],
          }
        : { ...saved, index });
    }
    for (const saved of restored.values()) {
      for (const window of saved.windows) {
        this.initialFocusHandledWindowIds.add(window.id);
      }
      this.ensureWorkspace(saved.monitor, saved.index).restore(saved);
    }

    this.pendingReloadFocusWindowId = this.reloadFocusTargetId(restored);
    if (!this.pendingReloadFocusWindowId) {
      // Selected workspace is empty (or all its saved windows are minimized):
      // clear native window focus without electing another output.
      COMPOSITOR.window.focus(null);
    }
  }

  /**
   * Id of the window that should own focus after a reload: the saved active
   * window of the selected output's active workspace when it is a valid
   * (non-minimized) target, otherwise the first non-minimized window there.
   * `null` means the selected workspace has no focusable window.
   */
  private reloadFocusTargetId(
    restored: ReadonlyMap<string, WorkspaceSnapshot>,
  ): string | null {
    const monitor = this.currentMonitor;
    const index = this.activeWorkspaceByMonitor.get(monitor) ?? 1;
    const saved = restored.get(workspaceKey(monitor, index));
    if (!saved) {
      return null;
    }
    const active = saved.activeWindowId
      ? saved.windows.find(
          (window) => window.id === saved.activeWindowId && !window.minimized,
        )
      : undefined;
    return (
      active?.id ??
      saved.windows.find((window) => !window.minimized)?.id ??
      null
    );
  }

  private restoredWorkspaceIndex(index: number): number {
    return isSpecialWorkspaceIndex(index)
      ? index
      : Number.isFinite(index)
        ? clamp(Math.round(index), 1, WORKSPACES_PER_OUTPUT)
        : 1;
  }

  public onFirstCommit(window: WaylandWindow) {
    this.presentedWindowIds.add(window.id);
    if (!this.tileabilityByWindowId.has(window.id)) {
      this.trackWindowTileability(window);
    }
    if (!this.windowStack.has(window)) {
      this.windowStack.add(window, { at: "back" });
    }
    window.setCloseAnimationDuration(OPEN_CLOSE_ANIMATION_DURATION);
    this.focusNewWindow(window);

    this.deferredInitialLayoutWindowIds.delete(window.id);
    const initialized = this.initializeWindowLayout(window);
    const restoredDuringInitialConfigure =
      this.restoredDuringInitialConfigure.delete(window.id);
    const restoredExistingWindow =
      initialized.restoredExistingWindow || restoredDuringInitialConfigure;
    const workspace = initialized.workspace;
    if (!restoredExistingWindow && workspace?.isActive()) {
      scheduleOpenAnimation(window);
    }
    hotReloadDebug("hybrid-first-commit", {
      windowId: window.id,
      title: window.title.peek(),
      workspace: workspace
        ? { monitor: workspace.monitor, index: workspace.index }
        : null,
      restoredExistingWindow,
      scheduledOpenAnimation: !restoredExistingWindow && workspace?.isActive(),
    });
    this.maybeFocusPendingReloadTarget(window);
  }

  /**
   * Focuses the post-reload target exactly once, when it actually
   * re-registers. `restore()` marks existing windows initial-focus-handled so
   * this is the only replay focus grant, and it lands on the selected output's
   * active workspace.
   */
  private maybeFocusPendingReloadTarget(window: WaylandWindow): void {
    if (this.pendingReloadFocusWindowId !== window.id) {
      return;
    }
    const workspace = this.findWorkspaceForWindow(window);
    if (!workspace || !workspace.isActive()) {
      return;
    }
    // Re-assert the selected output, in case a replayed focus event for a
    // saved window on the other panel moved currentMonitor first.
    this.currentMonitor = workspace.monitor;
    if (read(window.isFocused)) {
      // Already focused natively: no focus event will follow, so resolve the
      // pending selection here.
      this.pendingReloadFocusWindowId = null;
      return;
    }
    window.focus();
  }

  /**
   * Drops a pending post-reload focus selection when the user navigates
   * (pointer motion or an explicit focus/workspace command), so a deferred
   * reload focus grant can never steal focus later. Bounded state, no timeout.
   */
  private cancelPendingReloadFocus(): void {
    this.pendingReloadFocusWindowId = null;
  }

  public onStartClose(window: WaylandWindow) {
    scheduleCloseAnimation(window);

    for (const workspace of this.workspaces.values()) {
      const nextFocus = workspace.removeWindow(window);
      if (nextFocus !== undefined) {
        workspace.applyLayout();
        nextFocus?.focus();
        break;
      }
    }
    this.syncWorkspaceVisibility();
  }

  public onClose(window: WaylandWindow) {
    this.presentedWindowIds.delete(window.id);
    this.lastRestoreAtMs.delete(window.id);
    if (this.resizingWindowId === window.id) {
      this.resizingWindowId = null;
    }
    this.restoredDuringInitialConfigure.delete(window.id);
    this.deferredInitialLayoutWindowIds.delete(window.id);
    this.pendingInitialFocusByWindowId.delete(window.id);
    if (this.pendingReloadFocusWindowId === window.id) {
      this.pendingReloadFocusWindowId = null;
    }
    this.initialFocusHandledWindowIds.delete(window.id);
    this.untrackWindowTileability(window.id);
    this.windowStack.remove(window);
    for (const workspace of this.workspaces.values()) {
      if (workspace.removeWindow(window) !== undefined) {
        workspace.applyLayout();
      }
    }
    this.syncWorkspaceVisibility();
    // `window.state[...]` (used for e.g. WINDOW_STATE_RECT, minimized, etc.)
    // is backed by a module-level `signalsByWindowId` map in window-state.ts
    // keyed by window id. Nothing else clears that entry when a window
    // closes, so every window ever opened accumulates its own permanent
    // entry there for the lifetime of the compositor process. This doesn't
    // explain GPU/VRAM growth (that's the native closing-snapshot leak,
    // fixed on the Rust side), but it's the same class of bug on the JS
    // heap and should be cleaned up alongside it.
    dropWindowState(window.id);
  }

  /**
   * Handles a native focus change. Returns true when the event was accepted as
   * a legitimate focus of a visible window on an active workspace. Focus
   * events for hidden special slots, inactive workspaces and minimized windows
   * are ignored: they must not take selection ownership, update MRU or raise
   * the window (e.g. a replayed focus on a hidden workspace, or native prune
   * electing a visible window elsewhere).
   */
  public onFocus(window: WaylandWindow, focused: boolean): boolean {
    if (!focused) {
      return false;
    }
    const workspace = this.findWorkspaceForWindow(window);
    if (workspace && !this.isActiveFocusableWindow(workspace, window)) {
      return false;
    }
    if (this.pendingReloadFocusWindowId !== null) {
      if (window.id !== this.pendingReloadFocusWindowId) {
        // On a recreated window `emitFocus(snapshot.isFocused)` fires before
        // `emitFirstCommit`, so a saved window on the other panel can replay
        // its old focus while the reload selection is still pending. Ignore it
        // rather than let it take ownership.
        return false;
      }
      // The desired post-reload window is live: the selection is resolved and
      // normal focus handling resumes.
      this.pendingReloadFocusWindowId = null;
    }
    // Any accepted focus event (pointer, keyboard, transfer) takes navigation
    // ownership back, so the marker cannot outlive its output.
    this.keyboardNavigationMonitor = null;
    // Keyboard focus — including focus driven by directional keys, Alt+Tab
    // and window transfers — owns currentMonitor, not only pointer motion.
    if (workspace && COMPOSITOR.output.list.includes(workspace.monitor)) {
      this.currentMonitor = workspace.monitor;
    }
    this.windowStack.raise(window);
    if (this.shouldDeferFocusLayoutForInitialOpen(window, workspace)) {
      this.applyWorkspaceStackPolicy(workspace);
      return true;
    }
    if (workspace?.isTiled && workspace.isActive()) {
      workspace.focusWindow(window);
      this.applyWorkspaceStackPolicy(workspace);
    }
    return true;
  }

  /** A window on its own active workspace that is visible and not minimized. */
  private isActiveFocusableWindow(
    workspace: Workspace,
    window: WaylandWindow,
  ): boolean {
    return workspace.isActive() && isFocusableWindow(window);
  }

  public onWindowResize(event: WindowResizeEvent) {
    if (!read(event.window.isResizable)) {
      // Resizability dropped mid-grab: release ownership so nothing strands
      // on a window that can no longer be resized.
      if (this.resizingWindowId === event.window.id) {
        this.resizingWindowId = null;
      }
      return;
    }
    if (event.phase === "start") {
      this.resizingWindowId = event.window.id;
    }

    const workspace = this.findWorkspaceForWindow(event.window);
    if (event.phase === "start" || event.phase === "update") {
      this.beginInteractiveUnmaximize(event.window);
    }

    if (workspace?.isTiled && workspace.isTileCandidate(event.window)) {
      if (event.phase === "end" || event.phase === "cancel") {
        this.resizingWindowId = null;
      }
      workspace.resizeTile(event);
      this.applyWorkspaceStackPolicy(workspace);
      return;
    }

    if (event.phase === "end" || event.phase === "cancel") {
      this.resizingWindowId = null;
    }
    const nextRect = this.constrainResizeRect(event);
    if (
      workspace &&
      this.resizeFloatingSnapLayout(event, workspace, nextRect)
    ) {
      this.applyWorkspaceStackPolicy(workspace);
      return;
    }

    stopRectAnimation(event.window, WINDOW_STATE_RECT);
    event.window.state[WINDOW_STATE_RECT].set(nextRect);
    workspace?.syncFloatingWindowRect(event.window, nextRect);
    this.applyWorkspaceStackPolicy(workspace);
  }

  public onWindowMove(event: WindowMoveEvent) {
    const workspace = this.findWorkspaceForWindow(event.window);
    if (workspace?.isTiled && workspace.isTileCandidate(event.window)) {
      this.onTileWindowMove(event, workspace);
      this.applyWorkspaceStackPolicy(workspace);
      return;
    }

    if (workspace) {
      this.onFloatingWindowMove(event, workspace);
      return;
    }

    const window = event.window;
    if (event.phase === "start" && window.state[WINDOW_STATE_MAXIMIZED]()) {
      const restoreRect =
        window.state[WINDOW_STATE_RESTORE_RECT]() ?? event.currentRect;
      this.maximizedMoveDrag = {
        windowId: window.id,
        width: read(restoreRect.width),
        height: read(restoreRect.height),
      };
      this.beginInteractiveUnmaximize(window);
    }
    if (event.phase === "start") {
      this.isGrabbing = true;
      this.clearWindowSnapState(window);
    }

    const maximizedMoveDrag =
      this.maximizedMoveDrag?.windowId === window.id
        ? this.maximizedMoveDrag
        : null;
    if (maximizedMoveDrag) {
      const nextRect = this.restoreRectForMaximizedMove(
        event,
        maximizedMoveDrag.width,
        maximizedMoveDrag.height,
      );
      if (event.phase === "start") {
        playRectAnimation(
          window,
          WINDOW_STATE_RECT,
          nextRect,
          WINDOW_MANAGEMENT_EASING,
          UNMAXIMIZE_GRAB_ANIMATION_DURATION,
        );
      } else {
        stopRectAnimation(window, WINDOW_STATE_RECT);
        window.state[WINDOW_STATE_RECT].set(nextRect);
      }
      if (event.phase === "end") {
        this.isGrabbing = false;
        this.maximizedMoveDrag = null;
        this.finishFloatingDragSnap(event, workspace);
      } else if (event.phase === "cancel") {
        this.isGrabbing = false;
        this.maximizedMoveDrag = null;
        this.finishFloatingDragSnap(event, workspace);
      } else {
        this.updateFloatingDragSnap(event);
      }
      return;
    }

    if (event.phase === "end" || event.phase === "cancel") {
      this.isGrabbing = false;
      const snapped = this.finishFloatingDragSnap(event, workspace);
      if (!snapped) {
        stopRectAnimation(window, WINDOW_STATE_RECT);
        window.state[WINDOW_STATE_RECT].set(event.currentRect);
      }
      this.applyWorkspaceStackPolicy(workspace);
      return;
    }

    this.updateFloatingDragSnap(event);
    stopRectAnimation(window, WINDOW_STATE_RECT);
    window.state[WINDOW_STATE_RECT].set(event.currentRect);
    this.applyWorkspaceStackPolicy(workspace);
  }

  private onFloatingWindowMove(event: WindowMoveEvent, workspace: Workspace) {
    const window = event.window;
    if (
      event.phase === "start" ||
      !this.floatingDrag ||
      this.floatingDrag.window.id !== window.id
    ) {
      this.isGrabbing = true;
      this.floatingDrag = {
        window,
        workspace,
        lastWorkspaceSwitchAt: event.timestamp,
      };
      if (window.state[WINDOW_STATE_MAXIMIZED]()) {
        const restoreRect =
          window.state[WINDOW_STATE_RESTORE_RECT]() ?? event.currentRect;
        this.maximizedMoveDrag = {
          windowId: window.id,
          width: read(restoreRect.width),
          height: read(restoreRect.height),
        };
        this.beginInteractiveUnmaximize(window);
      }
      this.clearWindowSnapState(window);
    }

    const drag = this.floatingDrag;
    if (!drag) {
      return;
    }

    const maximizedMoveDrag =
      this.maximizedMoveDrag?.windowId === window.id
        ? this.maximizedMoveDrag
        : null;
    const nextRect: ManagedWindowRect = maximizedMoveDrag
      ? this.restoreRectForMaximizedMove(
          event,
          maximizedMoveDrag.width,
          maximizedMoveDrag.height,
        )
      : event.currentRect;

    if (maximizedMoveDrag && event.phase === "start") {
      playRectAnimation(
        window,
        WINDOW_STATE_RECT,
        nextRect,
        WINDOW_MANAGEMENT_EASING,
        UNMAXIMIZE_GRAB_ANIMATION_DURATION,
      );
    } else {
      stopRectAnimation(window, WINDOW_STATE_RECT);
      window.state[WINDOW_STATE_RECT].set(nextRect);
    }

    if (event.phase !== "cancel") {
      const targetWorkspace = this.workspaceForFloatingDrag(event, drag);
      if (targetWorkspace !== drag.workspace) {
        drag.workspace.removeFloatingWindow(window);
        drag.workspace.applyLayout();
        if (targetWorkspace.isTiled && targetWorkspace.isTileCandidate(window)) {
          this.clearFloatingSnapPreview();
          targetWorkspace.adoptTileDragWindow(window, nextRect);
          drag.workspace = targetWorkspace;
          this.floatingDrag = null;
          this.tileDrag = {
            window,
            workspace: targetWorkspace,
            lastWorkspaceSwitchAt: event.timestamp,
          };
          this.syncWorkspaceVisibility();
          targetWorkspace.updateTileDrag(
            window,
            nextRect,
            event.currentPointer.x,
            event.currentPointer.y,
          );
          this.emitSnapPreview(
            targetWorkspace.monitor,
            targetWorkspace.draggingSlotRect(),
            "tiling",
          );
          this.applyWorkspaceStackPolicy(targetWorkspace);
          if (event.phase === "end") {
            targetWorkspace.endTileDrag(window, false);
            this.tileDrag = null;
            this.maximizedMoveDrag = null;
            this.isGrabbing = false;
          }
          window.focus();
          return;
        }
        targetWorkspace.adoptFloatingWindow(window, nextRect);
        drag.workspace = targetWorkspace;
        this.syncWorkspaceVisibility();
        window.focus();
      } else {
        targetWorkspace.syncFloatingWindowRect(window, nextRect);
      }

      this.applyWorkspaceStackPolicy(targetWorkspace);
      this.updateFloatingDragSnap(event);
    }

    if (event.phase === "end" || event.phase === "cancel") {
      const snapped = this.finishFloatingDragSnap(event, drag.workspace);
      if (!snapped) {
        stopRectAnimation(window, WINDOW_STATE_RECT);
        window.state[WINDOW_STATE_RECT].set(nextRect);
        drag.workspace.syncFloatingWindowRect(window, nextRect);
      }
      this.applyWorkspaceStackPolicy(drag.workspace);
      this.floatingDrag = null;
      if (maximizedMoveDrag) {
        this.maximizedMoveDrag = null;
      }
      this.isGrabbing = false;
    }
  }

  private onTileWindowMove(event: WindowMoveEvent, workspace: Workspace) {
    const window = event.window;
    if (
      event.phase === "start" ||
      !this.tileDrag ||
      this.tileDrag.window.id !== window.id
    ) {
      this.isGrabbing = true;
      workspace.beginTileDrag(window, event.currentRect);
      this.tileDrag = {
        window,
        workspace,
        lastWorkspaceSwitchAt: event.timestamp,
      };
    }

    const drag = this.tileDrag;
    if (!drag) {
      return;
    }

    if (event.phase === "end" || event.phase === "cancel") {
      this.emitSnapPreview(drag.workspace.monitor, null, "tiling");
      drag.workspace.endTileDrag(window, event.phase === "cancel");
      this.tileDrag = null;
      this.isGrabbing = false;
      return;
    }

    let targetWorkspace = this.workspaceForTileDrag(event, drag);
    if (targetWorkspace !== drag.workspace) {
      this.emitSnapPreview(drag.workspace.monitor, null, "tiling");
      drag.workspace.removeTileDragWindow(window);
      drag.workspace.applyLayout();
      if (!targetWorkspace.isTiled || !targetWorkspace.isTileCandidate(window)) {
        window.state[WINDOW_STATE_TILE_DRAGGING].set(false);
        targetWorkspace.adoptFloatingWindow(window, event.currentRect);
        this.tileDrag = null;
        this.floatingDrag = {
          window,
          workspace: targetWorkspace,
          lastWorkspaceSwitchAt: event.timestamp,
        };
        this.syncWorkspaceVisibility();
        this.applyWorkspaceStackPolicy(targetWorkspace);
        this.updateFloatingDragSnap(event);
        return;
      }
      targetWorkspace.adoptTileDragWindow(window, event.currentRect);
      drag.workspace = targetWorkspace;
      this.syncWorkspaceVisibility();
    }

    targetWorkspace.updateTileDrag(
      window,
      event.currentRect,
      event.currentPointer.x,
      event.currentPointer.y,
    );
    this.emitSnapPreview(
      targetWorkspace.monitor,
      targetWorkspace.draggingSlotRect(),
      "tiling",
    );
  }

  public onWindowMaximizeRequest(event: WindowMaximizeRequestEvent) {
    const workspace = this.findWorkspaceForWindow(event.window);
    // During an interactive drag of this window the manager owns the state
    // transitions (resize unmaximize goes through beginInteractiveUnmaximize);
    // a native maximize/unmaximize request arriving mid-grab is suppressed.
    if (this.isGrabbing || this.resizingWindowId === event.window.id) {
      return;
    }

    const window = event.window;
    window.state[WINDOW_STATE_MINIMIZED].set(false);
    this.clearWindowSnapState(window);

    if (workspace?.isTiled && workspace.isTileCandidate(window)) {
      if (!event.maximized) {
        window.state[WINDOW_STATE_RESTORE_RECT].set(null);
        window.state[WINDOW_STATE_MAXIMIZED].set(false);
        workspace.applyLayout();
        this.applyWorkspaceStackPolicy(workspace);
        return;
      }

      window.state[WINDOW_STATE_RESTORE_RECT].set(null);
      window.state[WINDOW_STATE_MAXIMIZED].set(true);
      // The maximized window's leaf now covers the whole usable area; the
      // layout pass applies the maximized rect and keeps the split tree
      // intact underneath.
      workspace.focusWindow(window);
      workspace.applyLayout();
      this.applyWorkspaceStackPolicy(workspace);
      window.focus();
      return;
    }

    // While fullscreen, the fullscreen rect owns the window: only track the
    // maximized flag here and leave the geometry alone. SDL2 (Unity/Source
    // games via xwayland-satellite) drops _NET_WM_STATE_MAXIMIZED the moment
    // it enters fullscreen, which arrived here as an unmaximize a few ms after
    // the fullscreen request and animated the fullscreen window back to its
    // pre-maximize rect — fullscreen "on" with the shell showing through.
    // `onWindowFullscreenRequest(false)` picks the maximized rect back up
    // when the flag is still set on the way out.
    if (window.state[WINDOW_STATE_FULLSCREEN]()) {
      if (event.maximized && !window.state[WINDOW_STATE_MAXIMIZED]()) {
        const fullscreenRestoreRect =
          window.state[WINDOW_STATE_FULLSCREEN_RESTORE_RECT]();
        if (fullscreenRestoreRect) {
          window.state[WINDOW_STATE_RESTORE_RECT].set(fullscreenRestoreRect);
        }
      }
      if (!event.maximized) {
        window.state[WINDOW_STATE_RESTORE_RECT].set(null);
      }
      window.state[WINDOW_STATE_MAXIMIZED].set(event.maximized);
      return;
    }

    if (!event.maximized) {
      const restoreRect = window.state[WINDOW_STATE_RESTORE_RECT]();
      if (restoreRect) {
        workspace?.syncFloatingWindowRect(window, restoreRect);
        playRectAnimation(
          window,
          WINDOW_STATE_RECT,
          restoreRect,
          WINDOW_MANAGEMENT_EASING,
          WINDOW_MANAGEMENT_ANIMATION_DURATION,
        );
      }
      window.state[WINDOW_STATE_RESTORE_RECT].set(null);
      window.state[WINDOW_STATE_MAXIMIZED].set(false);
      return;
    }

    if (!window.state[WINDOW_STATE_MAXIMIZED]()) {
      const currentRect = window.state[WINDOW_STATE_RECT]();
      const currentWidth = read(currentRect.width);
      const currentHeight = read(currentRect.height);
      if (currentWidth > 1 && currentHeight > 1) {
        window.state[WINDOW_STATE_RESTORE_RECT].set(currentRect);
      }
    }
    const maximizedRect = this.maximizedRectForWindow(window);
    workspace?.syncFloatingWindowRect(window, maximizedRect);
    playRectAnimation(
      window,
      WINDOW_STATE_RECT,
      maximizedRect,
      WINDOW_MANAGEMENT_EASING,
      WINDOW_MANAGEMENT_ANIMATION_DURATION,
    );
    window.state[WINDOW_STATE_MAXIMIZED].set(true);
    this.applyWorkspaceStackPolicy(workspace);
  }

  public onWindowMinimizeRequest(event: WindowMinimizeRequestEvent) {
    // A fullscreen window has no minimize button, so a client-originated
    // minimize while fullscreen is never the user: it is the X11 focus-loss
    // reflex of game toolkits (GLFW's GLFW_AUTO_ICONIFY, SDL2's
    // SDL_HINT_VIDEO_MINIMIZE_ON_FOCUS_LOSS) arriving through
    // xwayland-satellite as WM_CHANGE_STATE → set_minimized the instant the
    // window loses X input focus — which under a workspace model happens on
    // every workspace switch, on every X11 popup another app opens (Steam
    // notifications) and on every satellite unfocus. Honoring it dropped the
    // game out of its workspace: coming back showed nothing until a taskbar
    // click, and the reflex also fired mid-toggle so fullscreen ended up
    // "on" with the window minimized. Wayland-native games have no such
    // reflex; give X11 games the same behaviour. Taskbar/keybind minimizes
    // carry other sources and still work.
    if (
      event.minimized &&
      event.source === "client-csd" &&
      event.window.state[WINDOW_STATE_FULLSCREEN]()
    ) {
      hotReloadDebug("minimize-request-ignored-fullscreen", {
        windowId: event.window.id,
        appId: event.window.appId(),
        focused: event.window.isFocused(),
      });
      return;
    }
    const wasMinimized = event.window.state[WINDOW_STATE_MINIMIZED]();
    const workspace = this.findWorkspaceForWindow(event.window);
    if (wasMinimized !== event.minimized) {
      stopRectAnimation(event.window, WINDOW_STATE_RECT);
      if (!event.minimized) {
        this.lastRestoreAtMs.set(event.window.id, Date.now());
        event.window.state[WINDOW_STATE_MINIMIZE_VISUAL_IDLE].set(false);
      }
      event.window.state[WINDOW_STATE_MINIMIZED].set(event.minimized);
      if (event.minimized) {
        event.window.state[WINDOW_STATE_MINIMIZE_VISUAL_IDLE].set(true);
      }
      markWindowCompositionDirty(event.window);
      scheduleMinimizeAnimation(event.window, event.minimized);
    }
    if (workspace?.isTiled) {
      if (event.minimized) {
        // A minimized window holds no slot: remove its leaf from the split
        // tree so the remaining tiles close the gap.
        workspace.removeWindowTile(event.window);
      } else if (
        workspace.shouldTile(event.window) &&
        !event.window.state[WINDOW_STATE_USER_FLOATING]()
      ) {
        // Restored from minimized: re-insert the leaf after the focused one.
        workspace.insertWindowTile(event.window);
        workspace.focusWindow(event.window);
      }
      workspace.applyLayout();
      this.applyWorkspaceStackPolicy(workspace);
    }
  }

  public onWindowActivateRequest(event: WindowActivateRequestEvent) {
    this.cancelPendingReloadFocus();
    // A dock's pending launch activation must not undo silent initial placement.
    if (
      !this.presentedWindowIds.has(event.window.id) &&
      this.initialWindowPlacement(event.window).silent
    ) {
      return;
    }
    const wasMinimized = event.window.state[WINDOW_STATE_MINIMIZED]();
    if (wasMinimized) {
      this.onWindowMinimizeRequest({
        window: event.window,
        minimized: false,
        source:
          event.source === "xdg-activation" ||
          event.source === "xwayland" ||
          event.source === "keybind"
            ? event.source
            : "api",
        timestamp: event.timestamp,
      });
    }
    const workspace = this.findWorkspaceForWindow(event.window);
    // Minimize-raise toggle: dock/taskbar sources only. xdg-activation and
    // xwayland activations come from applications raising themselves
    // (notification clicks, "open link" handoffs) — minimizing there would
    // hide the window the app is trying to show.
    if (
      !wasMinimized &&
      event.source !== "xdg-activation" &&
      event.source !== "xwayland" &&
      event.source !== "keybind" &&
      this.minimizeOnReactivate(event.window, workspace)
    ) {
      return;
    }
    if (workspace) {
      // If the window is on another workspace, switch with the same
      // slide/fade animation as keyboard/gesture switching (no-op if same).
      this.switchWorkspaceTo(workspace.monitor, workspace.index, {
        focusActiveAfter: false,
      });
    }
    // Focus the target window after switching (overrides switchWorkspaceTo's focusActiveWindow).
    event.window.focus();
  }

  /**
   * Minimize-raise toggle (issue #71): activating the already-focused window
   * from a dock/taskbar minimizes it instead of re-focusing. Floating
   * workspaces only, and only when the window is on the visible workspace —
   * activating a window on another workspace keeps the usual switch+focus.
   * Routed through `window.minimize()` so the request takes the same Rust
   * round trip as CSD buttons and taskbar set_minimized, keeping every
   * minimize side effect centralized in `onWindowMinimizeRequest`.
   *
   * Never fires before the window has presented a frame: that activation is a
   * dock handing focus to the app it just launched, not the user toggling a
   * visible window. See `presentedWindowIds`.
   */
  private minimizeOnReactivate(
    window: WaylandWindow,
    workspace: Workspace | undefined,
  ): boolean {
    if (!this.presentedWindowIds.has(window.id)) {
      return false;
    }
    if (!workspace || workspace.isTiled || !workspace.isActive()) {
      return false;
    }
    if (window.state[WINDOW_STATE_MINIMIZED]() || !window.isFocused()) {
      return false;
    }
    // A restore that just happened means this activate is the tail of the
    // same taskbar click (sfwbar sends unset_minimized + activate as
    // separate requests), not a re-click of a visible window.
    const restoredAt = this.lastRestoreAtMs.get(window.id);
    if (
      restoredAt !== undefined &&
      Date.now() - restoredAt <= RESTORE_ACTIVATE_GRACE_MS
    ) {
      return false;
    }
    window.minimize();
    return true;
  }

  public toggleCurrentWorkspaceTiling() {
    withManagedWindowOnlySSDRebuildSuppressed(() => {
      const workspace = this.getCurrentWorkspace();
      if (!workspace) {
        return;
      }
      workspace.setTiled(!workspace.isTiled);
      this.applyWorkspaceStackPolicy(workspace);
      this.restoreFloatingFocusStacking(workspace);
    });
  }

  public toggleWorkspaceTilingForMonitor(monitor: string) {
    withManagedWindowOnlySSDRebuildSuppressed(() => {
      this.syncWorkspaces();
      const workspace = this.workspaceForMonitor(monitor);
      if (!workspace) {
        return;
      }
      workspace.setTiled(!workspace.isTiled);
      this.applyWorkspaceStackPolicy(workspace);
      this.restoreFloatingFocusStacking(workspace);
    });
  }

  /**
   * After leaving tiling mode the "floating windows stay above tiles" policy
   * no longer applies; put the focused window back on top explicitly because
   * focusing an already-focused window does not emit another focus event.
   * Only called from the tiling toggles, where focus signals are settled —
   * during window-open initialization they can be stale (two windows both
   * reporting focused) and raising here would hoist the wrong window.
   */
  private restoreFloatingFocusStacking(workspace: Workspace) {
    if (workspace.isTiled) {
      return;
    }
    const focusedWindow = workspace.focusedWindow();
    if (focusedWindow && this.windowStack.has(focusedWindow)) {
      this.windowStack.raise(focusedWindow);
    }
  }

  /**
   * Directional focus (h/j/k/l, arrows): picks the visible, non-minimized
   * window spatially in the requested direction — the source workspace first,
   * then the adjacent output's active workspace. Hidden workspaces are never
   * focused. With no focused window (an empty output) the current output's
   * geometry is the source so the step still crosses to the adjacent output;
   * the navigation marker keeps subsequent presses moving from there, and the
   * adjacent output's own active window is focused or native window focus is
   * cleared instead of leaving a stale focused window behind. A successful
   * directional step also warps the pointer to the destination (window's
   * visible center, or the output viewport when no candidate window exists);
   * other focus paths never move the cursor.
   */
  public focusWindow(direction: WindowDirection): void {
    this.cancelPendingReloadFocus();
    withManagedWindowOnlySSDRebuildSuppressed(() => {
      const source = this.keyboardNavigationMonitor
        ? this.focusedWindowLocationForMonitor(this.keyboardNavigationMonitor)
        : this.focusedWindowLocation();
      const monitor =
        source?.workspace.monitor ??
        this.keyboardNavigationMonitor ??
        this.currentMonitor;
      const sourceWorkspace =
        source?.workspace ??
        this.ensureWorkspace(monitor, this.getActiveWorkspaceIndex(monitor));
      const sourceRect = source
        ? managedRectToTileRect(source.window.state[WINDOW_STATE_RECT]())
        : managedRectToTileRect(this.workspaceViewportRect(monitor));
      const neighbor = this.directionalWindowNeighbor(
        sourceWorkspace,
        source?.window.id,
        sourceRect,
        direction,
      );
      if (!neighbor) {
        // Nothing focusable that way. Claim the adjacent output anyway so the
        // next press continues from it rather than reusing a stale source, and
        // focus that output's own active window or clear native window focus
        // (never elect a window on another output).
        const targetMonitor = this.outputInDirection(monitor, direction);
        if (targetMonitor) {
          this.keyboardNavigationMonitor = targetMonitor;
          this.currentMonitor = targetMonitor;
          this.workspaceForMonitor(targetMonitor)?.focusActiveWindow();
          // No candidate windows here: land the pointer in the middle of the
          // output's usable viewport so subsequent presses start from there.
          this.warpCursorToVisibleRectCenter(
            targetMonitor,
            managedRectToTileRect(this.workspaceViewportRect(targetMonitor)),
          );
          this.workspaceChangeBroadcaster?.();
        }
        return;
      }
      this.keyboardNavigationMonitor = neighbor.workspace.monitor;
      this.currentMonitor = neighbor.workspace.monitor;
      this.switchWorkspaceTo(neighbor.workspace.monitor, neighbor.workspace.index, {
        focusActiveAfter: false,
      });
      neighbor.window.focus();
      this.applyWorkspaceStackPolicy(neighbor.workspace);
      // Keyboard-only cursor follow: bring the pointer to the visible center
      // of the newly focused window on its output so the next directional
      // step and pointer hover agree. Generic focus events never warp.
      this.warpCursorToVisibleRectCenter(
        neighbor.workspace.monitor,
        managedRectToTileRect(neighbor.window.state[WINDOW_STATE_RECT]()),
      );
    });
  }

  /**
   * Directional movement (Super+Shift+h/j/k/l, arrows). Tiled windows swap
   * leaf membership with the spatial neighbor, falling back to a transfer to
   * the neighboring output at the edge; floating windows step 40 logical px
   * with viewport clamping and the same output fallback. No movement while
   * fullscreen (Win+F exits first).
   */
  public moveFocusedWindow(direction: WindowDirection): void {
    this.cancelPendingReloadFocus();
    withManagedWindowOnlySSDRebuildSuppressed(() => {
      const source = this.focusedWindowLocation();
      if (!source) {
        return;
      }
      const { window, workspace } = source;
      if (window.state[WINDOW_STATE_FULLSCREEN]()) {
        return;
      }
      if (!workspace.isTiled || !workspace.isTiledMember(window)) {
        this.moveFloatingWindowDirectional(window, workspace, direction);
        return;
      }

      const rects = workspace.leafRects();
      const sourceRect = rects.get(window.id);
      if (!sourceRect) {
        return;
      }
      const candidates = Array.from(rects.entries())
        .filter(([id]) => id !== window.id)
        .map(([id, rect]) => ({ id, rect }));
      const neighbor = directionalNeighbor(sourceRect, candidates, direction);
      if (neighbor) {
        workspace.swapTiles(window.id, neighbor.id);
        workspace.applyLayout();
        this.applyWorkspaceStackPolicy(workspace);
        return;
      }

      const targetMonitor = this.outputInDirection(workspace.monitor, direction);
      if (!targetMonitor) {
        return;
      }
      this.transferWindowToWorkspace(
        window,
        workspace,
        this.ensureWorkspace(targetMonitor, this.getActiveWorkspaceIndex(targetMonitor)),
      );
    });
  }

  /**
   * Win+A: exits fullscreen/maximize when needed, then toggles the focused
   * window's user-floating override. Entering float centers a 1280x720 root
   * rectangle clamped to the usable area and the window's size constraints;
   * returning re-inserts the leaf without touching other windows' explicit
   * float state.
   */
  public toggleFocusedWindowFloating(): void {
    withManagedWindowOnlySSDRebuildSuppressed(() => {
      const source = this.focusedWindowLocation();
      if (!source) {
        return;
      }
      const { window, workspace } = source;
      // Clear fullscreen/maximize bookkeeping synchronously, before any
      // native call or geometry: a late native false callback must not
      // replay a stale restore rect over the float/tile geometry below.
      // Both restore rects go, and snap state is cleared with them.
      // Win+M/F semantics elsewhere are untouched.
      const wasFullscreen = window.state[WINDOW_STATE_FULLSCREEN]();
      const wasMaximized = window.state[WINDOW_STATE_MAXIMIZED]();
      const wasTiledMember = workspace.isTiledMember(window);
      const floatingRestoreRect =
        window.state[WINDOW_STATE_RESTORE_RECT]() ??
        window.state[WINDOW_STATE_FULLSCREEN_RESTORE_RECT]();
      window.state[WINDOW_STATE_FULLSCREEN].set(false);
      window.state[WINDOW_STATE_FULLSCREEN_RESTORE_RECT].set(null);
      window.state[WINDOW_STATE_MAXIMIZED].set(false);
      window.state[WINDOW_STATE_RESTORE_RECT].set(null);
      this.clearWindowSnapState(window);
      if (wasFullscreen) {
        window.unfullscreen();
      }
      if (wasMaximized) {
        window.unmaximize();
      }

      if (window.state[WINDOW_STATE_USER_FLOATING]()) {
        // Explicit user-floating override off: re-insert the leaf only when
        // the workspace is tiled and the window is intrinsically tileable.
        window.state[WINDOW_STATE_USER_FLOATING].set(false);
        if (workspace.isTiled && workspace.shouldTile(window)) {
          workspace.insertWindowTile(window);
        }
      } else if (workspace.isTiled && workspace.isTiledMember(window)) {
        window.state[WINDOW_STATE_USER_FLOATING].set(true);
        workspace.removeWindowTile(window);
        const rect = this.centeredFloatingOverrideRect(window, workspace.monitor);
        window.state[WINDOW_STATE_FLOATING_RECT].set(rect);
        playRectAnimation(
          window,
          WINDOW_STATE_RECT,
          rect,
          WINDOW_MANAGEMENT_EASING,
          WINDOW_MANAGEMENT_ANIMATION_DURATION,
        );
      } else {
        window.state[WINDOW_STATE_USER_FLOATING].set(true);
      }
      if (
        (wasFullscreen || wasMaximized) &&
        !wasTiledMember &&
        (!workspace.isTiled || !workspace.isTileCandidate(window))
      ) {
        const rect = floatingRestoreRect ??
          this.centeredFloatingOverrideRect(window, workspace.monitor);
        workspace.syncFloatingWindowRect(window, rect);
        playRectAnimation(
          window,
          WINDOW_STATE_RECT,
          rect,
          WINDOW_MANAGEMENT_EASING,
          WINDOW_MANAGEMENT_ANIMATION_DURATION,
        );
      }
      workspace.syncWindowVisibleOutputs(window);
      workspace.applyLayout();
      this.applyWorkspaceStackPolicy(workspace);
      window.focus();
    });
  }

  /** Super+Alt+J: toggle the focused tiled leaf's parent split axis. */
  public toggleFocusedWindowSplit(): void {
    withManagedWindowOnlySSDRebuildSuppressed(() => {
      const source = this.focusedWindowLocation();
      if (!source) {
        return;
      }
      if (source.workspace.toggleWindowSplit(source.window)) {
        source.workspace.applyLayout();
        this.applyWorkspaceStackPolicy(source.workspace);
      }
    });
  }

  /**
   * Alt+Tab: cycles visible, non-minimized windows across active workspaces
   * in stable workspace/insertion order; Alt+Shift+Tab reverses. Native focus
   * updates keep MRU/bar state in sync through onFocus.
   */
  public cycleFocusedWindow(direction: -1 | 1): void {
    this.cancelPendingReloadFocus();
    const candidates: { workspace: Workspace; window: WaylandWindow }[] = [];
    for (const workspace of this.workspaces.values()) {
      if (!workspace.isActive()) {
        continue;
      }
      for (const window of workspace.listWindows()) {
        if (
          window.state[WINDOW_STATE_MINIMIZED]() ||
          !window.state[WINDOW_STATE_WORKSPACE_VISIBLE]()
        ) {
          continue;
        }
        candidates.push({ workspace, window });
      }
    }
    if (candidates.length === 0) {
      return;
    }
    const currentIndex = candidates.findIndex(({ window }) =>
      window.isFocused(),
    );
    const nextIndex =
      currentIndex < 0
        ? direction > 0
          ? 0
          : candidates.length - 1
        : (currentIndex + direction + candidates.length) % candidates.length;
    const { workspace, window } = candidates[nextIndex];
    this.currentMonitor = workspace.monitor;
    this.switchWorkspaceTo(workspace.monitor, workspace.index, {
      focusActiveAfter: false,
    });
    window.focus();
    this.applyWorkspaceStackPolicy(workspace);
  }

  /**
   * Super+Shift+digit: send the focused window to workspace `index`
   * (monitor-local, constrained to 1..10) on the focused window's monitor.
   * `follow` switches with the window; a silent transfer restores the source
   * workspace's focus instead.
   */
  public moveFocusedWindowToWorkspaceIndex(index: number, follow: boolean): void {
    this.cancelPendingReloadFocus();
    withManagedWindowOnlySSDRebuildSuppressed(() => {
      this.syncWorkspaces();
      const source = this.focusedWindowLocation();
      if (!source) {
        return;
      }
      const { window, workspace: from } = source;
      if (!isOrdinaryWorkspaceIndex(index)) {
        return;
      }
      const targetIndex = index;
      if (targetIndex === from.index) {
        return;
      }
      this.transferWindowToWorkspace(
        window,
        from,
        this.ensureWorkspace(from.monitor, targetIndex),
        { follow },
      );
    });
  }

  /**
   * Ctrl+Shift+Left/Right and wheel: send the focused window to the relative
   * workspace (constrained to 1..10). `follow` defaults to true.
   */
  public moveFocusedWindowToWorkspace(
    direction: -1 | 1,
    follow = true,
  ): void {
    this.cancelPendingReloadFocus();
    withManagedWindowOnlySSDRebuildSuppressed(() => {
      this.syncWorkspaces();
      const source = this.focusedWindowLocation();
      if (!source) {
        return;
      }
      const targetIndex = isSpecialWorkspaceIndex(source.workspace.index)
        ? 1
        : source.workspace.index + direction;
      if (!isOrdinaryWorkspaceIndex(targetIndex)) {
        return;
      }
      this.transferWindowToWorkspace(
        source.window,
        source.workspace,
        this.ensureWorkspace(source.workspace.monitor, targetIndex),
        { follow },
      );
    });
  }

  /**
   * First focused window of the selected output's active workspace. Scoped to
   * `keyboardNavigationMonitor`/`currentMonitor` on purpose: a global scan for
   * any focused window is exactly the cross-output fallback that let a second
   * key press jump to another output instead of continuing from the selected
   * one.
   */
  private focusedWindowLocation():
    | { window: WaylandWindow; workspace: Workspace }
    | undefined {
    return this.focusedWindowLocationForMonitor(
      this.keyboardNavigationMonitor ?? this.currentMonitor,
    );
  }

  /**
   * First focused window on `monitor` only, preferring that monitor's active
   * workspace. Used when keyboard navigation owns the source output: falling
   * back to another monitor's (stale) focused window is exactly what made a
   * second key press fail to advance off an empty output.
   */
  private focusedWindowLocationForMonitor(
    monitor: string,
  ): { window: WaylandWindow; workspace: Workspace } | undefined {
    const workspace = this.workspaceForMonitor(monitor);
    const window = workspace?.focusedWindow();
    return workspace && window && isFocusableWindow(window)
      ? { workspace, window }
      : undefined;
  }

  /**
   * Visible, non-minimized windows of `workspace` as spatial candidates, with
   * `excludedWindowId` (the source window) filtered out.
   */
  private directionalCandidates(
    workspace: Workspace,
    excludedWindowId: string | undefined,
  ): {
    id: string;
    rect: TileRect;
    window: WaylandWindow;
    workspace: Workspace;
  }[] {
    return workspace
      .listWindows()
      .filter(
        (window) =>
          window.id !== excludedWindowId &&
          !window.state[WINDOW_STATE_MINIMIZED]() &&
          window.state[WINDOW_STATE_WORKSPACE_VISIBLE](),
      )
      .map((window) => ({
        id: window.id,
        rect: managedRectToTileRect(window.state[WINDOW_STATE_RECT]()),
        window,
        workspace,
      }));
  }

  private directionalWindowNeighbor(
    sourceWorkspace: Workspace,
    excludedWindowId: string | undefined,
    sourceRect: TileRect,
    direction: WindowDirection,
  ): { workspace: Workspace; window: WaylandWindow } | undefined {
    const local = directionalNeighbor(
      sourceRect,
      this.directionalCandidates(sourceWorkspace, excludedWindowId),
      direction,
    );
    if (local) {
      return local;
    }
    // No window in that direction on the source workspace: cross the output
    // boundary. Only the output adjacent in `direction` is considered — a
    // center comparison across every output could jump to a window that merely
    // happens to lie in the half-plane.
    const targetMonitor = this.outputInDirection(
      sourceWorkspace.monitor,
      direction,
    );
    if (!targetMonitor) {
      return undefined;
    }
    const targetWorkspace = this.ensureWorkspace(
      targetMonitor,
      this.getActiveWorkspaceIndex(targetMonitor),
    );
    const candidates = this.directionalCandidates(
      targetWorkspace,
      excludedWindowId,
    );
    if (candidates.length === 0) {
      return undefined;
    }
    // The adjacent output lies entirely past the facing edge, so a candidate
    // normally exists; `directionalNeighbor` only orders which is nearest.
    // List order is the fallback when an off-screen or degenerate rect defeats
    // the half-plane test.
    return (
      directionalNeighbor(sourceRect, candidates, direction) ?? candidates[0]
    );
  }

  /**
   * Nearest output past the requested facing edge with positive perpendicular
   * overlap. Rectangle-based on purpose: center-in-halfplane tests misrank
   * stacked unequal-width outputs (e.g. a 3440px panel above a 2560px one,
   * where the lower panel's center sits left of the upper's and reads as a
   * false "left" neighbor when only up/down adjacency exists). No
   * diagonal-only fallback: a candidate touching only the perpendicular
   * axis is never chosen.
   */
  private outputInDirection(
    fromMonitor: string,
    direction: WindowDirection,
  ): string | undefined {
    const from = this.monitorFullRect(fromMonitor);
    if (!from) {
      return undefined;
    }
    const fromX = read(from.x);
    const fromY = read(from.y);
    const fromRight = fromX + read(from.width);
    const fromBottom = fromY + read(from.height);
    const fromCenterX = fromX + read(from.width) / 2;
    const fromCenterY = fromY + read(from.height) / 2;
    let best: { name: string; facing: number; perp: number } | null = null;
    for (const name of COMPOSITOR.output.list) {
      if (name === fromMonitor) {
        continue;
      }
      const rect = this.monitorFullRect(name);
      if (!rect) {
        continue;
      }
      const x = read(rect.x);
      const y = read(rect.y);
      const right = x + read(rect.width);
      const bottom = y + read(rect.height);
      const centerX = x + read(rect.width) / 2;
      const centerY = y + read(rect.height) / 2;
      let facing: number;
      let perpOverlap: number;
      let perp: number;
      if (direction === "left") {
        if (right > fromX) continue;
        facing = fromX - right;
        perpOverlap = Math.min(fromBottom, bottom) - Math.max(fromY, y);
        perp = Math.abs(centerY - fromCenterY);
      } else if (direction === "right") {
        if (x < fromRight) continue;
        facing = x - fromRight;
        perpOverlap = Math.min(fromBottom, bottom) - Math.max(fromY, y);
        perp = Math.abs(centerY - fromCenterY);
      } else if (direction === "up") {
        if (bottom > fromY) continue;
        facing = fromY - bottom;
        perpOverlap = Math.min(fromRight, right) - Math.max(fromX, x);
        perp = Math.abs(centerX - fromCenterX);
      } else {
        if (y < fromBottom) continue;
        facing = y - fromBottom;
        perpOverlap = Math.min(fromRight, right) - Math.max(fromX, x);
        perp = Math.abs(centerX - fromCenterX);
      }
      if (perpOverlap <= 0) {
        continue;
      }
      if (
        best === null ||
        facing < best.facing - 1 ||
        (Math.abs(facing - best.facing) <= 1 && perp < best.perp)
      ) {
        best = { name, facing, perp };
      }
    }
    return best?.name;
  }

  /**
   * Move a window to another workspace using the existing takeover methods,
   * so the snapshot retains user float, minimize/maximize/restore and
   * fullscreen state plus source/destination memberships. Follows the window
   * (switch + focus) unless `follow` is false, in which case the source
   * workspace's focus is silently restored.
   */
  private transferWindowToWorkspace(
    window: WaylandWindow,
    from: Workspace,
    to: Workspace,
    options: { follow?: boolean; placedRect?: ManagedWindowRect } = {},
  ): void {
    const moved = from.takeWindowForMove(window);
    if (!moved) {
      return;
    }
    // Rects are global logical coordinates. A cross-output move must re-anchor
    // the snapshot's restore geometry on the destination usable origin, or the
    // window reappears where it sat on the source output. Same-monitor moves
    // keep the geometry untouched.
    const snapshot: WorkspaceWindowSnapshot =
      from.monitor === to.monitor
        ? moved.snapshot
        : {
            ...moved.snapshot,
            floatingRect: this.translateRectBetweenWorkspaces(
              moved.snapshot.floatingRect,
              from,
              to,
              window,
            ),
            restoreRect: this.translateRectBetweenWorkspaces(
              moved.snapshot.restoreRect,
              from,
              to,
              window,
            ),
            fullscreenRestoreRect: this.translateRectBetweenWorkspaces(
              moved.snapshot.fullscreenRestoreRect,
              from,
              to,
              window,
            ),
            snapZone: null,
            snapMonitor: null,
          };
    stopRectAnimation(window, WINDOW_STATE_RECT);
    to.addMovedWindow(window, snapshot);
    // A tile member's rect is owned by the split tree; only apply the explicit
    // placement to a genuinely floating window, and mark it so the layout pass
    // below re-applies that exact rect instead of animating over it.
    const placed = options.placedRect
      ? this.translateRectBetweenWorkspaces(options.placedRect, to, to, window)
      : undefined;
    const hasPlaced = placed != null && !to.isTiledMember(window);
    if (hasPlaced) {
      window.state[WINDOW_STATE_RECT].set(placed);
      to.syncFloatingWindowRect(window, placed);
    }
    from.applyLayout();
    to.applyLayout({
      immediateFloatingWindowIds: hasPlaced ? new Set([window.id]) : undefined,
    });
    if (options.follow === false) {
      this.syncWorkspaceVisibility();
      // Silent transfer: pick a remaining visible/nonminimized source focus
      // target, not just the (possibly stale/minimized) active leaf.
      from.focusSilentTransferFallback();
    } else {
      this.currentMonitor = to.monitor;
      this.switchWorkspaceTo(to.monitor, to.index, { focusActiveAfter: false });
      window.focus();
    }
    this.applyWorkspaceStackPolicy(from);
    this.applyWorkspaceStackPolicy(to);
    this.syncWorkspaceVisibility();
  }

  /**
   * Re-anchor a rect captured on `from` onto `to`'s usable origin and clamp it
   * into that usable area, respecting the client's size constraints.
   */
  private translateRectBetweenWorkspaces(
    rect: ManagedWindowRect | null | undefined,
    from: Workspace,
    to: Workspace,
    window: WaylandWindow,
  ): ManagedWindowRect | null | undefined {
    if (!rect) {
      return rect;
    }
    const fromViewport = this.workspaceViewportRect(from.monitor);
    const toViewport = this.workspaceViewportRect(to.monitor);
    const extra = this.clientToRootSizeExtra(window);
    const constraints = window.sizeConstraints();
    const minWidth = Math.max(1, constraints.min?.width ?? 1) + extra.width;
    const minHeight = Math.max(1, constraints.min?.height ?? 1) + extra.height;
    const width = window.isResizable()
      ? clamp(read(rect.width), minWidth, Math.max(minWidth, Math.min(
          read(toViewport.width), (constraints.max?.width ?? Infinity) + extra.width,
        )))
      : read(rect.width);
    const height = window.isResizable()
      ? clamp(read(rect.height), minHeight, Math.max(minHeight, Math.min(
          read(toViewport.height), (constraints.max?.height ?? Infinity) + extra.height,
        )))
      : read(rect.height);
    const moved: ManagedWindowRect = {
      x: read(rect.x) + (read(toViewport.x) - read(fromViewport.x)),
      y: read(rect.y) + (read(toViewport.y) - read(fromViewport.y)),
      width,
      height,
    };
    const minX = read(toViewport.x);
    const minY = read(toViewport.y);
    const maxX = minX + Math.max(0, read(toViewport.width) - width);
    const maxY = minY + Math.max(0, read(toViewport.height) - height);
    return {
      x: clamp(read(moved.x), minX, maxX),
      y: clamp(read(moved.y), minY, maxY),
      width,
      height,
    };
  }

  /** Floating directional move: 40 logical px step with viewport clamping. */
  private moveFloatingWindowDirectional(
    window: WaylandWindow,
    workspace: Workspace,
    direction: WindowDirection,
  ): void {
    const viewport = this.workspaceViewportRect(workspace.monitor);
    const rect = window.state[WINDOW_STATE_RECT]();
    const stepX =
      direction === "left" ? -FLOAT_MOVE_STEP_PX : direction === "right" ? FLOAT_MOVE_STEP_PX : 0;
    const stepY =
      direction === "up" ? -FLOAT_MOVE_STEP_PX : direction === "down" ? FLOAT_MOVE_STEP_PX : 0;
    const width = read(rect.width);
    const height = read(rect.height);
    const viewportX = read(viewport.x);
    const viewportY = read(viewport.y);
    const clampedX = clamp(
      read(rect.x) + stepX,
      viewportX,
      viewportX + Math.max(0, read(viewport.width) - width),
    );
    const clampedY = clamp(
      read(rect.y) + stepY,
      viewportY,
      viewportY + Math.max(0, read(viewport.height) - height),
    );
    if (
      Math.abs(clampedX - read(rect.x)) + Math.abs(clampedY - read(rect.y)) >=
      0.5
    ) {
      const nextRect = { x: clampedX, y: clampedY, width, height };
      stopRectAnimation(window, WINDOW_STATE_RECT);
      window.state[WINDOW_STATE_RECT].set(nextRect);
      workspace.syncFloatingWindowRect(window, nextRect);
      this.applyWorkspaceStackPolicy(workspace);
      return;
    }

    // Already at the viewport edge: transfer to the output in that direction,
    // placed flush against the near edge.
    const targetMonitor = this.outputInDirection(workspace.monitor, direction);
    if (!targetMonitor) {
      return;
    }
    const targetWorkspace = this.ensureWorkspace(
      targetMonitor,
      this.getActiveWorkspaceIndex(targetMonitor),
    );
    const targetViewport = this.workspaceViewportRect(targetWorkspace.monitor);
    const targetX = read(targetViewport.x);
    const targetY = read(targetViewport.y);
    // Crossing into the target output enters at the edge FACING the source
    // (a left move enters the left output's right edge), with the
    // perpendicular coordinate clamped to the target viewport.
    const placed: ManagedWindowRect = {
      x:
        stepX < 0
          ? targetX + Math.max(0, read(targetViewport.width) - width)
          : stepX > 0
            ? targetX
            : clamp(read(rect.x), targetX, targetX + Math.max(0, read(targetViewport.width) - width)),
      y:
        stepY < 0
          ? targetY + Math.max(0, read(targetViewport.height) - height)
          : stepY > 0
            ? targetY
            : clamp(read(rect.y), targetY, targetY + Math.max(0, read(targetViewport.height) - height)),
      width,
      height,
    };
    this.transferWindowToWorkspace(window, workspace, targetWorkspace, {
      placedRect: placed,
    });
  }

  /**
   * Win+A float placement: a centered 1280x720 managed root rectangle,
   * clamped to the usable area and the window's own size constraints.
   */
  private centeredFloatingOverrideRect(
    window: WaylandWindow,
    monitor: string,
  ): ManagedWindowRect {
    const viewport = this.workspaceViewportRect(monitor);
    const constraints = window.sizeConstraints();
    const extra = this.clientToRootSizeExtra(window);
    const outsets = this.outsetsFor(window);
    const minWidth = Math.max(1, constraints.min?.width ?? 1) + extra.width;
    const minHeight = Math.max(1, constraints.min?.height ?? 1) + extra.height;
    // Cap by the usable viewport minus the decoration footprint, but never
    // below the client's own minimum: a window whose minimum exceeds the
    // viewport simply cannot fit.
    const maxWidth = Math.max(
      minWidth,
      Math.min(
        read(viewport.width) - outsets.left - outsets.right,
        constrainedMax(constraints, "width", extra.width),
      ),
    );
    const maxHeight = Math.max(
      minHeight,
      Math.min(
        read(viewport.height) - outsets.top - outsets.bottom,
        constrainedMax(constraints, "height", extra.height),
      ),
    );
    const width = clamp(USER_FLOAT_WIDTH, minWidth, maxWidth);
    const height = clamp(USER_FLOAT_HEIGHT, minHeight, maxHeight);
    return {
      x: clamp(
        read(viewport.x) + outsets.left + (read(viewport.width) - outsets.left - outsets.right - width) / 2,
        read(viewport.x) + outsets.left,
        read(viewport.x) + Math.max(0, read(viewport.width) - outsets.right - width),
      ),
      y: clamp(
        read(viewport.y) + outsets.top + (read(viewport.height) - outsets.top - outsets.bottom - height) / 2,
        read(viewport.y) + outsets.top,
        read(viewport.y) + Math.max(0, read(viewport.height) - outsets.bottom - height),
      ),
      width,
      height,
    };
  }

  public closeFocusedWindow() {
    for (const workspace of this.workspaces.values()) {
      const focused = workspace.focusedWindow();
      if (focused) {
        focused.close();
        return;
      }
    }
  }

  public toggleFocusedWindowMaximize() {
    for (const workspace of this.workspaces.values()) {
      const focused = workspace.focusedWindow();
      if (!focused || !read(focused.isResizable)) {
        continue;
      }

      if (focused.state[WINDOW_STATE_MAXIMIZED]()) {
        focused.unmaximize();
      } else {
        focused.maximize();
      }
      return;
    }
  }

  /**
   * Compositor-side fullscreen toggle. Exists mainly as an escape hatch for
   * Wine/Proton games: win32u treats any window whose rect covers a monitor
   * as fullscreen and winex11 then keeps `_NET_WM_STATE_FULLSCREEN` set, so
   * a game whose "windowed" resolution equals the desktop can never leave
   * fullscreen on its own. A WM-initiated unfullscreen is different: Wine
   * adopts an unexpected `_NET_WM_STATE`/configure as its new desired state
   * and resizes the Win32 window to match.
   */
  public toggleFocusedWindowFullscreen() {
    for (const workspace of this.workspaces.values()) {
      const focused = workspace.focusedWindow();
      if (!focused) {
        continue;
      }
      if (focused.state[WINDOW_STATE_FULLSCREEN]()) {
        focused.unfullscreen();
      } else {
        focused.fullscreen();
      }
      return;
    }
  }

  public refreshUsableAreaLayouts(force = false) {
    this.syncWorkspaces();
    // While a window is being interactively dragged, do not re-apply the
    // usable-area layout. It would clobber the in-flight drag — most visibly,
    // a maximized window (which stays WINDOW_STATE_MAXIMIZED during the
    // unmaximize-grab) gets snapped back to its full rect, flashing maximized
    // whenever a layer surface mounts/unmounts (e.g. the snap-preview overlay).
    // The layout is re-applied by the next layout event once the drag ends.
    if (this.isGrabbing) {
      return;
    }
    for (const workspace of this.workspaces.values()) {
      workspace.refreshUsableAreaLayout(force);
    }
    if (force) {
      // A forced pass (Rainlit selection change / reload restore) must also
      // re-fit already-snapped floating windows, not only tiled/maximized
      // ones. The layout is recomputed from the same windows, so nothing
      // moves unboundedly — only the footprint inset changes.
      this.refreshSnappedFloatingLayouts();
    }
    this.syncWorkspaceVisibility();
  }

  /**
   * Recompute and re-apply every floating snap layout, grouped per monitor.
   */
  private refreshSnappedFloatingLayouts(): void {
    for (const workspace of this.workspaces.values()) {
      // Snap layouts only exist on floating workspaces; tiled leaves own
      // their geometry and a stale zone must never win over a leaf rect.
      if (workspace.isTiled) {
        continue;
      }
      const byMonitor = new Map<string, WaylandWindow[]>();
      for (const window of workspace.listWindows()) {
        const monitor = window.state[WINDOW_STATE_SNAP_MONITOR]();
        if (!monitor || !this.isWindowInFloatingSnapLayout(window, monitor)) {
          continue;
        }
        const group = byMonitor.get(monitor);
        if (group) {
          group.push(window);
        } else {
          byMonitor.set(monitor, [window]);
        }
      }
      for (const [monitor, windows] of byMonitor) {
        const base = this.monitorSnapBaseRect(monitor);
        if (!base) {
          continue;
        }
        const layout = this.floatingSnapLayoutFromWindows(base, windows);
        this.clampFloatingSnapLayout(base, layout, windows);
        this.applyFloatingSnapLayout(base, layout, windows);
      }
    }
  }

  public switchWorkspace(direction: -1 | 1) {
    const monitor = this.currentMonitor || this.preferredOutput();
    if (!monitor) {
      return;
    }
    const currentIndex = this.activeWorkspaceByMonitor.get(monitor) ?? 1;
    const nextIndex = isSpecialWorkspaceIndex(currentIndex) ? 1 : currentIndex + direction;
    if (isOrdinaryWorkspaceIndex(nextIndex)) {
      this.switchWorkspaceTo(monitor, nextIndex);
    }
  }

  /**
   * Animated switch to an explicit workspace index on a monitor. Direction is
   * inferred from the current index so the same vertical slide/fade transition
   * as keyboard/gesture switching plays (used by the IPC `workspaces.activate`).
   * Activation always (re)selects focus for the target workspace, for both the
   * same-index and changed-index cases; an empty workspace clears native window
   * focus and never falls back to another output.
   */
  public switchWorkspaceTo(
    monitor: string,
    targetIndex: number,
    options: { focusActiveAfter?: boolean } = {},
  ) {
    this.workspaceGesture = null;
    this.syncWorkspaces();
    if (
      !COMPOSITOR.output.list.includes(monitor) ||
      (!isOrdinaryWorkspaceIndex(targetIndex) && !isSpecialWorkspaceIndex(targetIndex))
    ) {
      return;
    }

    this.cancelPendingReloadFocus();
    const currentIndex = this.activeWorkspaceByMonitor.get(monitor) ?? 1;
    this.currentMonitor = monitor;
    // An explicit switch selects this output for the next directional/digit
    // command too; an accepted window focus event may then clear the marker.
    this.keyboardNavigationMonitor = monitor;
    if (targetIndex === currentIndex) {
      // Same-index activation still restores focus to the selected workspace's
      // active window (or clears it when the workspace is empty) instead of
      // being a silent no-op.
      if (options.focusActiveAfter !== false) {
        this.ensureWorkspace(monitor, targetIndex).focusActiveWindow();
      }
      return;
    }
    const direction: -1 | 1 = targetIndex > currentIndex ? 1 : -1;

    const fromWorkspace = this.ensureWorkspace(monitor, currentIndex);
    const toWorkspace = this.ensureWorkspace(monitor, targetIndex);
    const distance = this.workspaceTransitionDistance(monitor);

    this.activeWorkspaceByMonitor.set(monitor, targetIndex);
    this.currentMonitor = monitor;

    // Settle only the other workspaces on the target monitor: settling other
    // monitors here would cancel their independent in-flight transitions.
    for (const workspace of this.workspaces.values()) {
      if (
        workspace.monitor !== monitor ||
        workspace === fromWorkspace ||
        workspace === toWorkspace
      ) {
        continue;
      }
      workspace.setVisible(workspace.isActive());
    }

    fromWorkspace.animateWorkspaceTransition({
      fromOffsetY: 0,
      toOffsetY: -direction * distance,
      fromOpacity: 1,
      toOpacity: 0,
      visibleAfter: false,
    });
    toWorkspace.prepareWorkspaceTransition(direction * distance, 0);
    toWorkspace.applyLayout();
    toWorkspace.animateWorkspaceTransition({
      fromOffsetY: direction * distance,
      toOffsetY: 0,
      fromOpacity: 0,
      toOpacity: 1,
      visibleAfter: true,
    });
    // Callers that explicitly want to focus a *different* window after the
    // transition (e.g. dock activation) opt out of the implicit focus so the
    // resulting onFocus callback chain does not fight their explicit target.
    if (options.focusActiveAfter !== false) {
      toWorkspace.focusActiveWindow();
    }
    this.applyWorkspaceStackPolicy(fromWorkspace);
    this.applyWorkspaceStackPolicy(toWorkspace);
    this.workspaceChangeBroadcaster?.();
  }

  /**
   * The selected output's active workspace. Scoped to `currentMonitor` on
   * purpose: a global fallback could hand back another output's workspace and
   * reintroduce the cross-output focus fallback this manager avoids.
   */
  public getCurrentWorkspace(): Workspace | undefined {
    this.syncWorkspaces();
    return this.workspaceForMonitor(this.currentMonitor);
  }

  /** Name (connector) of the monitor under the cursor; updated on pointer move. */
  public getCurrentMonitorName(): string {
    this.syncWorkspaces();
    return this.currentMonitor || this.preferredOutput();
  }

  /**
   * Compact per-monitor workspace view for external clients (the bar) over IPC.
   */
  public viewForIpc(): WorkspacesView {
    this.syncWorkspaces();

    const byMonitor = new Map<string, WorkspacesViewWorkspace[]>();
    for (const workspace of this.workspaces.values()) {
      if (!isOrdinaryWorkspaceIndex(workspace.index)) {
        continue;
      }
      const active =
        this.activeWorkspaceByMonitor.get(workspace.monitor) ===
        workspace.index;
      const list = byMonitor.get(workspace.monitor) ?? [];
      const windows: WorkspacesViewWindow[] = workspace
        .listWindows()
        .map((window) => ({
          id: window.id,
          appId: window.appId(),
          title: window.title(),
          focused: window.isFocused(),
          lastFocusedAt: this.lastFocusedAt.get(window.id) ?? 0,
        }));
      list.push({
        index: globalWorkspaceIndex(workspace.monitor, workspace.index, COMPOSITOR.output.list),
        windowCount: workspace.windowCount(),
        isTiled: workspace.isTiled,
        active,
        windows,
      });
      byMonitor.set(workspace.monitor, list);
    }

    const monitors: WorkspacesViewMonitor[] = COMPOSITOR.output.list.map(
      (name) => {
        const localActive = this.getActiveWorkspaceIndex(name);
        const active = isOrdinaryWorkspaceIndex(localActive)
          ? globalWorkspaceIndex(name, localActive, COMPOSITOR.output.list)
          : 0;
        // Only surface workspaces that have windows, plus the active one
        // (which stays visible even while empty). Bare, empty, non-active
        // workspaces are hidden from the list.
        const workspaces = (byMonitor.get(name) ?? []).filter(
          (workspace) => workspace.windowCount > 0 || workspace.active,
        );
        if (active > 0 && !workspaces.some((workspace) => workspace.index === active)) {
          workspaces.push({
            index: active,
            windowCount: 0,
            isTiled: false,
            active: true,
            windows: [],
          });
        }
        workspaces.sort((a, b) => a.index - b.index);
        return { name, active, workspaces };
      },
    );

    return { currentMonitor: this.currentMonitor, monitors };
  }

  /**
   * Update MRU stamp for `windowId`. The dock uses this to pick the "most
   * recently used" window per app for left-click focus.
   */
  public recordFocus(windowId: string) {
    this.lastFocusedAt.set(windowId, Date.now());
  }

  private trackPendingInitialFocus(window: WaylandWindow) {
    const token = Date.now();
    this.pendingInitialFocusByWindowId.set(window.id, token);
    setTimeout(() => {
      if (this.pendingInitialFocusByWindowId.get(window.id) === token) {
        this.pendingInitialFocusByWindowId.delete(window.id);
      }
    }, WINDOW_MANAGEMENT_ANIMATION_DURATION);
  }

  private shouldDeferFocusLayoutForInitialOpen(
    window: WaylandWindow,
    workspace: Workspace | undefined,
  ): boolean {
    if (!workspace?.isTiled || !workspace.isActive()) {
      return false;
    }
    if (this.pendingInitialFocusByWindowId.delete(window.id)) {
      return false;
    }
    for (const pendingWindowId of this.pendingInitialFocusByWindowId.keys()) {
      if (
        workspace.isActiveWindowId(pendingWindowId) &&
        workspace.findWindowById(pendingWindowId)
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Find a managed window by id by scanning every workspace. Used by the
   * `windows.activate` IPC handler to bridge bar clicks to focus + workspace
   * switch.
   */
  public findWindowById(windowId: string): WaylandWindow | undefined {
    for (const workspace of this.workspaces.values()) {
      const found = workspace.findWindowById(windowId);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  /** Every managed window across all workspaces (debug/IPC use). */
  public listWindows(): WaylandWindow[] {
    const windows: WaylandWindow[] = [];
    for (const workspace of this.workspaces.values()) {
      windows.push(...workspace.listWindows());
    }
    return windows;
  }

  /**
   * Activate window by id (dock-style "go to this window"). Plays a unified
   * sequence: unminimize → switch workspace (if different) → focus.
   * Switching first here (instead of relying on the onFocus → focusWindow
   * callback) gives the same in-sync animation as
   * `Super+Ctrl+Left/Right`.
   *
   * Returns true if the window existed.
   */
  public activateWindowById(windowId: string): boolean {
    this.cancelPendingReloadFocus();
    const window = this.findWindowById(windowId);
    if (!window) {
      return false;
    }
    const workspace = this.findWorkspaceForWindow(window);
    if (!workspace) {
      return false;
    }

    if (window.state[WINDOW_STATE_MINIMIZED]()) {
      this.onWindowMinimizeRequest({
        window,
        minimized: false,
        source: "api",
        timestamp: Date.now(),
      });
    } else if (this.minimizeOnReactivate(window, workspace)) {
      // Minimize-raise toggle: an IPC activation is always a dock/taskbar
      // gesture, so re-activating the focused window minimizes it.
      return true;
    }

    // Cross-workspace: switch first with the existing slide/fade. Skip the
    // implicit focusActiveWindow — we explicitly focus the target below, and
    // letting switchWorkspaceTo focus the previous active would queue an
    // onFocus → focusWindow cycle that fights the explicit focus.
    this.switchWorkspaceTo(workspace.monitor, workspace.index, {
      focusActiveAfter: false,
    });

    // Every tiled leaf is fully on-screen by construction, so focusing the
    // target is the whole "go to this window" gesture.
    window.focus();
    return true;
  }

  /**
   * Activate a specific workspace on a monitor (external/IPC entry point).
   * Plays the same slide/fade transition as keyboard/gesture switching.
   */
  public activate(monitor: string, index: number) {
    const localIndex = localWorkspaceIndex(monitor, index, COMPOSITOR.output.list);
    if (!COMPOSITOR.output.list.includes(monitor) || localIndex === undefined) {
      return;
    }
    this.switchWorkspaceTo(monitor, localIndex);
  }

  public getWindowZIndex(window: WaylandWindow): ReadonlySignal<number> {
    return this.windowStack.zIndex(window);
  }

  private beginInteractiveUnmaximize(window: WaylandWindow): boolean {
    if (!window.state[WINDOW_STATE_MAXIMIZED]()) {
      return false;
    }

    window.state[WINDOW_STATE_MAXIMIZED].set(false);
    window.state[WINDOW_STATE_RESTORE_RECT].set(null);
    this.clearWindowSnapState(window);
    window.unmaximize();
    return true;
  }

  private applyWorkspaceStackPolicy(workspace: Workspace | undefined) {
    if (!workspace) {
      return;
    }

    if (!workspace.isTiled) {
      // Floating workspaces stack purely by focus order, which `onFocus`
      // already maintains. Raising `workspace.focusedWindow()` here instead
      // reads the per-window focus *signals*, and those go stale between
      // evaluations: while a new window's focused snapshot has arrived but
      // the previous window's unfocused snapshot has not, both report
      // focused and the OLD window wins — this ran during the new window's
      // first-commit initialization and hoisted the previous window above
      // the one being opened. The explicit tiling→floating restoration this
      // used to provide lives in `restoreFloatingFocusStacking`, called from
      // the toggle sites only.
      return;
    }

    const floating = workspace
      .floatingWindows()
      .filter((window) => this.windowStack.has(window))
      .sort(
        (a, b) =>
          this.windowStack.zIndexValue(a) - this.windowStack.zIndexValue(b),
      );

    for (const window of floating) {
      this.windowStack.raise(window);
    }
  }

  private syncWorkspaces() {
    for (const monitor of COMPOSITOR.output.list) {
      if (!this.activeWorkspaceByMonitor.has(monitor)) {
        this.activeWorkspaceByMonitor.set(monitor, 1);
      }
      this.ensureWorkspace(
        monitor,
        this.activeWorkspaceByMonitor.get(monitor) ?? 1,
      );
    }
    if (this.keyboardNavigationMonitor && !COMPOSITOR.output.list.includes(this.keyboardNavigationMonitor)) {
      this.keyboardNavigationMonitor = null;
    }

    if (
      !this.currentMonitor ||
      !COMPOSITOR.output.list.includes(this.currentMonitor)
    ) {
      this.currentMonitor = this.preferredOutput();
    }
  }

  /**
   * The initial/fallback selected output: the lower MSI panel (DP-3) while it
   * is connected, otherwise the first live output.
   */
  private preferredOutput(): string {
    const outputs = COMPOSITOR.output.list;
    return outputs.includes(PREFERRED_DEFAULT_OUTPUT)
      ? PREFERRED_DEFAULT_OUTPUT
      : (outputs.at(0) ?? "");
  }

  private workspaceForMonitor(monitor: string): Workspace | undefined {
    if (!monitor) {
      return undefined;
    }
    return this.ensureWorkspace(
      monitor,
      this.activeWorkspaceByMonitor.get(monitor) ?? 1,
    );
  }

  private ensureWorkspace(monitor: string, index: number): Workspace {
    const key = workspaceKey(monitor, index);
    let workspace = this.workspaces.get(key);
    if (!workspace) {
      workspace = new Workspace(
        index,
        monitor,
        this.naturalRootRect,
        (window) => this.maximizedRectForWindow(window, monitor),
        (window) => this.outsetsFor(window),
        (monitor) => this.getActiveWorkspaceIndex(monitor),
      );
      this.workspaces.set(key, workspace);
    }
    return workspace;
  }

  private getActiveWorkspaceIndex(monitor: string): number {
    return this.activeWorkspaceByMonitor.get(monitor) ?? 1;
  }

  private gestureMonitor(event: GestureSwipeEvent): string {
    const outputName = event.outputName;
    if (outputName && COMPOSITOR.output.list.includes(outputName)) {
      return outputName;
    }
    return this.currentMonitor || this.preferredOutput();
  }

  private resolveWorkspaceGestureAxis(
    event: GestureSwipeEvent,
  ): "horizontal" | "vertical" | null {
    if (this.workspaceGestureAxis) {
      return this.workspaceGestureAxis;
    }

    const absX = Math.abs(event.totalX);
    const scaledAbsY = Math.abs(
      event.totalY * this.workspaceGestureSpeed.workspaceSwitchFactor,
    );
    if (Math.max(absX, scaledAbsY) < WORKSPACE_GESTURE_AXIS_LOCK_PX) {
      return null;
    }

    this.workspaceGestureAxis = absX > scaledAbsY ? "horizontal" : "vertical";
    return this.workspaceGestureAxis;
  }

  private updateWorkspaceGesture(event: GestureSwipeEvent) {
    const monitor = this.gestureMonitor(event);
    if (!monitor) {
      return;
    }

    const distance = Math.max(1, this.workspaceTransitionDistance(monitor));
    const scaledTotalY =
      event.totalY * this.workspaceGestureSpeed.workspaceSwitchFactor;
    const rawOffsetY = clamp(scaledTotalY, -distance, distance);
    if (Math.abs(rawOffsetY) < 1) {
      return;
    }

    const direction: -1 | 1 = rawOffsetY < 0 ? 1 : -1;
    const currentIndex = this.activeWorkspaceByMonitor.get(monitor) ?? 1;
    const nextIndex = isSpecialWorkspaceIndex(currentIndex) ? 1 : currentIndex + direction;
    const fromWorkspace = this.ensureWorkspace(monitor, currentIndex);
    const toWorkspace =
      isOrdinaryWorkspaceIndex(nextIndex) ? this.ensureWorkspace(monitor, nextIndex) : null;
    const targetChanged =
      this.workspaceGesture?.monitor !== monitor ||
      this.workspaceGesture.currentIndex !== currentIndex ||
      this.workspaceGesture.toWorkspace !== toWorkspace;

    this.currentMonitor = monitor;

    if (!toWorkspace) {
      if (targetChanged) {
        for (const workspace of this.workspaces.values()) {
          if (workspace.monitor !== monitor || workspace === fromWorkspace) {
            continue;
          }
          workspace.setVisible(workspace.isActive());
        }
      }
      const resistanceOffsetY = rawOffsetY * 0.25;
      fromWorkspace.setWorkspaceGestureVisual(resistanceOffsetY, 1);
      this.workspaceGesture = {
        monitor,
        currentIndex,
        direction,
        distance,
        fromWorkspace,
        toWorkspace: null,
        fromOffsetY: resistanceOffsetY,
        toOffsetY: direction * distance,
        fromOpacity: 1,
        toOpacity: 0,
      };
      return;
    }

    const progress = clamp(Math.abs(rawOffsetY) / distance, 0, 1);
    const toOffsetY = direction * distance + rawOffsetY;
    const fromOpacity = 1 - progress;
    const toOpacity = progress;

    if (targetChanged) {
      for (const workspace of this.workspaces.values()) {
        if (
          workspace.monitor !== monitor ||
          workspace === fromWorkspace ||
          workspace === toWorkspace
        ) {
          continue;
        }
        workspace.setVisible(workspace.isActive());
      }
      toWorkspace.applyLayout();
    }

    fromWorkspace.setWorkspaceGestureVisual(rawOffsetY, fromOpacity);
    toWorkspace.setWorkspaceGestureVisual(toOffsetY, toOpacity);
    this.applyWorkspaceStackPolicy(fromWorkspace);
    this.applyWorkspaceStackPolicy(toWorkspace);

    this.workspaceGesture = {
      monitor,
      currentIndex,
      direction,
      distance,
      fromWorkspace,
      toWorkspace,
      fromOffsetY: rawOffsetY,
      toOffsetY,
      fromOpacity,
      toOpacity,
    };
  }

  private finishWorkspaceGesture(event: GestureSwipeEvent) {
    const gesture = this.workspaceGesture;
    this.workspaceGesture = null;
    if (!gesture) {
      return;
    }

    const shouldCommit =
      event.phase === "end" &&
      gesture.toWorkspace !== null &&
      (Math.abs(
        event.totalY * this.workspaceGestureSpeed.workspaceSwitchFactor,
      ) >=
        gesture.distance * WORKSPACE_GESTURE_THRESHOLD_RATIO ||
        Math.abs(
          event.velocityY *
            this.workspaceGestureSpeed.workspaceSwitchVelocityFactor,
        ) >= WORKSPACE_GESTURE_VELOCITY_THRESHOLD);

    if (shouldCommit && gesture.toWorkspace) {
      this.activeWorkspaceByMonitor.set(
        gesture.monitor,
        gesture.toWorkspace.index,
      );
      this.currentMonitor = gesture.monitor;
      gesture.fromWorkspace.animateWorkspaceTransition({
        fromOffsetY: gesture.fromOffsetY,
        toOffsetY: -gesture.direction * gesture.distance,
        fromOpacity: gesture.fromOpacity,
        toOpacity: 0,
        visibleAfter: false,
      });
      gesture.toWorkspace.animateWorkspaceTransition({
        fromOffsetY: gesture.toOffsetY,
        toOffsetY: 0,
        fromOpacity: gesture.toOpacity,
        toOpacity: 1,
        visibleAfter: true,
      });
      gesture.toWorkspace.focusActiveWindow();
      this.applyWorkspaceStackPolicy(gesture.fromWorkspace);
      this.applyWorkspaceStackPolicy(gesture.toWorkspace);
      return;
    }

    gesture.fromWorkspace.animateWorkspaceTransition({
      fromOffsetY: gesture.fromOffsetY,
      toOffsetY: 0,
      fromOpacity: gesture.fromOpacity,
      toOpacity: 1,
      visibleAfter: true,
    });
    if (gesture.toWorkspace) {
      gesture.toWorkspace.animateWorkspaceTransition({
        fromOffsetY: gesture.toOffsetY,
        toOffsetY: gesture.direction * gesture.distance,
        fromOpacity: gesture.toOpacity,
        toOpacity: 0,
        visibleAfter: false,
      });
    }
    this.applyWorkspaceStackPolicy(gesture.fromWorkspace);
  }

  /**
   * Focus follows the pointer, no click: any window under the cursor gains
   * focus — tiled members, floating windows, and windows on fully floating
   * workspaces alike. Guards preserved from the tile-only predecessor:
   * only real window targets (a layer surface such as a panel or menu is
   * authoritative and never focuses the app beneath it), active workspaces
   * only, no minimized windows, transient-family protection (hovering a
   * transient's parent must not steal a modal's focus), no repeated focus of
   * the already-focused window, and no focus stealing while an interactive
   * drag/resize owned by this manager is in flight. Empty desktop does not
   * clear focus. Geometry and stacking are untouched here; onFocus performs
   * MRU/broadcast/raise.
   */
  private focusWindowAtPointerTarget(
    target: PointerMoveEvent["target"],
    monitorHint?: string,
  ) {
    if (target.kind !== "window") {
      return;
    }
    if (this.isGrabbing || this.resizingWindowId || this.tileDrag || this.floatingDrag) {
      return;
    }

    const workspace = Array.from(this.workspaces.values()).find((workspace) =>
      workspace.findWindowById(target.windowId),
    );
    const window = workspace?.findWindowById(target.windowId);
    if (!workspace || !window || !workspace.isActive()) {
      return;
    }

    const focused = workspace.focusWindowUnderPointer(window);
    if (!focused) {
      return;
    }

    this.currentMonitor =
      monitorHint && COMPOSITOR.output.list.includes(monitorHint)
        ? monitorHint
        : workspace.monitor;
  }

  private availableWorkspaceIndex(monitor: string, preferredIndex: number) {
    if (isSpecialWorkspaceIndex(preferredIndex)) {
      return preferredIndex;
    }
    const preferred = this.restoredWorkspaceIndex(preferredIndex);
    const workspace = this.workspaces.get(workspaceKey(monitor, preferred));
    if (!workspace || workspace.windowCount() === 0) {
      return preferred;
    }
    for (let index = 1; index <= WORKSPACES_PER_OUTPUT; index += 1) {
      const candidate = this.workspaces.get(workspaceKey(monitor, index));
      if (!candidate || candidate.windowCount() === 0) {
        return index;
      }
    }
    return preferred;
  }

  private syncWorkspaceVisibility() {
    for (const workspace of this.workspaces.values()) {
      workspace.setVisible(workspace.isActive());
    }
  }

  private findWorkspaceForWindow(window: WaylandWindow): Workspace | undefined {
    for (const workspace of this.workspaces.values()) {
      if (workspace.hasWindow(window)) {
        return workspace;
      }
    }
    return undefined;
  }

  private findWorkspaceRestoringWindow(
    window: WaylandWindow,
  ): Workspace | undefined {
    for (const workspace of this.workspaces.values()) {
      if (workspace.isRestoringWindow(window.id)) {
        return workspace;
      }
    }
    return undefined;
  }

  private workspaceForTileDrag(
    event: WindowMoveEvent,
    drag: NonNullable<HybridWindowManager["tileDrag"]>,
  ): Workspace {
    const monitor =
      event.outputName && COMPOSITOR.output.list.includes(event.outputName)
        ? event.outputName
        : drag.workspace.monitor;
    let index = this.activeWorkspaceByMonitor.get(monitor) ?? 1;
    const edgeDirection = this.tileDragWorkspaceEdgeDirection(
      monitor,
      event.currentPointer.y,
    );

    if (
      event.modifiers.shift &&
      edgeDirection !== 0 &&
      event.timestamp - drag.lastWorkspaceSwitchAt >=
        TILE_DRAG_WORKSPACE_SWITCH_INTERVAL_MS
    ) {
      const nextIndex = clamp(index + edgeDirection, 1, WORKSPACES_PER_OUTPUT);
      if (nextIndex !== index) {
        this.currentMonitor = monitor;
        this.switchWorkspace(edgeDirection);
        drag.lastWorkspaceSwitchAt = event.timestamp;
        index = this.activeWorkspaceByMonitor.get(monitor) ?? nextIndex;
      }
    }

    return this.ensureWorkspace(monitor, index);
  }

  private workspaceForFloatingDrag(
    event: WindowMoveEvent,
    drag: NonNullable<HybridWindowManager["floatingDrag"]>,
  ): Workspace {
    const monitor =
      event.outputName && COMPOSITOR.output.list.includes(event.outputName)
        ? event.outputName
        : drag.workspace.monitor;
    let index = this.activeWorkspaceByMonitor.get(monitor) ?? 1;
    const edgeDirection = this.tileDragWorkspaceEdgeDirection(
      monitor,
      event.currentPointer.y,
    );

    if (
      event.modifiers.shift &&
      edgeDirection !== 0 &&
      event.timestamp - drag.lastWorkspaceSwitchAt >=
        TILE_DRAG_WORKSPACE_SWITCH_INTERVAL_MS
    ) {
      const nextIndex = clamp(index + edgeDirection, 1, WORKSPACES_PER_OUTPUT);
      if (nextIndex !== index) {
        this.currentMonitor = monitor;
        this.switchWorkspace(edgeDirection);
        drag.lastWorkspaceSwitchAt = event.timestamp;
        index = this.activeWorkspaceByMonitor.get(monitor) ?? nextIndex;
      }
    }

    return this.ensureWorkspace(monitor, index);
  }

  private tileDragWorkspaceEdgeDirection(
    monitor: string,
    y: number,
  ): -1 | 0 | 1 {
    const rect = this.workspaceViewportRect(monitor);
    const top = read(rect.y);
    const height = read(rect.height);
    if (y < top + TILE_DRAG_WORKSPACE_EDGE_PX) {
      return -1;
    }
    if (y > top + height - TILE_DRAG_WORKSPACE_EDGE_PX) {
      return 1;
    }
    return 0;
  }

  private workspaceTransitionDistance(monitor: string): number {
    return read(this.workspaceViewportRect(monitor).height);
  }

  private workspaceViewportRect(monitor: string): ManagedWindowRect {
    const usable = COMPOSITOR.layer.usableArea(monitor);
    if (usable) {
      return usable;
    }

    const output = COMPOSITOR.output.current[monitor];
    if (output?.resolution) {
      return {
        x: output.position.x,
        y: output.position.y,
        width: output.resolution.width / output.scale,
        height: output.resolution.height / output.scale,
      };
    }

    return {
      x: 0,
      y: 0,
      width: 1280,
      height: 720,
    };
  }

  private constrainResizeRect(event: WindowResizeEvent): ManagedWindowRect {
    const constraints = event.window.sizeConstraints();
    const extra = this.clientToRootSizeExtra(event.window);
    const minWidth = Math.max(1, constraints.min?.width ?? 1) + extra.width;
    const minHeight = Math.max(1, constraints.min?.height ?? 1) + extra.height;
    // Client maxima stay client-sized: the root ceiling is client max + frame
    // extra (insets included), exactly as before decoration outsets existed.
    const maxWidth = constrainedMax(constraints, "width", extra.width);
    const maxHeight = constrainedMax(constraints, "height", extra.height);

    // Decorated windows: additionally cap the dragged axis so root + external
    // ornament footprint stays inside the monitor bounds, measured from the
    // fixed opposite resize edge. Anchors already off-monitor are left alone
    // (no teleporting); snap-layout resizes are handled by the layout clamps.
    let cappedMaxWidth = maxWidth;
    let cappedMaxHeight = maxHeight;
    const outsets = this.outsetsFor(event.window);
    const decorated =
      outsets.left !== 0 ||
      outsets.right !== 0 ||
      outsets.top !== 0 ||
      outsets.bottom !== 0;
    if (decorated) {
      const workspace = this.findWorkspaceForWindow(event.window);
      if (workspace) {
        const viewport = this.workspaceViewportRect(workspace.monitor);
        const vpLeft = read(viewport.x);
        const vpTop = read(viewport.y);
        const vpRight = vpLeft + read(viewport.width);
        const vpBottom = vpTop + read(viewport.height);
        // Cap only while the FIXED opposite edge (including its footprint
        // outset) is inside the viewport footprint bounds; an anchor already
        // off-monitor must not be teleported by a cap.
        if (event.edges.right !== event.edges.left) {
          const fixedInside = event.edges.right
            ? vpLeft <= event.startRect.x - outsets.left &&
              event.startRect.x - outsets.left <= vpRight
            : vpLeft <= event.startRect.x + event.startRect.width + outsets.right &&
              event.startRect.x + event.startRect.width + outsets.right <= vpRight;
          if (fixedInside) {
            const bound = event.edges.right
              ? vpRight - outsets.right - event.startRect.x
              : event.startRect.x + event.startRect.width -
                vpLeft -
                outsets.left;
            if (bound >= minWidth) {
              cappedMaxWidth = Math.min(cappedMaxWidth, bound);
            }
          }
        }
        if (event.edges.bottom !== event.edges.top) {
          const fixedInside = event.edges.bottom
            ? vpTop <= event.startRect.y - outsets.top &&
              event.startRect.y - outsets.top <= vpBottom
            : vpTop <= event.startRect.y + event.startRect.height + outsets.bottom &&
              event.startRect.y + event.startRect.height + outsets.bottom <= vpBottom;
          if (fixedInside) {
            const bound = event.edges.bottom
              ? vpBottom - outsets.bottom - event.startRect.y
              : event.startRect.y + event.startRect.height -
                vpTop -
                outsets.top;
            if (bound >= minHeight) {
              cappedMaxHeight = Math.min(cappedMaxHeight, bound);
            }
          }
        }
      }
    }

    const width = clamp(
      event.currentRect.width,
      minWidth,
      Math.max(minWidth, cappedMaxWidth),
    );
    const height = clamp(
      event.currentRect.height,
      minHeight,
      Math.max(minHeight, cappedMaxHeight),
    );

    return {
      x: resizeOriginForAxis(
        event.startRect,
        event.currentRect,
        width,
        event.edges.left,
        "x",
      ),
      y: resizeOriginForAxis(
        event.startRect,
        event.currentRect,
        height,
        event.edges.top,
        "y",
      ),
      width,
      height,
    };
  }

  private clientToRootSizeExtra(window: WaylandWindow): {
    width: number;
    height: number;
  } {
    const natural = this.naturalRootRect(window);
    return {
      width: Math.max(0, read(natural.width) - window.position.width),
      height: Math.max(0, read(natural.height) - window.position.height),
    };
  }

  /**
   * Maximized available rectangle: the existing MAXIMIZED_WINDOW_PADDING plus
   * this window's own decoration footprint, so the painted root stays inside
   * the padded area while ornaments extend into the reserve.
   */
  private maximizedPaddingFor(
    window: WaylandWindow,
  ): { top: number; right: number; bottom: number; left: number } {
    const outsets = this.outsetsFor(window);
    return {
      top: MAXIMIZED_WINDOW_PADDING.top + outsets.top,
      right: MAXIMIZED_WINDOW_PADDING.right + outsets.right,
      bottom: MAXIMIZED_WINDOW_PADDING.bottom + outsets.bottom,
      left: MAXIMIZED_WINDOW_PADDING.left + outsets.left,
    };
  }

  private maximizedRectForWindow(
    window: WaylandWindow,
    preferredOutput?: string,
  ): ManagedWindowRect {
    const rect = window.state[WINDOW_STATE_RECT]();
    const centerX = read(rect.x) + read(rect.width) / 2;
    const centerY = read(rect.y) + read(rect.height) / 2;
    const outputName =
      preferredOutput ??
      this.outputNameAt(centerX, centerY) ??
      this.currentMonitor;
    const output = outputName
      ? COMPOSITOR.output.current[outputName]
      : undefined;
    const usable = outputName
      ? COMPOSITOR.layer.usableArea(outputName)
      : undefined;

    if (usable) {
      return insetRect(
        {
          x: usable.x,
          y: usable.y,
          width: usable.width,
          height: usable.height,
        },
        this.maximizedPaddingFor(window),
      );
    }
    if (output?.resolution) {
      return insetRect(
        {
          x: output.position.x,
          y: output.position.y,
          width: output.resolution.width / output.scale,
          height: output.resolution.height / output.scale,
        },
        this.maximizedPaddingFor(window),
      );
    }
    return rect;
  }

  // Fullscreen covers the entire output: unlike maximize it ignores the
  // usable area (exclusive-zone bars) and applies no padding, so the client
  // surface spans edge to edge. This is also what lets the tty backend
  // collapse the frame to a single scanout-capable element.
  private fullscreenRectForWindow(
    window: WaylandWindow,
    preferredOutput?: string,
  ): ManagedWindowRect {
    const rect = window.state[WINDOW_STATE_RECT]();
    const centerX = read(rect.x) + read(rect.width) / 2;
    const centerY = read(rect.y) + read(rect.height) / 2;
    const outputName =
      preferredOutput ??
      this.outputNameAt(centerX, centerY) ??
      this.currentMonitor;
    const output = outputName
      ? COMPOSITOR.output.current[outputName]
      : undefined;
    if (output?.resolution) {
      return {
        x: output.position.x,
        y: output.position.y,
        width: output.resolution.width / output.scale,
        height: output.resolution.height / output.scale,
      };
    }
    return rect;
  }

  public onWindowFullscreenRequest(event: WindowFullscreenRequestEvent) {
    // Same ownership rule as the maximize guard: a resize grab owns its
    // unmaximize path (beginInteractiveUnmaximize); suppress native
    // full/unfull requests for that window mid-grab.
    if (this.isGrabbing || this.resizingWindowId === event.window.id) {
      return;
    }
    const window = event.window;
    const workspace = this.findWorkspaceForWindow(window);
    window.state[WINDOW_STATE_MINIMIZED].set(false);
    this.clearWindowSnapState(window);

    if (!event.fullscreen) {
      const restoreRect = window.state[WINDOW_STATE_FULLSCREEN_RESTORE_RECT]();
      window.state[WINDOW_STATE_FULLSCREEN].set(false);
      window.state[WINDOW_STATE_FULLSCREEN_RESTORE_RECT].set(null);
      // A tiled window returns to its computed slot; a floating one animates
      // back to where it was before going fullscreen.
      if (workspace?.isTiled && workspace.isTileCandidate(window)) {
        workspace.applyLayout();
        this.applyWorkspaceStackPolicy(workspace);
        return;
      }
      // A window that was (or became) maximized while fullscreen goes back
      // to the maximized rect, not to the rect it had before maximizing.
      const targetRect = window.state[WINDOW_STATE_MAXIMIZED]()
        ? this.maximizedRectForWindow(window)
        : restoreRect;
      if (targetRect) {
        workspace?.syncFloatingWindowRect(window, targetRect);
        playRectAnimation(
          window,
          WINDOW_STATE_RECT,
          targetRect,
          WINDOW_MANAGEMENT_EASING,
          WINDOW_MANAGEMENT_ANIMATION_DURATION,
        );
      }
      this.applyWorkspaceStackPolicy(workspace);
      return;
    }

    if (!window.state[WINDOW_STATE_FULLSCREEN]()) {
      const currentRect = window.state[WINDOW_STATE_RECT]();
      const currentWidth = read(currentRect.width);
      const currentHeight = read(currentRect.height);
      if (currentWidth > 1 && currentHeight > 1) {
        window.state[WINDOW_STATE_FULLSCREEN_RESTORE_RECT].set(currentRect);
      }
    }
    const fullscreenRect = this.fullscreenRectForWindow(
      window,
      event.outputName,
    );
    window.state[WINDOW_STATE_FULLSCREEN].set(true);
    workspace?.focusWindow(window);
    workspace?.syncFloatingWindowRect(window, fullscreenRect);
    playRectAnimation(
      window,
      WINDOW_STATE_RECT,
      fullscreenRect,
      WINDOW_MANAGEMENT_EASING,
      WINDOW_MANAGEMENT_ANIMATION_DURATION,
    );
    this.applyWorkspaceStackPolicy(workspace);
    window.focus();
  }

  private initialRestoreRectForMaximizedWindow(
    window: WaylandWindow,
  ): ManagedWindowRect {
    const maximizedRect = this.maximizedRectForWindow(window);
    const width = Math.max(1, read(maximizedRect.width) * 0.7);
    const height = Math.max(1, read(maximizedRect.height) * 0.7);
    return {
      x: read(maximizedRect.x) + (read(maximizedRect.width) - width) / 2,
      y: read(maximizedRect.y) + (read(maximizedRect.height) - height) / 2,
      width,
      height,
    };
  }

  private restoreRectForMaximizedMove(
    event: WindowMoveEvent,
    width: number,
    height: number,
  ): ManagedWindowRect {
    const pointer = event.currentPointer;
    const titlebarCenterY = WINDOW_BORDER_PX + TITLEBAR_HEIGHT / 2;
    const pointerOffsetY =
      event.source === "modifier"
        ? height / 2
        : Math.min(height / 2, titlebarCenterY);

    return {
      x: pointer.x - width / 2,
      y: pointer.y - pointerOffsetY,
      width,
      height,
    };
  }

  private outputNameAt(x: number, y: number): string | undefined {
    for (const name of COMPOSITOR.output.list) {
      const output = COMPOSITOR.output.current[name];
      if (!output?.resolution) {
        continue;
      }
      const width = output.resolution.width / output.scale;
      const height = output.resolution.height / output.scale;
      if (
        x >= output.position.x &&
        y >= output.position.y &&
        x < output.position.x + width &&
        y < output.position.y + height
      ) {
        return name;
      }
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Snap zones (Windows-style edge snapping for floating drags + tiling drag
  // slot preview). The bar renders the preview rect; this side decides the
  // zone, broadcasts the preview, and applies the snap on drop.
  // -------------------------------------------------------------------------

  public setSnapPreviewBroadcaster(broadcaster: SnapPreviewBroadcaster | null) {
    this.snapPreviewBroadcaster = broadcaster;
  }

  public setWorkspaceChangeBroadcaster(
    broadcaster: WorkspaceChangeBroadcaster | null,
  ) {
    this.workspaceChangeBroadcaster = broadcaster;
  }

  /** Full logical rect of a monitor (ignores reserved insets). */
  private monitorFullRect(monitor: string): ManagedWindowRect | null {
    const output = COMPOSITOR.output.current[monitor];
    if (!output?.resolution) {
      return null;
    }
    return {
      x: output.position.x,
      y: output.position.y,
      width: output.resolution.width / output.scale,
      height: output.resolution.height / output.scale,
    };
  }

  /**
   * Keyboard directional navigation only: warp the pointer to the center of
   * `rect`'s visible part clipped to `monitor`'s full logical rect. Skips the
   * warp when the output is unknown or the intersection has no positive area
   * (fully off-output or borderless clip). Never called from generic focus
   * handling or pointer paths.
   */
  private warpCursorToVisibleRectCenter(monitor: string, rect: TileRect): void {
    const full = this.monitorFullRect(monitor);
    if (!full) {
      return;
    }
    const fullX = read(full.x);
    const fullY = read(full.y);
    const left = Math.max(rect.x, fullX);
    const top = Math.max(rect.y, fullY);
    const right = Math.min(rect.x + rect.width, fullX + read(full.width));
    const bottom = Math.min(rect.y + rect.height, fullY + read(full.height));
    if (right <= left || bottom <= top) {
      return;
    }
    COMPOSITOR.cursor.warp({ x: (left + right) / 2, y: (top + bottom) / 2 });
  }

  /** Usable area inset by the maximized padding — the base for all snap rects. */
  private monitorSnapBaseRect(monitor: string): ManagedWindowRect | null {
    const usable =
      COMPOSITOR.layer.usableArea(monitor) ?? this.monitorFullRect(monitor);
    if (!usable) {
      return null;
    }
    return insetRect(usable, MAXIMIZED_WINDOW_PADDING);
  }

  /** Resolve the snap zone for a pointer near the physical screen edges. */
  private floatingSnapZoneAt(
    monitor: string,
    px: number,
    py: number,
  ): SnapZone | null {
    const full = this.monitorFullRect(monitor);
    if (!full) {
      return null;
    }
    const left = read(full.x);
    const top = read(full.y);
    const right = left + read(full.width);
    const bottom = top + read(full.height);

    const nearLeft = px <= left + SNAP_EDGE_PX;
    const nearRight = px >= right - SNAP_EDGE_PX;
    const nearTop = py <= top + SNAP_EDGE_PX;

    // Corners win over edges so the quarters stay reachable.
    if (nearLeft && py <= top + SNAP_CORNER_PX) return "top-left";
    if (nearLeft && py >= bottom - SNAP_CORNER_PX) return "bottom-left";
    if (nearRight && py <= top + SNAP_CORNER_PX) return "top-right";
    if (nearRight && py >= bottom - SNAP_CORNER_PX) return "bottom-right";
    if (nearTop) return "maximize";
    if (nearLeft) return "left";
    if (nearRight) return "right";
    return null;
  }

  /** Target rect (global logical coords) for a snap zone on a monitor. */
  private snapZoneRect(
    monitor: string,
    zone: SnapZone,
  ): ManagedWindowRect | null {
    const base = this.monitorSnapBaseRect(monitor);
    if (!base) {
      return null;
    }
    const bx = read(base.x);
    const by = read(base.y);
    const bw = read(base.width);
    const bh = read(base.height);
    const halfW = (bw - SNAP_GAP_PX) / 2;
    const halfH = (bh - SNAP_GAP_PX) / 2;
    const rightX = bx + halfW + SNAP_GAP_PX;
    const bottomY = by + halfH + SNAP_GAP_PX;

    switch (zone) {
      case "maximize":
        return { x: bx, y: by, width: bw, height: bh };
      case "left":
        return { x: bx, y: by, width: halfW, height: bh };
      case "right":
        return { x: rightX, y: by, width: halfW, height: bh };
      case "top-left":
        return { x: bx, y: by, width: halfW, height: halfH };
      case "top-right":
        return { x: rightX, y: by, width: halfW, height: halfH };
      case "bottom-left":
        return { x: bx, y: bottomY, width: halfW, height: halfH };
      case "bottom-right":
        return { x: rightX, y: bottomY, width: halfW, height: halfH };
    }
  }

  private resizeFloatingSnapLayout(
    event: WindowResizeEvent,
    workspace: Workspace,
    nextRect: ManagedWindowRect,
  ): boolean {
    if (workspace.isTiled) {
      return false;
    }

    const zone = event.window.state[WINDOW_STATE_SNAP_ZONE]();
    if (!isLayoutSnapZone(zone)) {
      return false;
    }

    const monitor =
      event.window.state[WINDOW_STATE_SNAP_MONITOR]() || workspace.monitor;
    const base = this.monitorSnapBaseRect(monitor);
    if (!base) {
      return false;
    }

    const snappedWindows = workspace
      .listWindows()
      .filter((window) => this.isWindowInFloatingSnapLayout(window, monitor));
    if (!snappedWindows.some((window) => window.id === event.window.id)) {
      return false;
    }

    const layout = this.floatingSnapLayoutFromWindows(base, snappedWindows);
    // The resized rect is the window root; express its dragged edge as the
    // external footprint boundary the split coordinate lives in.
    const outsets = this.outsetsFor(event.window);
    let changed = false;

    if (event.edges.right && isLeftSnapZone(zone)) {
      layout.splitX = read(nextRect.x) + read(nextRect.width) + outsets.right;
      changed = true;
    } else if (event.edges.left && isRightSnapZone(zone)) {
      layout.splitX = read(nextRect.x) - outsets.left - SNAP_GAP_PX;
      changed = true;
    }

    if (event.edges.bottom && isTopSnapZone(zone)) {
      if (snapColumn(zone) === "left") {
        layout.leftSplitY = read(nextRect.y) + read(nextRect.height) + outsets.bottom;
      } else {
        layout.rightSplitY = read(nextRect.y) + read(nextRect.height) + outsets.bottom;
      }
      changed = true;
    } else if (event.edges.top && isBottomSnapZone(zone)) {
      if (snapColumn(zone) === "left") {
        layout.leftSplitY = read(nextRect.y) - outsets.top - SNAP_GAP_PX;
      } else {
        layout.rightSplitY = read(nextRect.y) - outsets.top - SNAP_GAP_PX;
      }
      changed = true;
    }

    if (!changed) {
      return false;
    }

    this.clampFloatingSnapLayout(base, layout, snappedWindows);
    this.applyFloatingSnapLayout(base, layout, snappedWindows);
    return true;
  }

  private isWindowInFloatingSnapLayout(
    window: WaylandWindow,
    monitor: string,
  ): boolean {
    return (
      isLayoutSnapZone(window.state[WINDOW_STATE_SNAP_ZONE]()) &&
      window.state[WINDOW_STATE_SNAP_MONITOR]() === monitor &&
      !window.state[WINDOW_STATE_MINIMIZED]() &&
      !window.state[WINDOW_STATE_MAXIMIZED]() &&
      !window.state[WINDOW_STATE_FULLSCREEN]() &&
      !window.isFullscreen()
    );
  }

  private floatingSnapLayoutFromWindows(
    base: ManagedWindowRect,
    windows: WaylandWindow[],
  ): FloatingSnapLayout {
    const bx = read(base.x);
    const by = read(base.y);
    const bw = read(base.width);
    const bh = read(base.height);
    const defaultSplitX = bx + (bw - SNAP_GAP_PX) / 2;
    const defaultSplitY = by + (bh - SNAP_GAP_PX) / 2;
    const splitXSamples: number[] = [];
    const leftSplitYSamples: number[] = [];
    const rightSplitYSamples: number[] = [];

    for (const window of windows) {
      const zone = window.state[WINDOW_STATE_SNAP_ZONE]();
      if (!isLayoutSnapZone(zone)) {
        continue;
      }
      const rect = window.state[WINDOW_STATE_RECT]();
      // Split boundaries are footprint-allocation coordinates: convert the
      // sampled root edge to its external footprint edge first.
      const outsets = this.outsetsFor(window);
      if (isLeftSnapZone(zone)) {
        splitXSamples.push(read(rect.x) + read(rect.width) + outsets.right);
      } else {
        splitXSamples.push(read(rect.x) - outsets.left - SNAP_GAP_PX);
      }

      if (isTopSnapZone(zone)) {
        const samples =
          snapColumn(zone) === "left" ? leftSplitYSamples : rightSplitYSamples;
        samples.push(read(rect.y) + read(rect.height) + outsets.bottom);
      } else if (isBottomSnapZone(zone)) {
        const samples =
          snapColumn(zone) === "left" ? leftSplitYSamples : rightSplitYSamples;
        samples.push(read(rect.y) - outsets.top - SNAP_GAP_PX);
      }
    }

    return {
      splitX: averageOr(splitXSamples, defaultSplitX),
      leftSplitY: averageOr(leftSplitYSamples, defaultSplitY),
      rightSplitY: averageOr(rightSplitYSamples, defaultSplitY),
    };
  }

  private clampFloatingSnapLayout(
    base: ManagedWindowRect,
    layout: FloatingSnapLayout,
    windows: WaylandWindow[],
  ): void {
    const bx = read(base.x);
    const by = read(base.y);
    const bw = read(base.width);
    const bh = read(base.height);
    const groups = this.floatingSnapMinSizeGroups(windows);

    layout.splitX = clamp(
      layout.splitX,
      bx + groups.leftWidth,
      bx + bw - SNAP_GAP_PX - groups.rightWidth,
    );
    layout.leftSplitY = clamp(
      layout.leftSplitY,
      by + groups.leftTopHeight,
      by + bh - SNAP_GAP_PX - groups.leftBottomHeight,
    );
    layout.rightSplitY = clamp(
      layout.rightSplitY,
      by + groups.rightTopHeight,
      by + bh - SNAP_GAP_PX - groups.rightBottomHeight,
    );
  }

  private floatingSnapMinSizeGroups(windows: WaylandWindow[]): {
    leftWidth: number;
    rightWidth: number;
    leftTopHeight: number;
    leftBottomHeight: number;
    rightTopHeight: number;
    rightBottomHeight: number;
  } {
    const groups = {
      leftWidth: 1,
      rightWidth: 1,
      leftTopHeight: 1,
      leftBottomHeight: 1,
      rightTopHeight: 1,
      rightBottomHeight: 1,
    };

    for (const window of windows) {
      const zone = window.state[WINDOW_STATE_SNAP_ZONE]();
      if (!isLayoutSnapZone(zone)) {
        continue;
      }

      const minSize = this.floatingSnapMinSize(window);
      if (isLeftSnapZone(zone)) {
        groups.leftWidth = Math.max(groups.leftWidth, minSize.width);
      } else {
        groups.rightWidth = Math.max(groups.rightWidth, minSize.width);
      }

      if (isTopSnapZone(zone)) {
        if (snapColumn(zone) === "left") {
          groups.leftTopHeight = Math.max(groups.leftTopHeight, minSize.height);
        } else {
          groups.rightTopHeight = Math.max(
            groups.rightTopHeight,
            minSize.height,
          );
        }
      } else if (isBottomSnapZone(zone)) {
        if (snapColumn(zone) === "left") {
          groups.leftBottomHeight = Math.max(
            groups.leftBottomHeight,
            minSize.height,
          );
        } else {
          groups.rightBottomHeight = Math.max(
            groups.rightBottomHeight,
            minSize.height,
          );
        }
      }
    }

    return groups;
  }

  private floatingSnapMinSize(window: WaylandWindow): {
    width: number;
    height: number;
  } {
    const constraints = window.sizeConstraints();
    const extra = this.clientToRootSizeExtra(window);
    // A snapped window's allocation holds root frame extra (insets) AND the
    // external decoration footprint; both must survive the apply-time inset.
    const outsets = this.outsetsFor(window);
    return {
      width:
        Math.max(1, constraints.min?.width ?? 1) +
        extra.width +
        outsets.left +
        outsets.right,
      height:
        Math.max(1, constraints.min?.height ?? 1) +
        extra.height +
        outsets.top +
        outsets.bottom,
    };
  }

  private applyFloatingSnapLayout(
    base: ManagedWindowRect,
    layout: FloatingSnapLayout,
    windows: WaylandWindow[],
  ): void {
    for (const window of windows) {
      const zone = window.state[WINDOW_STATE_SNAP_ZONE]();
      if (!isLayoutSnapZone(zone)) {
        continue;
      }

      const rect = insetRect(
        this.floatingSnapRectForZone(base, layout, zone),
        this.outsetsFor(window),
      );
      stopRectAnimation(window, WINDOW_STATE_RECT);
      window.state[WINDOW_STATE_RECT].set(rect);
      // Keep the floating restore point at the applied root so a reload
      // restores the footprint-fitted geometry, not a stale allocation.
      this.findWorkspaceForWindow(window)?.syncFloatingWindowRect(window, rect);
    }
  }

  private floatingSnapRectForZone(
    base: ManagedWindowRect,
    layout: FloatingSnapLayout,
    zone: LayoutSnapZone,
  ): ManagedWindowRect {
    const bx = read(base.x);
    const by = read(base.y);
    const bw = read(base.width);
    const bh = read(base.height);
    const rightX = layout.splitX + SNAP_GAP_PX;
    const leftWidth = Math.max(1, layout.splitX - bx);
    const rightWidth = Math.max(1, bx + bw - rightX);

    switch (zone) {
      case "left":
        return { x: bx, y: by, width: leftWidth, height: bh };
      case "right":
        return { x: rightX, y: by, width: rightWidth, height: bh };
      case "top-left":
        return {
          x: bx,
          y: by,
          width: leftWidth,
          height: Math.max(1, layout.leftSplitY - by),
        };
      case "bottom-left": {
        const y = layout.leftSplitY + SNAP_GAP_PX;
        return {
          x: bx,
          y,
          width: leftWidth,
          height: Math.max(1, by + bh - y),
        };
      }
      case "top-right":
        return {
          x: rightX,
          y: by,
          width: rightWidth,
          height: Math.max(1, layout.rightSplitY - by),
        };
      case "bottom-right": {
        const y = layout.rightSplitY + SNAP_GAP_PX;
        return {
          x: rightX,
          y,
          width: rightWidth,
          height: Math.max(1, by + bh - y),
        };
      }
    }
  }

  private setWindowSnapState(
    workspace: Workspace | undefined,
    window: WaylandWindow,
    monitor: string,
    zone: LayoutSnapZone,
  ): void {
    if (workspace) {
      for (const other of workspace.listWindows()) {
        if (other.id === window.id) {
          continue;
        }
        if (
          other.state[WINDOW_STATE_SNAP_MONITOR]() === monitor &&
          snapZonesConflict(other.state[WINDOW_STATE_SNAP_ZONE](), zone)
        ) {
          this.clearWindowSnapState(other);
        }
      }
    }

    window.state[WINDOW_STATE_SNAP_ZONE].set(zone);
    window.state[WINDOW_STATE_SNAP_MONITOR].set(monitor);
  }

  private clearWindowSnapState(window: WaylandWindow): void {
    window.state[WINDOW_STATE_SNAP_ZONE].set(null);
    window.state[WINDOW_STATE_SNAP_MONITOR].set(null);
  }

  /** Broadcast a preview rect (converted to monitor-local) or a hide (null). */
  private emitSnapPreview(
    monitor: string,
    rect: ManagedWindowRect | null,
    kind: "floating" | "tiling",
  ) {
    if (!this.snapPreviewBroadcaster) {
      return;
    }
    if (!rect) {
      this.snapPreviewBroadcaster({ monitor, rect: null, kind });
      return;
    }
    const output = COMPOSITOR.output.current[monitor];
    const ox = output?.position.x ?? 0;
    const oy = output?.position.y ?? 0;
    this.snapPreviewBroadcaster({
      monitor,
      kind,
      rect: {
        x: read(rect.x) - ox,
        y: read(rect.y) - oy,
        width: read(rect.width),
        height: read(rect.height),
      },
    });
  }

  /** Update the floating-drag snap candidate + preview during a move. */
  private updateFloatingDragSnap(event: WindowMoveEvent) {
    if (event.modifiers.shift) {
      this.clearFloatingSnapPreview();
      return;
    }
    if (event.phase === "start") {
      this.clearFloatingSnapPreview();
      return;
    }
    if (event.phase === "end" || event.phase === "cancel") {
      return;
    }

    const monitor =
      event.outputName && COMPOSITOR.output.list.includes(event.outputName)
        ? event.outputName
        : this.currentMonitor;
    const zone = monitor
      ? this.floatingSnapZoneAt(
          monitor,
          event.currentPointer.x,
          event.currentPointer.y,
        )
      : null;

    if (!monitor || !zone) {
      this.clearFloatingSnapPreview();
      return;
    }

    const rect = this.snapZoneRect(monitor, zone);
    if (!rect) {
      this.clearFloatingSnapPreview();
      return;
    }
    if (
      this.floatingSnap &&
      (this.floatingSnap.windowId !== event.window.id ||
        this.floatingSnap.monitor !== monitor)
    ) {
      this.emitSnapPreview(this.floatingSnap.monitor, null, "floating");
    }
    this.floatingSnap = { windowId: event.window.id, monitor, zone, rect };
    this.emitSnapPreview(monitor, rect, "floating");
  }

  private clearFloatingSnapPreview() {
    if (!this.floatingSnap) {
      return;
    }
    this.emitSnapPreview(this.floatingSnap.monitor, null, "floating");
    this.floatingSnap = null;
  }

  /**
   * Apply the pending snap on drop (or clear it on cancel). Returns true if the
   * window was snapped, so the caller skips leaving it at the drop position.
   */
  private finishFloatingDragSnap(
    event: WindowMoveEvent,
    workspace: Workspace | undefined,
  ): boolean {
    if (event.modifiers.shift) {
      this.clearFloatingSnapPreview();
      return false;
    }
    const snap = this.floatingSnap;
    this.floatingSnap = null;
    if (!snap || snap.windowId !== event.window.id) {
      if (snap) {
        this.emitSnapPreview(snap.monitor, null, "floating");
      }
      return false;
    }

    this.emitSnapPreview(snap.monitor, null, "floating");
    if (event.phase !== "end") {
      return false;
    }

    const window = event.window;
    const isMaximized = window.state[WINDOW_STATE_MAXIMIZED]();

    if (snap.zone === "maximize") {
      this.clearWindowSnapState(window);
      // Route through the real maximize so the compositor `isMaximized` state
      // (and therefore the SSD maximize/restore icon) stays in sync. Calling
      // maximize() fires onWindowMaximizeRequest, which applies the rect.
      if (!isMaximized) {
        window.maximize();
      } else {
        // Already maximized (e.g. re-dropped on the top edge): just re-apply
        // the maximized rect for the monitor under the cursor.
        const rect = this.maximizedRectForWindow(window);
        playRectAnimation(
          window,
          WINDOW_STATE_RECT,
          rect,
          WINDOW_MANAGEMENT_EASING,
          WINDOW_MANAGEMENT_ANIMATION_DURATION,
        );
        workspace?.syncFloatingWindowRect(window, rect);
      }
    } else {
      // Half / quarter: ensure the window is unmaximized first (syncs the SSD
      // icon), with the restore rect cleared so unmaximize() does not animate
      // back to it and fight the snap, then place it at the zone rect.
      if (isMaximized) {
        window.state[WINDOW_STATE_RESTORE_RECT].set(null);
        window.state[WINDOW_STATE_MAXIMIZED].set(false);
        window.unmaximize();
      }
      const rect = insetRect(snap.rect, this.outsetsFor(window));
      playRectAnimation(
        window,
        WINDOW_STATE_RECT,
        rect,
        WINDOW_MANAGEMENT_EASING,
        WINDOW_MANAGEMENT_ANIMATION_DURATION,
      );
      this.setWindowSnapState(workspace, window, snap.monitor, snap.zone);
      workspace?.syncFloatingWindowRect(window, rect);
    }
    this.applyWorkspaceStackPolicy(workspace);
    return true;
  }
}

export class Workspace {
  public index: number;
  private readonly windows: WaylandWindow[] = [];
  private readonly naturalRootRect: (
    window: WaylandWindow,
  ) => ManagedWindowRect;
  private readonly maximizedRootRect: (
    window: WaylandWindow,
  ) => ManagedWindowRect;
  private readonly decorationOutsetsFor: (
    window: WaylandWindow,
  ) => WindowDecorationOutsets;
  private readonly activeWorkspaceIndex: (monitor: string) => number;
  /** Binary split tree over the tiled leaves of this workspace. */
  private readonly tileLayout = new TileLayout();
  private readonly restoredWindowStateById = new Map<
    string,
    WorkspaceWindowSnapshot
  >();
  private activeWindowId: string | null = null;
  private visibilityAnimationToken = 0;
  // Visual mode of this workspace. While not 'stable', floating windows are
  // clamped to this workspace's output so the animated vertical translation
  // cannot render them onto an adjacent output; 'stable' settlement (setVisible)
  // restores normal cross-output floating spanning. 'gesture' is held until
  // animateWorkspaceTransition reads it so the native handoff can start from
  // the last live gesture frame.
  private workspaceVisualMode: "stable" | "transition" | "gesture" = "stable";
  private draggingWindowId: string | null = null;
  // Layout slot reserved for the tile being dragged (the gap opened in the
  // layout). Captured during applyLayout so the bar can preview where the
  // tile will land.
  private lastDraggingSlotRect: ManagedWindowRect | null = null;
  private lastAppliedTileViewportRect: ManagedWindowRect | null = null;
  private readonly tileReorderTokenByWindowId = new Map<string, number>();
  private tileReorderToken = 0;
  public monitor: string;
  // New workspaces are tiled by default; restore() overrides from the saved
  // whole-workspace mode.
  public isTiled = true;

  public constructor(
    index: number,
    monitor: string,
    naturalRootRect: (window: WaylandWindow) => ManagedWindowRect,
    maximizedRootRect: (window: WaylandWindow) => ManagedWindowRect,
    decorationOutsetsFor: (
      window: WaylandWindow,
    ) => WindowDecorationOutsets,
    activeWorkspaceIndex: (monitor: string) => number,
  ) {
    this.index = index;
    this.monitor = monitor;
    this.naturalRootRect = naturalRootRect;
    this.maximizedRootRect = maximizedRootRect;
    this.decorationOutsetsFor = decorationOutsetsFor;
    this.activeWorkspaceIndex = activeWorkspaceIndex;
  }

  /** Per-window external decoration footprint (never null; zeros default). */
  private outsetsFor(window: WaylandWindow): WindowDecorationOutsets {
    return this.decorationOutsetsFor(window) ?? ZERO_DECORATION_OUTSETS;
  }

  /**
   * The tile leaf is the window's full footprint allocation; a decorated
   * window's painted root is inset inside it so external ornaments stay on
   * the output. The split-tree geometry itself is untouched.
   */
  private fitLeafRectToOutsets(
    leaf: TileRect,
    window: WaylandWindow,
  ): TileRect {
    const outsets = this.outsetsFor(window);
    if (
      outsets.left === 0 &&
      outsets.right === 0 &&
      outsets.top === 0 &&
      outsets.bottom === 0
    ) {
      return leaf;
    }
    return {
      x: leaf.x + outsets.left,
      y: leaf.y + outsets.top,
      width: Math.max(1, leaf.width - outsets.left - outsets.right),
      height: Math.max(1, leaf.height - outsets.top - outsets.bottom),
    };
  }

  public moveToMonitor(monitor: string, index: number) {
    this.monitor = monitor;
    this.index = index;
    for (const window of this.windows) {
      this.syncWindowVisibleOutputs(window);
      if (window.state[WINDOW_STATE_FULLSCREEN]()) {
        window.state[WINDOW_STATE_RECT].set(this.fullscreenRootRect(window));
        continue;
      }
      if (window.state[WINDOW_STATE_MAXIMIZED]()) {
        window.state[WINDOW_STATE_RECT].set(this.maximizedRootRect(window));
        continue;
      }

      if (!this.isTiled || !this.isTileMember(window)) {
        const rect = this.clampRectToViewport(
          window.state[WINDOW_STATE_RECT](),
          window,
        );
        window.state[WINDOW_STATE_RECT].set(rect);
        window.state[WINDOW_STATE_FLOATING_RECT].set(
          this.isTiled ? rect : null,
        );
      }
    }
  }

  public addWindow(window: WaylandWindow, options: { activate?: boolean } = {}): boolean {
    if (this.windows.map((window) => window.id).includes(window.id)) {
      hotReloadDebug("workspace-add-existing-skip", {
        monitor: this.monitor,
        index: this.index,
        windowId: window.id,
        windowIds: this.windows.map((window) => window.id),
      });
      return false;
    }
    const restored = this.restoredWindowStateById.get(window.id);
    this.windows.push(window);
    const isTileMemberNow = !this.isTiled || this.isTileMember(window);
    if (!restored && isTileMemberNow && options.activate !== false) {
      this.activeWindowId = window.id;
    }
    if (restored) {
      window.cancelAnimation();
      hotReloadDebug("workspace-add-restored-cancel-animation", {
        monitor: this.monitor,
        index: this.index,
        windowId: window.id,
        activeWindowId: this.activeWindowId,
        restoredWindowIds: Array.from(this.restoredWindowStateById.keys()),
        windowIds: this.windows.map((window) => window.id),
      });
      this.restoredWindowStateById.delete(window.id);
      window.state[WINDOW_STATE_FLOATING_RECT].set(
        restored.floatingRect ?? null,
      );
      window.state[WINDOW_STATE_RESTORE_RECT].set(restored.restoreRect ?? null);
      window.state[WINDOW_STATE_SNAP_ZONE].set(restored.snapZone ?? null);
      window.state[WINDOW_STATE_SNAP_MONITOR].set(restored.snapMonitor ?? null);
      window.state[WINDOW_STATE_MINIMIZED].set(restored.minimized);
      window.state[WINDOW_STATE_MINIMIZE_VISUAL_IDLE].set(restored.minimized);
      window.state[WINDOW_STATE_MAXIMIZED].set(restored.maximized);
      window.state[WINDOW_STATE_USER_FLOATING].set(
        restored.userFloating ?? false,
      );
      if (restored.fullscreen !== undefined) {
        window.state[WINDOW_STATE_FULLSCREEN].set(restored.fullscreen);
        window.state[WINDOW_STATE_FULLSCREEN_RESTORE_RECT].set(
          restored.fullscreenRestoreRect ?? null,
        );
      }
    }
    const visible = this.isActive();
    window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(visible);
    window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(0);
    window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(visible ? 1 : 0);
    this.syncWindowVisibleOutputs(window);

    if (!COMPOSITOR.output.list.includes(this.monitor)) {
      return restored !== undefined;
    }

    if (this.isTiled && this.isTileMember(window)) {
      // The window keeps its floating rect as the restore point for a later
      // user-float toggle; the leaf rect comes from the split tree.
      const initialRect = this.centeredFloatingRect(window);
      if (!window.state[WINDOW_STATE_FLOATING_RECT]()) {
        window.state[WINDOW_STATE_FLOATING_RECT].set(
          restored?.floatingRect ?? initialRect,
        );
      }
      this.insertWindowTile(window);
      this.applyLayout({
        suppressSSDRebuild: false,
        animate: restored === undefined,
        preserveMissingActive: restored !== undefined,
      });
    } else if (restored?.fullscreen) {
      // Fullscreen/maximized geometry belongs to the (destination) output,
      // in every workspace mode: never recenter a restored stateful window.
      window.state[WINDOW_STATE_RECT].set(this.fullscreenRootRect(window));
    } else if (restored?.maximized) {
      window.state[WINDOW_STATE_RECT].set(this.maximizedRootRect(window));
    } else if (this.isTiled) {
      const initialRect = this.centeredFloatingRect(window);
      const contentRect = restored?.floatingRect ?? initialRect;
      window.state[WINDOW_STATE_FLOATING_RECT].set(contentRect);
      window.state[WINDOW_STATE_RECT].set(contentRect);
    } else {
      // Fully floating workspace: prefer the restored floating rect so a
      // moved/reloaded float keeps its placement instead of recentering.
      window.state[WINDOW_STATE_RECT].set(
        restored?.floatingRect ?? this.centeredFloatingRect(window),
      );
    }
    hotReloadDebug("workspace-add-window", {
      monitor: this.monitor,
      index: this.index,
      windowId: window.id,
      restored: restored !== undefined,
      isTiledWorkspace: this.isTiled,
      tileMember: this.isTileMember(window),
      activeWindowId: this.activeWindowId,
      windowIds: this.windows.map((window) => window.id),
      rect: window.state[WINDOW_STATE_RECT](),
      floatingRect: window.state[WINDOW_STATE_FLOATING_RECT](),
    });
    return restored !== undefined;
  }

  public removeWindow(window: WaylandWindow): WaylandWindow | null | undefined {
    const index = this.windows.findIndex((current) => current.id === window.id);
    if (index >= 0) {
      // Both describe the tile this window is still part of, so they have to
      // be read before the splice takes it out.
      const wasTile = this.isTileable(window);
      const tileIndex = this.tileIndexOf(window.id);
      this.windows.splice(index, 1);
      this.removeWindowTile(window);
      this.tileReorderTokenByWindowId.delete(window.id);
      window.state[WINDOW_STATE_TILE_REORDERING].set(false);
      if (this.draggingWindowId === window.id) {
        this.draggingWindowId = null;
        window.state[WINDOW_STATE_TILE_DRAGGING].set(false);
      }
      let nextFocus: WaylandWindow | null = null;
      if (this.activeWindowId === window.id) {
        nextFocus = this.successorForRemovedWindow(wasTile, tileIndex);
        this.activeWindowId = nextFocus?.id ?? null;
      }
      return nextFocus;
    }
    return undefined;
  }

  /**
   * The window that inherits focus when the active one is removed, or null to
   * leave that to the compositor.
   *
   * "The tile that slid into its place" is only an answer for a tile in a
   * tiled workspace. Anywhere else — a floating workspace, or a dialog that
   * never held a slot — there is no next-one-along to name, and naming one
   * anyway is what sent focus to the wrong window: dismissing an SSH approval
   * prompt jumped to the password manager's main window instead of returning
   * to the terminal that had asked for it.
   *
   * Declining is not caution, it is the better answer. The compositor elects
   * the window the user most recently typed in or clicked on, which is what
   * "put me back where I was" means, and is something this layer cannot work
   * out for itself: it focuses every window at onOpen, so "was focused" cannot
   * separate a terminal in use from a dialog that appeared beside it.
   */
  private successorForRemovedWindow(
    wasTile: boolean,
    tileIndex: number,
  ): WaylandWindow | null {
    if (!this.isTiled || !wasTile || tileIndex < 0) {
      return null;
    }
    const tileable = this.tileableWindows();
    return tileable[Math.min(tileIndex, tileable.length - 1)] ?? null;
  }

  public removeTileDragWindow(window: WaylandWindow) {
    const index = this.windows.findIndex((current) => current.id === window.id);
    if (index < 0) {
      return;
    }
    this.windows.splice(index, 1);
    this.removeWindowTile(window);
    this.draggingWindowId = null;
  }

  public removeFloatingWindow(window: WaylandWindow) {
    const index = this.windows.findIndex((current) => current.id === window.id);
    if (index < 0) {
      return;
    }
    this.windows.splice(index, 1);
    if (this.activeWindowId === window.id) {
      this.activeWindowId =
        this.activeWindow(this.tileableWindows())?.id ?? null;
    }
  }

  public hasWindow(window: WaylandWindow): boolean {
    return this.windows.some((current) => current.id === window.id);
  }

  public windowCount(): number {
    return this.windows.length;
  }

  /**
   * Snapshot of every window currently in this workspace. The returned array
   * is a copy; mutating it is safe and won't affect the workspace state.
   */
  public listWindows(): WaylandWindow[] {
    return this.windows.slice();
  }

  public findWindowById(windowId: string): WaylandWindow | undefined {
    return this.windows.find((window) => window.id === windowId);
  }

  public isActiveWindowId(windowId: string): boolean {
    return this.activeWindowId === windowId;
  }

  public takeWindowForMove(
    window: WaylandWindow,
  ): { window: WaylandWindow; snapshot: WorkspaceWindowSnapshot } | null {
    if (!this.hasWindow(window)) {
      return null;
    }

    const snapshot = this.snapshotWindow(window);
    this.removeWindow(window);
    return { window, snapshot };
  }

  public addMovedWindow(
    window: WaylandWindow,
    snapshot: WorkspaceWindowSnapshot,
  ): boolean {
    this.restoredWindowStateById.set(window.id, snapshot);
    const added = this.addWindow(window);
    // Transfer takeover: a window moved onto this workspace becomes its active
    // window, so a later switch/focus has a coherent owner even when the
    // transfer was silent. Restore-time addWindow deliberately leaves a
    // restored workspace's active id to the snapshot; only an explicit move
    // claims it here. Minimized windows take no focus.
    if (added && !window.state[WINDOW_STATE_MINIMIZED]()) {
      this.activeWindowId = window.id;
    }
    return added;
  }

  public isRestoringWindow(windowId: string): boolean {
    return this.restoredWindowStateById.has(windowId);
  }

  /**
   * Intrinsic tileability of a live window on this workspace: resizable,
   * non-transient, not minimized and not user-floating. This is the
   * membership test for the split tree.
   */
  public isTileMember(window: WaylandWindow): boolean {
    return (
      this.isTiled &&
      this.shouldTile(window) &&
      !window.state[WINDOW_STATE_MINIMIZED]() &&
      !this.userFloatingState(window)
    );
  }

  /**
   * Whether a window would hold a tile if the workspace is tiled — used to
   * classify drags/resizes/maximization on tiled workspaces independent of
   * the current leaf set.
   */
  public isTileCandidate(window: WaylandWindow): boolean {
    return this.shouldTile(window) && !this.userFloatingState(window);
  }

  /**
   * Whether `window` currently occupies a leaf of the split tree. Only valid
   * meaningfully on tiled workspaces.
   */
  public isTiledMember(window: WaylandWindow): boolean {
    return this.isTiled && this.tileLayout.has(window.id);
  }

  private userFloatingState(window: WaylandWindow): boolean {
    return window.state[WINDOW_STATE_USER_FLOATING]() === true;
  }

  /** Insert a tileable window after the focused/active leaf (guarded). */
  public insertWindowTile(window: WaylandWindow): void {
    if (!this.isTiled || !this.isTileMember(window) || this.tileLayout.has(window.id)) {
      return;
    }
    this.tileLayout.insert(window.id, this.tileAnchorId());
  }

  /** Remove a window's leaf from the split tree (guarded no-op otherwise). */
  public removeWindowTile(window: WaylandWindow): void {
    if (this.tileLayout.has(window.id)) {
      this.tileLayout.remove(window.id);
    }
  }

  /** Swap two leaves' positions in the split tree. */
  public swapTiles(firstId: string, secondId: string): boolean {
    return this.tileLayout.swap(firstId, secondId);
  }

  /** Toggle the focused leaf's parent split axis. */
  public toggleWindowSplit(window: WaylandWindow): boolean {
    if (!this.isTiled || !this.tileLayout.has(window.id)) {
      return false;
    }
    return this.tileLayout.toggleSplit(window.id);
  }

  /** Current leaf geometry in global logical coordinates. */
  public leafRects(): Map<string, TileRect> {
    if (!this.isTiled) {
      return new Map();
    }
    return this.tileLayout.rects(
      managedRectToTileRect(this.tileViewportRect()),
      TILE_GAP,
    );
  }

  /** Anchor for insertions: the active leaf, or the last one present. */
  private tileAnchorId(): string | undefined {
    if (
      this.activeWindowId &&
      this.tileLayout.has(this.activeWindowId)
    ) {
      return this.activeWindowId;
    }
    for (const window of this.windows) {
      if (this.tileLayout.has(window.id)) {
        return window.id;
      }
    }
    return undefined;
  }

  private markTileReordering(window: WaylandWindow): void {
    const token = ++this.tileReorderToken;
    this.tileReorderTokenByWindowId.set(window.id, token);
    window.state[WINDOW_STATE_TILE_REORDERING].set(true);
    setTimeout(() => {
      if (this.tileReorderTokenByWindowId.get(window.id) !== token) {
        return;
      }
      this.tileReorderTokenByWindowId.delete(window.id);
      window.state[WINDOW_STATE_TILE_REORDERING].set(false);
    }, TILE_ANIMATION_DURATION);
  }

  public isActive(): boolean {
    return this.activeWorkspaceIndex(this.monitor) === this.index;
  }

  public refreshUsableAreaLayout(force = false) {
    if (!COMPOSITOR.output.list.includes(this.monitor)) {
      return;
    }

    if (this.isTiled) {
      const nextViewportRect = this.tileViewportRect();
      // A `force` pass (e.g. after a Rainlit selection change) re-applies the
      // per-window layout even when the tile viewport itself did not move, so
      // decorated roots re-fit inside their leaves without a resize event.
      if (
        !force &&
        this.lastAppliedTileViewportRect &&
        managedRectEquals(this.lastAppliedTileViewportRect, nextViewportRect)
      ) {
        return;
      }
      this.applyLayout({
        suppressSSDRebuild: false,
        animate: false,
        preserveMissingActive: true,
      });
      return;
    }

    for (const window of this.windows) {
      if (!window.state[WINDOW_STATE_MAXIMIZED]()) {
        continue;
      }
      stopRectAnimation(window, WINDOW_STATE_RECT);
      window.state[WINDOW_STATE_RECT].set(this.maximizedRootRect(window));
    }
  }

  public setVisible(visible: boolean) {
    this.visibilityAnimationToken += 1;
    // Stable settlement: clear the visual mode before the per-window sync so
    // floating windows return to normal cross-output spanning, and cancel the
    // two actual workspace child channels (intentionally — this workspace is
    // settling) so a superseded transition cannot keep rendering or hide the
    // current workspace with a stale callback.
    this.workspaceVisualMode = "stable";
    for (const window of this.windows) {
      cancelWorkspaceVisualAnimation(window);
      this.syncWindowVisibleOutputs(window);
      if (window.state[WINDOW_STATE_TILE_DRAGGING]()) {
        window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(true);
        window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(0);
        window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(1);
        continue;
      }
      window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(visible);
      window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(0);
      window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(visible ? 1 : 0);
    }
  }

  public prepareWorkspaceTransition(offsetY: number, opacity: number) {
    this.visibilityAnimationToken += 1;
    // Only a previously stable workspace may have its visual state reset to
    // the transition's fresh starting frame. A workspace already visually in
    // flight (transition or gesture) keeps its live state and running child
    // channels so rapid reversal/retarget does not jump to full-distance
    // endpoints; the native same-channel sampler takes over from the current
    // position.
    const previousMode = this.workspaceVisualMode;
    this.workspaceVisualMode = previousMode === "gesture" ? "gesture" : "transition";
    for (const window of this.windows) {
      this.syncWindowVisibleOutputs(window);
      if (window.state[WINDOW_STATE_TILE_DRAGGING]()) {
        window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(true);
        window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(0);
        window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(1);
        continue;
      }
      if (previousMode !== "stable") {
        continue;
      }
      // Cancel any pre-existing native workspace animation before laying down
      // the transition's starting frame; otherwise an older channel resumes
      // from its own endpoints and fights the new one.
      cancelWorkspaceVisualAnimation(window);
      window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(true);
      window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(offsetY);
      window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(opacity);
    }
  }

  public setWorkspaceGestureVisual(offsetY: number, opacity: number) {
    this.visibilityAnimationToken += 1;
    this.workspaceVisualMode = "gesture";
    for (const window of this.windows) {
      this.syncWindowVisibleOutputs(window);
      // Intentional cancel: the gesture's live declarative offsets/opacity
      // below fully replace any scheduled workspace animation.
      cancelWorkspaceVisualAnimation(window);
      if (window.state[WINDOW_STATE_TILE_DRAGGING]()) {
        window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(true);
        window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(0);
        window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(1);
        continue;
      }
      window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(true);
      window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(offsetY);
      window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(opacity);
    }
  }

  public animateWorkspaceTransition(options: {
    fromOffsetY: number;
    toOffsetY: number;
    fromOpacity: number;
    toOpacity: number;
    visibleAfter: boolean;
  }) {
    const token = this.visibilityAnimationToken + 1;
    this.visibilityAnimationToken = token;
    // A gesture handoff animates from each window's last live declarative
    // gesture values; a native transition replacement relies on the
    // same-channel native sampler, which is authoritative for the in-flight
    // position.
    const previousWasGesture = this.workspaceVisualMode === "gesture";
    this.workspaceVisualMode = "transition";

    for (const window of this.windows) {
      this.syncWindowVisibleOutputs(window);
      if (window.state[WINDOW_STATE_TILE_DRAGGING]()) {
        window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(true);
        window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(0);
        window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(1);
        continue;
      }
      // Minimized windows are hidden purely by `idle` — their composed
      // opacity stays at the workspace value. Scheduling the visual
      // animation would both bypass the idle render gate (animating
      // windows stay renderable while idle) and override the composed
      // opacity, so the "hidden" window would fade in with the workspace
      // switch. Keep them on static state only.
      if (
        window.state[WINDOW_STATE_MINIMIZED]() ||
        window.state[WINDOW_STATE_MINIMIZE_VISUAL_IDLE]()
      ) {
        cancelWorkspaceVisualAnimation(window);
        window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(true);
        window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(0);
        window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(options.toOpacity);
        continue;
      }
      // Same ordering rule as prepare: schedule first, then flip
      // VISIBLE. For from-workspace this is mostly a no-op (VISIBLE was
      // already true), but for to-workspace's second call this keeps
      // the same invariant in case prepareWorkspaceTransition's hold
      // animation has already completed (e.g., rapid switches).
      scheduleWorkspaceVisualAnimation(
        window,
        previousWasGesture
          ? window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y]()
          : options.fromOffsetY,
        options.toOffsetY,
        previousWasGesture
          ? window.state[WINDOW_STATE_WORKSPACE_OPACITY]()
          : options.fromOpacity,
        options.toOpacity,
        WINDOW_MANAGEMENT_EASING,
        WORKSPACE_SWITCH_ANIMATION_DURATION,
      );
      window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(true);
    }

    // Settle at the full animation duration: setVisible now cancels the
    // native workspace channels, so committing before the native animation
    // ends would truncate it (the previous 32ms-early commit only worked
    // because cancellation did not exist yet). A stale timer is rejected by
    // the token above.
    setTimeout(
      () => {
        if (this.visibilityAnimationToken !== token) {
          return;
        }
        withManagedWindowOnlySSDRebuildSuppressed(() => {
          this.setVisible(options.visibleAfter);
        });
      },
      WORKSPACE_SWITCH_ANIMATION_DURATION,
    );
  }

  public setTiled(tiled: boolean) {
    if (this.isTiled === tiled) {
      return;
    }

    const focusedWindow = this.focusedWindow();
    const focusedTileableWindow =
      focusedWindow && this.isTileCandidate(focusedWindow)
        ? focusedWindow
        : undefined;
    this.isTiled = tiled;
    for (const window of this.windows) {
      this.syncWindowVisibleOutputs(window);
    }

    if (tiled) {
      // Rebuild the split tree from the current window set, seeded in
      // insertion order.
      this.tileLayout.restore(null);
      for (const window of this.tileableWindows()) {
        this.captureFloatingRect(window);
        this.tileLayout.insert(window.id, this.tileAnchorId());
      }
      for (const window of this.floatingWindows()) {
        this.captureFloatingRect(window);
      }
      const tileable = this.tileableWindows();
      const previousActiveWindow = this.activeWindow(tileable);
      this.activeWindowId =
        (focusedTileableWindow ?? previousActiveWindow ?? tileable.at(0))?.id ??
        null;
      this.applyLayout();
      focusedTileableWindow?.focus();
      return;
    }

    for (const window of this.windows) {
      // Fullscreen takes precedence over maximized: its output-owned rect
      // and its own restore rect must survive the mode switch untouched.
      if (window.state[WINDOW_STATE_FULLSCREEN]()) {
        playRectAnimation(
          window,
          WINDOW_STATE_RECT,
          this.fullscreenRootRect(window),
          WINDOW_MANAGEMENT_EASING,
          WINDOW_MANAGEMENT_ANIMATION_DURATION,
          MANAGED_WINDOW_ONLY_ANIMATION,
        );
        window.state[WINDOW_STATE_FLOATING_RECT].set(null);
        this.syncWindowVisibleOutputs(window);
        continue;
      }
      // A window that is still maximized across the mode switch keeps its
      // maximized rect. Restoring FLOATING_RECT here would configure the
      // client to the rect captured at first commit (often degenerate),
      // collapsing it to its minimum size. (Chrome and friends remember
      // their previous session state and start maximized, which makes this
      // easy to hit.)
      if (window.state[WINDOW_STATE_MAXIMIZED]()) {
        playRectAnimation(
          window,
          WINDOW_STATE_RECT,
          this.maximizedRootRect(window),
          WINDOW_MANAGEMENT_EASING,
          WINDOW_MANAGEMENT_ANIMATION_DURATION,
          MANAGED_WINDOW_ONLY_ANIMATION,
        );
        window.state[WINDOW_STATE_FLOATING_RECT].set(null);
        this.syncWindowVisibleOutputs(window);
        continue;
      }
      const rect = window.state[WINDOW_STATE_FLOATING_RECT]();
      if (rect) {
        playRectAnimation(
          window,
          WINDOW_STATE_RECT,
          rect,
          WINDOW_MANAGEMENT_EASING,
          WINDOW_MANAGEMENT_ANIMATION_DURATION,
          MANAGED_WINDOW_ONLY_ANIMATION,
        );
      }
      window.state[WINDOW_STATE_FLOATING_RECT].set(null);
      this.syncWindowVisibleOutputs(window);
    }
    if (focusedTileableWindow) {
      this.activeWindowId = focusedTileableWindow.id;
      focusedTileableWindow.focus();
    }
  }

  public applyLayout(options: LayoutOptions = {}) {
    if (!this.isTiled) {
      return;
    }

    const tileable = this.tileableWindows();
    const animate = options.animate ?? true;
    const suppressSSDRebuild = options.suppressSSDRebuild ?? true;
    const canSuppress = this.canSuppressLayoutSSDRebuild(tileable);
    const animationOptions =
      animate && suppressSSDRebuild && canSuppress
        ? MANAGED_WINDOW_ONLY_ANIMATION
        : undefined;

    if (tileable.length === 0) {
      this.activeWindowId = null;
      hotReloadDebug("workspace-apply-layout-empty", {
        monitor: this.monitor,
        index: this.index,
        animate,
        suppressSSDRebuild,
        canSuppress,
        floatingWindowIds: this.floatingWindows().map((window) => window.id),
      });
      this.applyFloatingLayout(
        animationOptions,
        animate,
        options.immediateFloatingWindowIds,
      );
      return;
    }

    if (
      !this.activeWindowId ||
      !tileable.some((window) => window.id === this.activeWindowId)
    ) {
      if (!options.preserveMissingActive) {
        this.activeWindowId = tileable.at(-1)?.id ?? null;
      }
    }

    // Reconcile the split tree with the live tileable set: insert every
    // leaf-less window (restored old snapshots, late tileability flips,
    // minimize/restore races) after the focused leaf.
    for (const window of tileable) {
      this.insertWindowTile(window);
    }

    const viewportRect = this.tileViewportRect();
    this.lastAppliedTileViewportRect = snapshotManagedRect(viewportRect);
    const leafRects = this.leafRects();
    const appliedRects: Record<string, ManagedWindowRect> = {};
    this.lastDraggingSlotRect = null;

    for (const window of tileable) {
      const leaf = leafRects.get(window.id);
      if (!leaf) {
        continue;
      }
      const rect = window.state[WINDOW_STATE_FULLSCREEN]()
        ? this.fullscreenRootRect(window)
        : window.state[WINDOW_STATE_MAXIMIZED]()
          ? this.maximizedRootRect(window)
          : this.fitLeafRectToOutsets(leaf, window);
      appliedRects[window.id] = rect;
      if (window.id === this.draggingWindowId) {
        this.lastDraggingSlotRect = rect;
      }
      if (window.id !== this.draggingWindowId) {
        if (animate) {
          playRectAnimation(
            window,
            WINDOW_STATE_RECT,
            rect,
            WINDOW_MANAGEMENT_EASING,
            TILE_ANIMATION_DURATION,
            animationOptions,
          );
        } else {
          if (options.cancelRectAnimations !== false) {
            stopRectAnimation(window, WINDOW_STATE_RECT);
          }
          window.state[WINDOW_STATE_RECT].set(rect);
        }
      }
    }

    hotReloadDebug("workspace-apply-layout", {
      monitor: this.monitor,
      index: this.index,
      animate,
      suppressSSDRebuild,
      canSuppress,
      activeWindowId: this.activeWindowId,
      tileableWindowIds: tileable.map((window) => window.id),
      floatingWindowIds: this.floatingWindows().map((window) => window.id),
      appliedRects,
    });
    this.applyFloatingLayout(
      animationOptions,
      animate,
      options.immediateFloatingWindowIds,
    );
  }

  public resizeTile(event: WindowResizeEvent) {
    if (!this.tileLayout.has(event.window.id)) {
      return;
    }

    if (
      (event.phase === "start" || event.phase === "update") &&
      event.window.state[WINDOW_STATE_MAXIMIZED]()
    ) {
      event.window.state[WINDOW_STATE_MAXIMIZED].set(false);
      event.window.state[WINDOW_STATE_RESTORE_RECT].set(null);
      event.window.unmaximize();
    }

    stopRectAnimation(event.window, WINDOW_STATE_RECT);
    this.activeWindowId = event.window.id;

    // Native resize adjusts the nearest applicable split boundary, not a
    // ribbon width: the grabbed border maps to a TileEdge, and the border's
    // current coordinate feeds the helper's ratio update. Wayland reports
    // top/bottom; the helper speaks up/down. A corner grab carries both an
    // x and a y edge — resize each applicable axis, then lay out once.
    const rect = event.currentRect;
    const horizontalEdge = event.edges.right
      ? ("right" as const)
      : event.edges.left
        ? ("left" as const)
        : null;
    const verticalEdge = event.edges.bottom
      ? ("down" as const)
      : event.edges.top
        ? ("up" as const)
        : null;
    if (!horizontalEdge && !verticalEdge) {
      return;
    }
    const viewport = managedRectToTileRect(this.tileViewportRect());
    if (horizontalEdge) {
      const coordinate = horizontalEdge === "right"
        ? read(rect.x) + read(rect.width)
        : read(rect.x);
      this.tileLayout.resize(
        event.window.id,
        horizontalEdge,
        coordinate,
        viewport,
        TILE_GAP,
      );
    }
    if (verticalEdge) {
      const coordinate = verticalEdge === "down"
        ? read(rect.y) + read(rect.height)
        : read(rect.y);
      this.tileLayout.resize(
        event.window.id,
        verticalEdge,
        coordinate,
        viewport,
        TILE_GAP,
      );
    }
    this.applyLayout();
  }

  /** Layout slot reserved for the tile being dragged, or null when not dragging. */
  public draggingSlotRect(): ManagedWindowRect | null {
    return this.draggingWindowId ? this.lastDraggingSlotRect : null;
  }

  public beginTileDrag(window: WaylandWindow, rect: ManagedWindowRect) {
    if (!this.isTileCandidate(window)) {
      return;
    }
    this.activeWindowId = window.id;
    this.draggingWindowId = window.id;
    const wasMaximized = window.state[WINDOW_STATE_MAXIMIZED]();
    window.state[WINDOW_STATE_MAXIMIZED].set(false);
    window.state[WINDOW_STATE_RESTORE_RECT].set(null);
    if (wasMaximized) {
      window.unmaximize();
    }
    window.state[WINDOW_STATE_TILE_DRAGGING].set(true);
    this.syncWindowVisibleOutputs(window);
    window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(true);
    window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(0);
    window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(1);
    this.insertWindowTile(window);
    stopRectAnimation(window, WINDOW_STATE_RECT);
    window.state[WINDOW_STATE_RECT].set(rect);
    this.applyLayout();
  }

  public adoptTileDragWindow(window: WaylandWindow, rect: ManagedWindowRect) {
    if (!this.hasWindow(window)) {
      this.windows.push(window);
    }
    const visible = this.isActive();
    this.activeWindowId = window.id;
    this.draggingWindowId = window.id;
    window.state[WINDOW_STATE_TILE_DRAGGING].set(true);
    this.syncWindowVisibleOutputs(window);
    window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(true);
    window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(0);
    window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(visible ? 1 : 0);
    this.insertWindowTile(window);
    stopRectAnimation(window, WINDOW_STATE_RECT);
    window.state[WINDOW_STATE_RECT].set(rect);
  }

  public adoptFloatingWindow(window: WaylandWindow, rect: ManagedWindowRect) {
    if (!this.hasWindow(window)) {
      this.windows.push(window);
    }
    const visible = this.isActive();
    this.activeWindowId = window.id;
    this.syncWindowVisibleOutputs(window);
    resetWorkspaceVisualState(window, visible);
    window.state[WINDOW_STATE_FLOATING_RECT].set(rect);
    stopRectAnimation(window, WINDOW_STATE_RECT);
    window.state[WINDOW_STATE_RECT].set(rect);
  }

  /**
   * Two-dimensional drag reorder: the pointer's x AND y pick the bounded
   * target slot — the tile leaf whose padded rect contains the pointer — and
   * the drag swaps leaf membership with it. The preview shape/IPC is
   * unchanged (`draggingSlotRect` + emitSnapPreview in the manager).
   */
  public updateTileDrag(
    window: WaylandWindow,
    rect: ManagedWindowRect,
    pointerX: number,
    pointerY: number,
  ) {
    if (this.draggingWindowId !== window.id) {
      this.beginTileDrag(window, rect);
    }
    this.activeWindowId = window.id;

    const halfGap = TILE_GAP / 2;
    let targetId: string | null = null;
    for (const [id, leaf] of this.leafRects()) {
      if (id === window.id) {
        continue;
      }
      if (
        pointerX >= leaf.x - halfGap &&
        pointerX <= leaf.x + leaf.width + halfGap &&
        pointerY >= leaf.y - halfGap &&
        pointerY <= leaf.y + leaf.height + halfGap
      ) {
        targetId = id;
        break;
      }
    }
    if (targetId && this.tileLayout.swap(window.id, targetId)) {
      this.markTileReordering(window);
      const targetWindow = this.findWindowById(targetId);
      if (targetWindow) {
        this.markTileReordering(targetWindow);
      }
    }

    stopRectAnimation(window, WINDOW_STATE_RECT);
    window.state[WINDOW_STATE_RECT].set(rect);
    this.applyLayout();
  }

  public endTileDrag(window: WaylandWindow, cancelled: boolean) {
    if (this.draggingWindowId !== window.id) {
      return;
    }
    this.draggingWindowId = null;
    window.state[WINDOW_STATE_TILE_DRAGGING].set(false);
    this.syncWindowVisibleOutputs(window);
    window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(0);
    window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(this.isActive() ? 1 : 0);
    if (!cancelled) {
      this.activeWindowId = window.id;
    }
    this.applyLayout();
    if (!cancelled && this.isActive()) {
      window.focus();
    }
  }

  public focusWindow(window: WaylandWindow) {
    if (!this.shouldTile(window)) {
      return;
    }
    // On a tiled workspace only split-tree members hold the active slot;
    // user-floating and minimized windows focus through the window stack.
    if (this.isTiled && !this.isTileMember(window)) {
      return;
    }
    this.activeWindowId = window.id;
  }

  /**
   * Follow-focus handoff: focus `window` unless it is minimized, already
   * focused, or a transient relative of the focused window (hovering a
   * modal's parent must not steal the modal's focus). Works for tiled
   * members, floating windows and fully floating workspaces; only tile
   * members update the workspace's active leaf id.
   */
  public focusWindowUnderPointer(
    window: WaylandWindow,
  ): WaylandWindow | undefined {
    if (
      !this.hasWindow(window) ||
      window.state[WINDOW_STATE_MINIMIZED]()
    ) {
      return undefined;
    }

    const focused = this.focusedWindow();
    if (
      focused &&
      focused.id !== window.id &&
      this.areTransientRelatives(focused, window)
    ) {
      return undefined;
    }

    if (read(window.isFocused)) {
      return undefined;
    }

    if (this.isTileMember(window)) {
      this.activeWindowId = window.id;
    }
    window.focus();
    return window;
  }

  private areTransientRelatives(a: WaylandWindow, b: WaylandWindow): boolean {
    return (
      this.isTransientChildOf(a, b) ||
      this.isTransientChildOf(b, a) ||
      this.hasUnparentedTransientAffinity(a, b)
    );
  }

  private isTransientChildOf(
    child: WaylandWindow,
    parent: WaylandWindow,
  ): boolean {
    return child.isTransient() && child.parentId() === parent.id;
  }

  private hasUnparentedTransientAffinity(
    a: WaylandWindow,
    b: WaylandWindow,
  ): boolean {
    const transient = !this.shouldTile(a) && a.isTransient() ? a : null;
    const other =
      transient === a ? b : !this.shouldTile(b) && b.isTransient() ? b : null;
    if (!transient || !other || transient.parentId()) {
      return false;
    }

    const transientAppId = transient.appId();
    return transientAppId !== undefined && transientAppId === other.appId();
  }

  /**
   * Focuses the workspace's active window, falling back to the first visible,
   * non-minimized window — tiled, user-floating, intrinsic float or
   * fully-floating alike. An empty (or all-minimized) workspace clears native
   * window focus without electing another output; hidden special slots never
   * qualify.
   */
  public focusActiveWindow() {
    const active =
      this.activeWindowId === null
        ? undefined
        : this.windows.find((window) => window.id === this.activeWindowId);
    const target =
      active && isFocusableWindow(active)
        ? active
        : this.windows.find(isFocusableWindow);
    if (target) {
      target.focus();
    } else {
      COMPOSITOR.window.focus(null);
    }
  }

  /**
   * Focus fallback after a silent transfer removed the source window:
   * the first remaining visible, non-minimized window — tiled, user-floating,
   * intrinsic float or fully-floating alike. Empty workspace clears the
   * active id; native focus reconciliation drops the hidden owner and
   * elects an available successor, or clears keyboard focus.
   */
  public focusSilentTransferFallback(): boolean {
    const fallback = this.windows.find(isFocusableWindow);
    if (!fallback) {
      this.activeWindowId = null;
      return false;
    }
    this.activeWindowId = fallback.id;
    fallback.focus();
    return true;
  }

  public shouldTile(window: WaylandWindow): boolean {
    return window.isResizable() && !window.isTransient();
  }

  public reclassifyWindow(window: WaylandWindow, wasTileable: boolean) {
    if (!this.isTiled || !this.hasWindow(window)) {
      this.syncWindowVisibleOutputs(window);
      return;
    }

    const isTileable = this.shouldTile(window);
    if (wasTileable === isTileable) {
      return;
    }

    if (!isTileable) {
      this.removeWindowTile(window);
      stopRectAnimation(window, WINDOW_STATE_RECT);
      // Preserve the window's current rect as its floating restore point;
      // floating rects are viewport/global coordinates.
      if (!window.state[WINDOW_STATE_FLOATING_RECT]()) {
        window.state[WINDOW_STATE_FLOATING_RECT].set(
          window.state[WINDOW_STATE_RECT](),
        );
      }
      if (this.activeWindowId === window.id) {
        // The slot this window has just vacated by ceasing to be tileable.
        const windowIndex = this.tileIndexOf(window.id);
        const tileable = this.tileableWindows();
        this.activeWindowId =
          tileable[Math.min(windowIndex, tileable.length - 1)]?.id ?? null;
      }
    } else if (!this.userFloatingState(window)) {
      // Became resizable/non-transient and not user-floating: join the split
      // tree after the focused leaf.
      this.captureFloatingRect(window);
      this.insertWindowTile(window);
      if (read(window.isFocused) || !this.activeWindowId) {
        this.activeWindowId = window.id;
      }
    }

    this.syncWindowVisibleOutputs(window);
    this.applyLayout({
      suppressSSDRebuild: false,
      preserveMissingActive: true,
      immediateFloatingWindowIds: !isTileable
        ? new Set([window.id])
        : undefined,
    });
  }

  public snapshot(): WorkspaceSnapshot {
    return {
      monitor: this.monitor,
      index: this.index,
      isTiled: this.isTiled,
      activeWindowId: this.activeWindowId,
      tileLayout: this.isTiled ? this.tileLayout.snapshot() : null,
      windows: this.windows.map((window) => this.snapshotWindow(window)),
    };
  }

  public restore(snapshot: WorkspaceSnapshot) {
    this.isTiled = snapshot.isTiled;
    this.activeWindowId = snapshot.activeWindowId;
    // Old persisted snapshots predate the split tree: null restores to an
    // empty tree and every live tileable window is inserted on arrival
    // (addWindow / applyLayout reconciliation). Obsolete scroll-era fields in
    // the snapshot object are ignored.
    this.tileLayout.restore(snapshot.tileLayout ?? null);
    this.restoredWindowStateById.clear();
    for (const window of snapshot.windows) {
      this.restoredWindowStateById.set(window.id, window);
    }
    hotReloadDebug("workspace-restore", {
      monitor: this.monitor,
      index: this.index,
      isTiled: this.isTiled,
      activeWindowId: this.activeWindowId,
      restoredWindowIds: Array.from(this.restoredWindowStateById.keys()),
    });
  }

  public getWindows(): WaylandWindow[] {
    return Array.from(this.windows);
  }

  private snapshotWindow(window: WaylandWindow): WorkspaceWindowSnapshot {
    // FALLBACK: when FLOATING_RECT is null (ordinary floating-
    // workspace windows never get one set), keep the moved/restored current
    // rect as the restore point — but never a fullscreen/maximized rect,
    // whose geometry is output-owned and must not become a float restore.
    const stateful =
      window.state[WINDOW_STATE_FULLSCREEN]() ||
      window.state[WINDOW_STATE_MAXIMIZED]();
    return {
      id: window.id,
      floatingRect:
        window.state[WINDOW_STATE_FLOATING_RECT]() ??
        (stateful ? null : window.state[WINDOW_STATE_RECT]()),
      restoreRect: window.state[WINDOW_STATE_RESTORE_RECT](),
      snapZone: window.state[WINDOW_STATE_SNAP_ZONE](),
      snapMonitor: window.state[WINDOW_STATE_SNAP_MONITOR](),
      minimized: window.state[WINDOW_STATE_MINIMIZED](),
      maximized: window.state[WINDOW_STATE_MAXIMIZED](),
      fullscreen: window.state[WINDOW_STATE_FULLSCREEN](),
      fullscreenRestoreRect:
        window.state[WINDOW_STATE_FULLSCREEN_RESTORE_RECT](),
      userFloating: this.userFloatingState(window),
    };
  }

  public syncWindowVisibleOutputs(window: WaylandWindow) {
    window.state[WINDOW_STATE_WORKSPACE_TILED].set(this.isTiled);
    window.state[WINDOW_STATE_TILED].set(
      this.isTiled && this.isTileCandidate(window),
    );
    // Input eligibility tracks the logical active workspace, not the visual
    // one, so an outgoing workspace can keep rendering its transition without
    // accepting input.
    window.state[WINDOW_STATE_WORKSPACE_INPUT_ELIGIBLE].set(this.isActive());
    window.state[WINDOW_STATE_VISIBLE_OUTPUTS].set(
      this.isTiled || this.workspaceVisualMode !== "stable" ? [this.monitor] : null,
    );
  }

  private canSuppressLayoutSSDRebuild(_tileable: WaylandWindow[]): boolean {
    // Opening windows may still be building decoration structure, labels,
    // icons, and shader inputs. SSD rebuild suppression is global, so using
    // it for existing windows' layout animation would also hide those
    // initial decoration updates until an unrelated interaction occurs.
    return true;
  }

  /**
   * Whether `window` occupies a slot in the split tree right now.
   * Minimized and user-floating windows are excluded because they hold no
   * slot, so they must not be counted when translating a position into the
   * tile sequence.
   */
  private isTileable(window: WaylandWindow): boolean {
    return this.isTileCandidate(window) && !window.state[WINDOW_STATE_MINIMIZED]();
  }

  private tileableWindows(): WaylandWindow[] {
    return this.windows.filter((window) => this.isTileable(window));
  }

  /**
   * Where `windowId` sits in the tile sequence: its index in
   * `tileableWindows()`, or the index it would occupy if it were a tile. -1
   * when the window is not in this workspace at all.
   *
   * Both callers want that second reading — one asks about a window it has
   * just removed, the other about one that has just stopped being tileable —
   * and both used to index `tileableWindows()` with a raw `this.windows`
   * position instead. That array also holds dialogs, transients and minimized
   * windows, so the position ran past the end of the tile list and the clamp
   * below it silently returned the *last* tile: whichever window happened to
   * be opened most recently.
   */
  private tileIndexOf(windowId: string): number {
    const position = this.windows.findIndex(
      (current) => current.id === windowId,
    );
    if (position < 0) {
      return -1;
    }
    return this.windows
      .slice(0, position)
      .filter((current) => this.isTileable(current)).length;
  }

  public focusedWindow(): WaylandWindow | undefined {
    return this.windows.find((window) => read(window.isFocused));
  }

  public syncFloatingWindowRect(
    window: WaylandWindow,
    viewportRect: ManagedWindowRect,
  ) {
    // A tiled member's rect is owned by the split tree; everyone else keeps
    // their floating rect (viewport/global coordinates) in sync.
    if (this.isTiled && this.isTileCandidate(window) && this.tileLayout.has(window.id)) {
      return;
    }
    window.state[WINDOW_STATE_FLOATING_RECT].set(viewportRect);
  }

  private activeWindow(windows = this.windows): WaylandWindow | undefined {
    return windows.find((window) => window.id === this.activeWindowId);
  }

  private captureFloatingRect(window: WaylandWindow) {
    if (!window.state[WINDOW_STATE_FLOATING_RECT]()) {
      window.state[WINDOW_STATE_FLOATING_RECT].set(
        window.state[WINDOW_STATE_RECT](),
      );
    }
  }

  /**
   * Windows not holding a split-tree leaf: intrinsically floating dialogs,
   * user-floating overrides and (on floating workspaces) every window.
   * Minimized windows are excluded — they hold no geometry of their own.
   */
  public floatingWindows(): WaylandWindow[] {
    return this.windows.filter(
      (window) =>
        !(this.isTiled && this.isTileCandidate(window)) &&
        !window.state[WINDOW_STATE_MINIMIZED](),
    );
  }

  private applyFloatingLayout(
    animationOptions: LayoutOptions | undefined,
    animate = true,
    immediateWindowIds?: ReadonlySet<string>,
  ) {
    for (const window of this.floatingWindows()) {
      // Fullscreen geometry is owned by the output and must survive every
      // floating-layout pass; maximized rects are owned by the maximize
      // flow. Rolling either back to FLOATING_RECT could hit a degenerate
      // rect (same reason as in setTiled(false)).
      if (window.state[WINDOW_STATE_FULLSCREEN]()) {
        continue;
      }
      if (window.state[WINDOW_STATE_MAXIMIZED]()) {
        continue;
      }
      const rect =
        window.state[WINDOW_STATE_FLOATING_RECT]() ??
        this.centeredFloatingRect(window);
      window.state[WINDOW_STATE_FLOATING_RECT].set(rect);
      if (animate && !immediateWindowIds?.has(window.id)) {
        playRectAnimation(
          window,
          WINDOW_STATE_RECT,
          rect,
          WINDOW_MANAGEMENT_EASING,
          TILE_ANIMATION_DURATION,
          animationOptions,
        );
      } else {
        stopRectAnimation(window, WINDOW_STATE_RECT);
        window.state[WINDOW_STATE_RECT].set(rect);
      }
      hotReloadDebug("workspace-apply-floating-layout", {
        monitor: this.monitor,
        index: this.index,
        animate,
        windowId: window.id,
        rect,
      });
    }
  }

  private centeredFloatingRect(window: WaylandWindow): ManagedWindowRect {
    const sizeRect = this.naturalRootRect(window);
    const monitor = COMPOSITOR.output.current[this.monitor];
    if (!monitor?.resolution) {
      return sizeRect;
    }

    const usableRect = COMPOSITOR.layer.usableArea(this.monitor);
    const logicalWidth =
      usableRect?.width ?? monitor.resolution.width / monitor.scale;
    const logicalHeight =
      usableRect?.height ?? monitor.resolution.height / monitor.scale;
    const logicalX = usableRect?.x ?? monitor.position.x;
    const logicalY = usableRect?.y ?? monitor.position.y;

    let width = read(sizeRect.width);
    let height = read(sizeRect.height);
    const constraints = window.sizeConstraints();
    // Extra = authored frame (insets included) minus the client surface;
    // computed before any fallback so the client minimum is preserved.
    const minWidth =
      Math.max(1, constraints.min?.width ?? 1) +
      Math.max(0, read(sizeRect.width) - window.position.width);
    const minHeight =
      Math.max(1, constraints.min?.height ?? 1) +
      Math.max(0, read(sizeRect.height) - window.position.height);
    // Reading the natural size while the client geometry is still unsettled
    // (≈0, e.g. right after the first commit) yields a degenerate rect that
    // is nothing but the SSD frame. Freezing that as the floating restore
    // rect would later configure the client to a tiny size when switching to
    // floating mode. Fall back to a default size based on the usable area
    // only when the rect is clearly degenerate (frame + titlebar at most).
    // 50px is a conservative threshold that no real app's natural size ever
    // falls under.
    const DEGENERATE_SIZE_PX = 50;
    if (width < DEGENERATE_SIZE_PX || height < DEGENERATE_SIZE_PX) {
      width = Math.round(logicalWidth * 0.6);
      height = Math.round(logicalHeight * 0.7);
    }

    // Reserve this window's decoration footprint around the centered root:
    // center the (root + outsets) box inside the usable area so ornaments
    // stay on the output without shrinking the client-visible root. A root
    // larger than the usable area cannot host its footprint; shrink to the
    // biggest size that fits, never below the client's own minimum.
    const outsets = this.outsetsFor(window);
    if (
      outsets.left !== 0 ||
      outsets.right !== 0 ||
      outsets.top !== 0 ||
      outsets.bottom !== 0
    ) {
      width = clamp(
        width,
        minWidth,
        Math.max(minWidth, logicalWidth - outsets.left - outsets.right),
      );
      height = clamp(
        height,
        minHeight,
        Math.max(minHeight, logicalHeight - outsets.top - outsets.bottom),
      );
    }
    return {
      x:
        logicalX +
        outsets.left +
        (logicalWidth - outsets.left - outsets.right - width) / 2,
      y:
        logicalY +
        outsets.top +
        (logicalHeight - outsets.top - outsets.bottom - height) / 2,
      width,
      height,
    };
  }

  private clampRectToViewport(
    rect: ManagedWindowRect,
    window: WaylandWindow,
  ): ManagedWindowRect {
    const viewport = this.tileViewportRect();
    const outsets = this.outsetsFor(window);
    let width = read(rect.width);
    let height = read(rect.height);
    const minX = read(viewport.x) + outsets.left;
    const minY = read(viewport.y) + outsets.top;
    if (
      outsets.left !== 0 ||
      outsets.right !== 0 ||
      outsets.top !== 0 ||
      outsets.bottom !== 0
    ) {
      // A decorated root larger than the viewport cannot host its footprint;
      // shrink to the biggest size that fits while never going below the
      // client's own minimum (an impossible fit preserves the minimum).
      const constraints = window.sizeConstraints();
      const natural = this.naturalRootRect(window);
      const minWidth =
        Math.max(1, constraints.min?.width ?? 1) +
        Math.max(0, read(natural.width) - window.position.width);
      const minHeight =
        Math.max(1, constraints.min?.height ?? 1) +
        Math.max(0, read(natural.height) - window.position.height);
      width = clamp(
        width,
        minWidth,
        Math.max(minWidth, read(viewport.width) - outsets.left - outsets.right),
      );
      height = clamp(
        height,
        minHeight,
        Math.max(minHeight, read(viewport.height) - outsets.top - outsets.bottom),
      );
    }
    const maxX = minX + Math.max(0, read(viewport.width) - outsets.left - outsets.right - width);
    const maxY = minY + Math.max(0, read(viewport.height) - outsets.top - outsets.bottom - height);
    return {
      x: clamp(read(rect.x), minX, maxX),
      y: clamp(read(rect.y), minY, maxY),
      width,
      height,
    };
  }

  private tileViewportRect(): ManagedWindowRect {
    const monitor = COMPOSITOR.output.current[this.monitor];
    const usableRect = COMPOSITOR.layer.usableArea(this.monitor);
    const base =
      usableRect ??
      (monitor?.resolution
        ? {
            x: monitor.position.x,
            y: monitor.position.y,
            width: monitor.resolution.width / monitor.scale,
            height: monitor.resolution.height / monitor.scale,
          }
        : {
            x: 0,
            y: 0,
            width: 1280,
            height: 720,
          });

    const margin = this.monitor === "DP-2" ? 150 : TILE_MARGIN;

    return insetRect(base, {
      top: margin,
      right: margin,
      bottom: margin,
      left: margin,
    });
  }

  private fullscreenRootRect(window: WaylandWindow): ManagedWindowRect {
    const monitor = COMPOSITOR.output.current[this.monitor];
    if (monitor?.resolution) {
      return {
        x: monitor.position.x,
        y: monitor.position.y,
        width: monitor.resolution.width / monitor.scale,
        height: monitor.resolution.height / monitor.scale,
      };
    }
    return window.state[WINDOW_STATE_RECT]();
  }
}

function workspaceKey(monitor: string, index: number): string {
  return `${monitor}:${index}`;
}

function constrainedMax(
  constraints: WindowSizeConstraints,
  axis: "width" | "height",
  extra: number,
): number {
  const max = constraints.max?.[axis];
  return max && max > 0 ? max + extra : Number.POSITIVE_INFINITY;
}

function resizeOriginForAxis(
  start: WindowResizeRect,
  current: WindowResizeRect,
  constrainedSize: number,
  negativeEdge: boolean,
  axis: "x" | "y",
): number {
  if (!negativeEdge) {
    return current[axis];
  }

  const startSize = axis === "x" ? start.width : start.height;
  return start[axis] + startSize - constrainedSize;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Signal-backed managed rect as a plain tile-geometry rect. */
function managedRectToTileRect(rect: ManagedWindowRect): TileRect {
  return {
    x: read(rect.x),
    y: read(rect.y),
    width: read(rect.width),
    height: read(rect.height),
  };
}

function insetRect(
  rect: ManagedWindowRect,
  padding: { top: number; right: number; bottom: number; left: number },
): ManagedWindowRect {
  const width = Math.max(1, read(rect.width) - padding.left - padding.right);
  const height = Math.max(1, read(rect.height) - padding.top - padding.bottom);
  return {
    x: read(rect.x) + padding.left,
    y: read(rect.y) + padding.top,
    width,
    height,
  };
}

function snapshotManagedRect(rect: ManagedWindowRect): ManagedWindowRect {
  return {
    x: read(rect.x),
    y: read(rect.y),
    width: read(rect.width),
    height: read(rect.height),
  };
}

function managedRectEquals(
  a: ManagedWindowRect,
  b: ManagedWindowRect,
): boolean {
  return (
    read(a.x) === read(b.x) &&
    read(a.y) === read(b.y) &&
    read(a.width) === read(b.width) &&
    read(a.height) === read(b.height)
  );
}

function isLayoutSnapZone(zone: SnapZone | null): zone is LayoutSnapZone {
  return zone !== null && zone !== "maximize";
}

function isLeftSnapZone(zone: LayoutSnapZone): boolean {
  return zone === "left" || zone === "top-left" || zone === "bottom-left";
}

function isRightSnapZone(zone: LayoutSnapZone): boolean {
  return zone === "right" || zone === "top-right" || zone === "bottom-right";
}

function isTopSnapZone(zone: LayoutSnapZone): boolean {
  return zone === "top-left" || zone === "top-right";
}

function isBottomSnapZone(zone: LayoutSnapZone): boolean {
  return zone === "bottom-left" || zone === "bottom-right";
}

function snapColumn(zone: LayoutSnapZone): SnapColumn {
  return isLeftSnapZone(zone) ? "left" : "right";
}

function snapZonesConflict(
  current: SnapZone | null,
  next: LayoutSnapZone,
): boolean {
  if (!isLayoutSnapZone(current)) {
    return false;
  }
  if (current === next) {
    return true;
  }

  if (next === "left") {
    return current === "top-left" || current === "bottom-left";
  }
  if (next === "right") {
    return current === "top-right" || current === "bottom-right";
  }
  if (current === "left") {
    return next === "top-left" || next === "bottom-left";
  }
  if (current === "right") {
    return next === "top-right" || next === "bottom-right";
  }
  return false;
}

function averageOr(values: number[], fallback: number): number {
  if (values.length === 0) {
    return fallback;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function withManagedWindowOnlySSDRebuildSuppressed<T>(
  callback: () => T,
  options: { strict?: boolean } = {},
): T {
  return COMPOSITOR.runtime.withSSDRebuildSuppressed(
    options.strict
      ? STRICT_MANAGED_WINDOW_ONLY_REBUILD_SUPPRESSION
      : MANAGED_WINDOW_ONLY_REBUILD_SUPPRESSION,
    callback,
  );
}

// Rect deltas use `add` so open/close/workspace motion can layer on top of
// override-mode layout animation. Open/close opacity uses `multiply`; workspace
// opacity is a separate override channel so an inactive workspace whose base
// opacity is already 0 can still fade back in deterministically.

function scheduleOpenAnimation(window: WaylandWindow): void {
  window.scheduleAnimation({
    channel: OPEN_ANIMATION_CHANNEL,
    rect: {
      from: { x: 0, y: 200, width: 0, height: 0 },
      to: { x: 0, y: 0, width: 0, height: 0 },
      duration: OPEN_CLOSE_ANIMATION_DURATION,
      easing: WINDOW_OPEN_EASING,
      mode: "add",
    },
    opacity: {
      from: 0,
      to: 1,
      duration: OPEN_CLOSE_ANIMATION_DURATION,
      easing: WINDOW_OPEN_EASING,
      mode: "multiply",
    },
  });
}

function scheduleCloseAnimation(window: WaylandWindow): void {
  window.scheduleAnimation({
    channel: CLOSE_ANIMATION_CHANNEL,
    rect: {
      from: { x: 0, y: 0, width: 0, height: 0 },
      to: { x: 0, y: 120, width: 0, height: 0 },
      duration: OPEN_CLOSE_ANIMATION_DURATION,
      easing: WINDOW_CLOSE_EASING,
      mode: "add",
    },
    opacity: {
      from: 1,
      to: 0,
      duration: OPEN_CLOSE_ANIMATION_DURATION,
      easing: WINDOW_CLOSE_EASING,
      mode: "multiply",
    },
  });
}

function scheduleMinimizeAnimation(
  window: WaylandWindow,
  minimized: boolean,
): void {
  window.scheduleAnimation({
    channel: MINIMIZE_ANIMATION_CHANNEL,
    rect: {
      from: minimized
        ? { x: 0, y: 0, width: 0, height: 0 }
        : { x: 0, y: 200, width: 0, height: 0 },
      to: minimized
        ? { x: 0, y: 120, width: 0, height: 0 }
        : { x: 0, y: 0, width: 0, height: 0 },
      duration: OPEN_CLOSE_ANIMATION_DURATION,
      easing: minimized
        ? WINDOW_MINIMIZE_RECT_EASING
        : WINDOW_UNMINIMIZE_RECT_EASING,
      mode: "add",
    },
    opacity: {
      from: minimized ? 1 : 0,
      to: minimized ? 0 : 1,
      duration: OPEN_CLOSE_ANIMATION_DURATION,
      easing: minimized
        ? WINDOW_MINIMIZE_OPACITY_EASING
        : WINDOW_UNMINIMIZE_OPACITY_EASING,
      mode: "override",
    },
  });
}

function scheduleWorkspaceVisualAnimation(
  window: WaylandWindow,
  fromOffsetY: number,
  toOffsetY: number,
  fromOpacity: number,
  toOpacity: number,
  easing: EasingFunction,
  duration: number,
): void {
  // No cancel here: this helper only ever replaces the same two child
  // channels, and a same-channel schedule replaces in flight while the native
  // side keeps sampling the current position. Intentional cancels live in the
  // callers (stable settlement, gesture takeover, minimized branch).
  window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(0);
  window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(toOpacity);

  window.scheduleAnimation({
    channel: WORKSPACE_VISUAL_RECT_ANIMATION_CHANNEL,
    rect: {
      from: { x: 0, y: fromOffsetY, width: 0, height: 0 },
      to: { x: 0, y: toOffsetY, width: 0, height: 0 },
      duration,
      easing,
      mode: "add",
    },
  });
  window.scheduleAnimation({
    channel: WORKSPACE_VISUAL_OPACITY_ANIMATION_CHANNEL,
    opacity: {
      from: fromOpacity,
      to: toOpacity,
      duration,
      easing,
      mode: "override",
    },
  });
}

function resetWorkspaceVisualState(
  window: WaylandWindow,
  visible: boolean,
): void {
  cancelWorkspaceVisualAnimation(window);
  window.state[WINDOW_STATE_WORKSPACE_VISIBLE].set(visible);
  window.state[WINDOW_STATE_WORKSPACE_OFFSET_Y].set(0);
  window.state[WINDOW_STATE_WORKSPACE_OPACITY].set(visible ? 1 : 0);
}

function cancelWorkspaceVisualAnimation(window: WaylandWindow): void {
  // Only the two actually scheduled child channels; the base prefix constant
  // stays as the names source for them.
  window.cancelAnimation(WORKSPACE_VISUAL_RECT_ANIMATION_CHANNEL);
  window.cancelAnimation(WORKSPACE_VISUAL_OPACITY_ANIMATION_CHANNEL);
}
