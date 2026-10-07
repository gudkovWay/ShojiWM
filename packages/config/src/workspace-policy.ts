/**
 * Workspace addressing policy shared by the window manager, the external IPC
 * protocol and the placement rules.
 *
 * Internally every output still owns ten monitor-local workspaces indexed
 * 1..10, and snapshots persist those local indices so windows survive a
 * reload. The external/protocol view is global instead: DP-3 owns 1..10,
 * DP-2 owns 11..20, and every further connected output receives its own
 * ten-slot block starting at 21 in sorted connector order.
 *
 * The two private special slots (-1 agent-tests, -2 pult) are monitor-local
 * and never advertised; explicit window activation can still reveal them.
 */

export const WORKSPACES_PER_OUTPUT = 10;

/** Private slot used by agent-test windows; never advertised as a workspace. */
export const SPECIAL_WORKSPACE_AGENT_TESTS = -1;

/** Private slot used by pult sessions; never advertised as a workspace. */
export const SPECIAL_WORKSPACE_PULT = -2;

/** Primary panel; owns the first global block (1..10). */
const PRIMARY_MONITOR = "DP-3";

/** Secondary panel; owns the second global block (11..20). */
const SECONDARY_MONITOR = "DP-2";

/**
 * Ordered output list: the two known panels keep their fixed blocks first,
 * and every other connected output follows in sorted connector order.
 */
function orderedMonitors(monitors: readonly string[]): string[] {
  const additional = monitors
    .filter(
      (monitor) =>
        monitor !== PRIMARY_MONITOR && monitor !== SECONDARY_MONITOR,
    )
    .sort();
  return [PRIMARY_MONITOR, SECONDARY_MONITOR, ...additional];
}

/**
 * Global block offset for `monitor` (0 for DP-3, 10 for DP-2, 20 for the
 * first additional output, and so on). A monitor that is not in the reported
 * output list still receives a deterministic block appended after every
 * known output.
 */
export function workspaceOffset(
  monitor: string,
  monitors: readonly string[],
): number {
  if (monitor === PRIMARY_MONITOR) {
    return 0;
  }
  if (monitor === SECONDARY_MONITOR) {
    return WORKSPACES_PER_OUTPUT;
  }
  const ordered = orderedMonitors(monitors);
  const position = ordered.indexOf(monitor);
  const slot = position === -1 ? ordered.length : position;
  return slot * WORKSPACES_PER_OUTPUT;
}

/**
 * True for a monitor-local ordinary slot: an integer within 1..10.
 * `Number.isInteger` already rejects NaN/Infinity; the finite check keeps the
 * intended domain explicit for readers.
 */
export function isOrdinaryWorkspaceIndex(index: number): boolean {
  return (
    Number.isInteger(index) &&
    Number.isFinite(index) &&
    index >= 1 &&
    index <= WORKSPACES_PER_OUTPUT
  );
}

/**
 * Convert a monitor-local ordinary slot (1..10) into its global protocol
 * index. Invalid local input yields NaN; callers only ever pass 1..10.
 */
export function globalWorkspaceIndex(
  monitor: string,
  localIndex: number,
  monitors: readonly string[],
): number {
  if (!isOrdinaryWorkspaceIndex(localIndex)) {
    return Number.NaN;
  }
  return workspaceOffset(monitor, monitors) + localIndex;
}

/**
 * Convert a global protocol index back into a monitor-local ordinary slot
 * (1..10). Returns undefined when the input is not a positive integer or
 * falls outside `monitor`'s own block (a cross-range index belongs to a
 * different output).
 */
export function localWorkspaceIndex(
  monitor: string,
  globalIndex: number,
  monitors: readonly string[],
): number | undefined {
  if (!Number.isInteger(globalIndex) || globalIndex < 1) {
    return undefined;
  }
  const local = globalIndex - workspaceOffset(monitor, monitors);
  if (local < 1 || local > WORKSPACES_PER_OUTPUT) {
    return undefined;
  }
  return local;
}

/** True for one of the private monitor-local special slots (-1 or -2). */
export function isSpecialWorkspaceIndex(index: number): boolean {
  return (
    index === SPECIAL_WORKSPACE_AGENT_TESTS ||
    index === SPECIAL_WORKSPACE_PULT
  );
}
