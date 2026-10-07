/**
 * Application placement rules, ported from the deployed Hyprland
 * windowrules.lua (workspace placement only).
 *
 * Indices are internal/monitor-local: slots 1..10 on each monitor.
 * The parent integration resolves the monitor for a rule, applies
 * current-monitor fallback for special workspaces, and handles
 * missing-output fallback. This module is a pure selector: no
 * lifecycle, no floating/effect rules, no extra heuristics.
 */

import { SPECIAL_WORKSPACE_AGENT_TESTS, SPECIAL_WORKSPACE_PULT } from './workspace-policy';

export interface WindowPlacement {
  /** Target monitor name; undefined = current/selected monitor. */
  monitor?: string;
  /** Internal (monitor-local) workspace index. */
  index: number;
  /** Silent placement: do not switch workspace or take focus on open. */
  silent: boolean;
}

/** Anchored class regex from Hyprland gamingApps rule. */
const GAMING_CLASS = /^(steam_app.*|gamescope)$/;

/** App IDs placed on DP-3, workspace 2 (work). */
const DP3_SLOT2: readonly string[] = ['dev.zed.Zed', 'dev.zed.Zed-Dev', 'zed'];
/** App IDs placed on DP-3, workspace 3 (browsing). */
const DP3_SLOT3: readonly string[] = ['zen', 'zen-alpha'];
/** App IDs placed on DP-2, workspace 1 (chat). */
const DP2_SLOT1: readonly string[] = ['discord', 'vesktop', 'com.ayugram.desktop'];
/** App ID placed on DP-2, workspace 2 (music). */
const DP2_SLOT2: readonly string[] = ['YouTube Music Desktop App'];
/** App IDs sent to special:agent-tests on the current monitor. */
const SPECIAL_AGENT_TESTS: readonly string[] = ['agent-test', 'aquamarine'];

const MONITOR_DP3 = 'DP-3';
const MONITOR_DP2 = 'DP-2';

/**
 * Select placement for a new window. Returns undefined when no rule
 * matches; the caller decides fallback (active monitor/workspace).
 */
export function windowPlacementFor(
  appId: string | undefined,
): WindowPlacement | undefined {
  if (appId === undefined) return undefined;

  // Gaming: steam_app.* / gamescope — DP-3 slot 4, non-silent.
  if (GAMING_CLASS.test(appId)) {
    return { monitor: MONITOR_DP3, index: 4, silent: false };
  }

  // The later silent Steam rule also matches the "Launching..." window.
  if (appId === 'steam') {
    return { monitor: MONITOR_DP3, index: 4, silent: true };
  }

  if (DP3_SLOT2.includes(appId)) {
    return { monitor: MONITOR_DP3, index: 2, silent: true };
  }
  if (DP3_SLOT3.includes(appId)) {
    return { monitor: MONITOR_DP3, index: 3, silent: true };
  }
  if (DP2_SLOT1.includes(appId)) {
    return { monitor: MONITOR_DP2, index: 1, silent: true };
  }
  if (DP2_SLOT2.includes(appId)) {
    return { monitor: MONITOR_DP2, index: 2, silent: true };
  }

  // Agent test terminals and nested Hyprland: hidden special workspace
  // on the current monitor (monitor left to the parent).
  if (SPECIAL_AGENT_TESTS.includes(appId)) {
    return { index: SPECIAL_WORKSPACE_AGENT_TESTS, silent: true };
  }
  // Pult (remote-ai-manage) sessions: hidden until opened via Telegram.
  if (appId === 'pult-session') {
    return { index: SPECIAL_WORKSPACE_PULT, silent: true };
  }

  return undefined;
}
