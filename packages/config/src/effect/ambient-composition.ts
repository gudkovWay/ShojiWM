/**
 * Ambient composition profiles for the unified-frame inner backdrop.
 *
 * One profile is selected explicitly by editing `ACTIVE_COMPOSITION` — the
 * product CLI rewrites this literal on `--apply` and the owner reloads the
 * config, so there is no automatic rotation and no runtime shortcut/IPC.
 *
 * `COMPOSITION_INDEX` is the numeric value carried into `ambient-content.frag`
 * `composition` uniform; the shader interface fixes 0 = rainlit-shoji,
 * 1 = lantern-dusk, 2 = moonlit-ink. `AMBIENT_PERIOD_MS` is the length of
 * one full `phase` sweep (0..1) on the native per-window animation clock: the
 * shader authors its motion against this period, and the parent starts/stops
 * that clock with window visibility, so no wall-clock time crosses the
 * boundary.
 *
 * These are the shared interfaces consumed by `ambient-content.ts` (the
 * backdrop factory) and by the browser adapter's profile selection.
 */

export type AmbientComposition =
  | "rainlit-shoji"
  | "lantern-dusk"
  | "moonlit-ink";

export const ACTIVE_COMPOSITION: AmbientComposition = 'rainlit-shoji';

export const COMPOSITION_INDEX: Record<AmbientComposition, number> = {
  "rainlit-shoji": 0,
  "lantern-dusk": 1,
  "moonlit-ink": 2,
};

export const AMBIENT_PERIOD_MS = 96000;
