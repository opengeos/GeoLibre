/**
 * Recovery for stale lazy-loaded chunks after a redeploy.
 *
 * On a static host (the GitHub Pages web demo behind web.geolibre.app), each
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

import { useAppStore } from "@geolibre/core";
import { appendDiagnostic, getDiagnosticsSnapshot } from "./diagnostics";
import { isTauri } from "./is-tauri";

const DEFERRED_RELOAD_MESSAGE =
  "A component could not be loaded because the app was updated. Save your project, then reload the page to finish loading it.";
const STALE_CHUNK_DIAGNOSTIC_SOURCE = "stale-chunk-reload";

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
  /** Whether the project has unsaved changes that a reload would discard. */
  hasUnsavedChanges: () => boolean;
}

/**
 * The outcome of a stale-chunk recovery attempt.
 *
 * - `reloaded` - the page was reloaded to fetch the current build's chunks.
 * - `deferred-unsaved` - a reload was withheld to protect unsaved work; the
 *   stale feature stays unloaded and the user is asked to save and reload.
 * - `suppressed-cooldown` - a reload happened too recently, so the failure is
 *   treated as a broken build and left to surface.
 */
export type StaleChunkReloadOutcome = "reloaded" | "deferred-unsaved" | "suppressed-cooldown";

/**
 * Decides how to recover from a stale chunk. Reloads the page unless that would
 * discard the user's work (unsaved changes) or a reload happened within the
 * cooldown.
 *
 * A forced reload here re-evaluates the current build's import graph so the
 * lazy import resolves. But reloading throws away the in-memory project, and
 * when there are unsaved changes the {@link useBeforeUnloadGuard} also raises
 * the browser's "Leave site?" prompt, so an accidental reload becomes data
 * loss. In that case recovery is deferred: the failed feature simply does not
 * load, and the caller tells the user to save and reload deliberately. When
 * the project is clean there is nothing to lose, so the reload runs as before.
 *
 * @param deps - Injected clock, persistence, reload, and dirty check, for testability.
 * @returns Which recovery path was taken.
 */
export function reloadForStaleChunk(deps: StaleChunkReloadDeps): StaleChunkReloadOutcome {
  // Never reload out from under unsaved work: it trips the beforeunload guard
  // and risks losing the user's map. This takes precedence over the cooldown.
  if (deps.hasUnsavedChanges()) {
    return "deferred-unsaved";
  }
  const last = deps.getLastReloadAt();
  const current = deps.now();
  if (last !== null && current - last < STALE_CHUNK_RELOAD_COOLDOWN_MS) {
    return "suppressed-cooldown";
  }
  deps.setLastReloadAt(current);
  deps.reload();
  return "reloaded";
}

/**
 * Registers a `vite:preloadError` handler that reloads once (cooldown-guarded)
 * to recover from chunks orphaned by a redeploy. A no-op when disabled or
 * outside a browser (e.g. the Tauri desktop build, whose local chunks never go
 * stale). When it reloads it calls `preventDefault()` so Vite does not also
 * rethrow the error.
 *
 * Installed for the production web build only. Stale chunks are a
 * redeploy-on-a-static-host phenomenon, so there is nothing to recover from in
 * the desktop (Tauri) build or under the dev server — where a `vite:preloadError`
 * instead signals a transient dependency re-optimization (e.g. the first time a
 * lazy engine like cog-tiler-wasm is loaded), which must NOT reload the app out
 * from under the user's in-progress map.
 *
 * @param options.enabled - Overrides the default gate (production web only).
 * @returns A cleanup function that removes the listener.
 */
export function installStaleChunkReload(options?: { enabled?: boolean }): () => void {
  const enabled = options?.enabled ?? (import.meta.env.PROD && !isTauri());
  if (!enabled || typeof window === "undefined") {
    return () => {};
  }

  const handler = (event: Event) => {
    // Vite dispatches a plain Event with the underlying error on `.payload`
    // (not a CustomEvent `.detail`); surface it so a recovery is visible.
    const payload = (event as Event & { payload?: unknown }).payload;
    let outcome: StaleChunkReloadOutcome = "suppressed-cooldown";
    try {
      outcome = reloadForStaleChunk({
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
        hasUnsavedChanges: () => useAppStore.getState().isDirty,
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
      return;
    }
    if (outcome === "reloaded") {
      // Only suppress Vite's rethrow when we are recovering by reloading; a
      // cooldown-suppressed (broken-build) error should still surface.
      console.warn("[GeoLibre] Reloading to recover from a stale chunk.", payload);
      event.preventDefault();
    } else if (outcome === "deferred-unsaved") {
      // Reloading would discard unsaved work (and raise the "Leave site?"
      // prompt), so the feature is left unloaded. Record an actionable notice
      // instead of letting the raw preload error surface, and suppress Vite's
      // rethrow so it does not read as an unhandled crash. Skip the append when
      // the same notice is already present so repeated retries (each firing a
      // fresh preload error) do not stack identical entries in the panel.
      const alreadyRecorded = getDiagnosticsSnapshot().records.some(
        (record) =>
          record.source === STALE_CHUNK_DIAGNOSTIC_SOURCE &&
          record.message === DEFERRED_RELOAD_MESSAGE,
      );
      if (!alreadyRecorded) {
        appendDiagnostic({
          category: "runtime",
          level: "warning",
          message: DEFERRED_RELOAD_MESSAGE,
          detail:
            payload instanceof Error
              ? payload.message
              : payload != null
                ? String(payload)
                : undefined,
          source: STALE_CHUNK_DIAGNOSTIC_SOURCE,
        });
      }
      event.preventDefault();
    }
  };

  window.addEventListener("vite:preloadError", handler);
  return () => window.removeEventListener("vite:preloadError", handler);
}
