/** The loader stays at least this long, so its draw-in reads as the mark and not a flicker. */
export const LOADER_MIN_MS = 800;
/** And never longer: a slow page then shows in the app window with its own progress. */
export const LOADER_MAX_MS = 15_000;

/**
 * How long the loading screen still waits once the app window has loaded its page: the rest of
 * the minimum, or nothing when loading took longer than that.
 */
export function loaderHold(shownAt: number, now: number, min = LOADER_MIN_MS): number {
  return Math.max(0, Math.min(min, shownAt + min - now));
}
