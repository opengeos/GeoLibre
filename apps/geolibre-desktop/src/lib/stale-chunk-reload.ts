/**
 * Recovery for stale lazy-loaded chunks after a redeploy.
 *
 * On a static host (the GitHub Pages web demo behind viewer.geolibre.app), each
 * deployment writes content-hashed JS chunks and deletes the previous build's
 * chunks. Browsers cache hashed assets for hours, so a tab that loaded an
 * earlier build keeps a cached lazy chunk whose dynamic `import()` targets a
 * now-deleted chunk. Opening the panel that chunk backs (e.g. Add Raster Layer)
 * then fetches the missing chunk and 404s, surfacing as
 * "Failed to fetch dynamically imported module".
 *
 * Vite dispatches a cancelable `vite:preloadError` event on `window` for exactly
 * this case. Reloading the page re-evaluates the current build's import graph,
 * so the lazy import resolves to a chunk that still exists. A short cooldown
 * guards against a reload loop when the failure is a genuinely broken build
 * rather than a stale chunk.
 */

import { isTauri } from "./is-tauri";

const RELOAD_TIMESTAMP_KEY = "geolibre:stale-chunk-reload-at";

/**
 * If a reload just happened and a chunk still fails to load, the build is
 * broken rather than stale, so further reloads are suppressed to avoid a
 * refresh loop. Long enough to cover a reload's network round-trip.
 */
export const STALE_CHUNK_RELOAD_COOLDOWN_MS = 15_000;

export interface StaleChunkReloadDeps {
  /** Current epoch milliseconds. */
  now: () => number;
  /** Last reload timestamp this session, or null if none. */
  getLastReloadAt: () => number | null;
  /** Persist the reload timestamp for the cooldown guard. */
  setLastReloadAt: (value: number) => void;
  /** Reload the page. */
  reload: () => void;
}

/**
 * Reloads the page to recover from a stale chunk, unless a reload happened
 * within the cooldown (in which case the failure is treated as a broken build
 * and left to surface).
 *
 * @param deps - Injected clock, persistence, and reload, for testability.
 * @returns True when a reload was triggered, false when suppressed.
 */
export function reloadForStaleChunk(deps: StaleChunkReloadDeps): boolean {
  const last = deps.getLastReloadAt();
  const current = deps.now();
  if (last !== null && current - last < STALE_CHUNK_RELOAD_COOLDOWN_MS) {
    return false;
  }
  deps.setLastReloadAt(current);
  deps.reload();
  return true;
}

/**
 * Registers a `vite:preloadError` handler that reloads once (cooldown-guarded)
 * to recover from chunks orphaned by a redeploy. A no-op when disabled or
 * outside a browser (e.g. the Tauri desktop build, whose local chunks never go
 * stale). When it reloads it calls `preventDefault()` so Vite does not also
 * rethrow the error.
 *
 * @param options.enabled - Pass false to skip installation (e.g. in Tauri).
 * @returns A cleanup function that removes the listener.
 */
export function installStaleChunkReload(options?: {
  enabled?: boolean;
}): () => void {
  const enabled = options?.enabled ?? !isTauri();
  if (!enabled || typeof window === "undefined") {
    return () => {};
  }

  const handler = (event: Event) => {
    // Vite dispatches a plain Event with the underlying error on `.payload`
    // (not a CustomEvent `.detail`); surface it so a recovery is visible.
    const payload = (event as Event & { payload?: unknown }).payload;
    let reloaded = false;
    try {
      reloaded = reloadForStaleChunk({
        now: () => Date.now(),
        getLastReloadAt: () => {
          const raw = window.sessionStorage.getItem(RELOAD_TIMESTAMP_KEY);
          if (raw === null) return null;
          const parsed = Number(raw);
          return Number.isFinite(parsed) ? parsed : null;
        },
        setLastReloadAt: (value) =>
          window.sessionStorage.setItem(RELOAD_TIMESTAMP_KEY, String(value)),
        reload: () => window.location.reload(),
      });
    } catch {
      // sessionStorage can throw when storage is blocked (private modes,
      // Safari ITP, sandboxed iframes), mirroring the guard in diagnostics.ts.
      // The cooldown loop-guard needs that persistence, so without it skip the
      // reload and let Vite surface the original error rather than risk a
      // refresh loop.
      console.warn(
        "[GeoLibre] Stale-chunk reload guard unavailable (storage blocked); leaving the preload error to surface.",
        payload,
      );
    }
    if (reloaded) {
      // Only suppress Vite's rethrow when we are recovering by reloading; a
      // cooldown-suppressed (broken-build) error should still surface.
      console.warn("[GeoLibre] Reloading to recover from a stale chunk.", payload);
      event.preventDefault();
    }
  };

  window.addEventListener("vite:preloadError", handler);
  return () => window.removeEventListener("vite:preloadError", handler);
}
