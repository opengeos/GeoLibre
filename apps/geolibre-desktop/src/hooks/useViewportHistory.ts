import type { MapViewState } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * How many distinct viewports the history keeps. The oldest entries are trimmed
 * once the stack grows past this; the issue asks for at least five, so this
 * leaves comfortable headroom.
 */
const MAX_HISTORY = 50;

/** True when two viewports are identical (exact equality on all camera fields). */
function viewsEqual(a: MapViewState, b: MapViewState): boolean {
  return (
    a.center[0] === b.center[0] &&
    a.center[1] === b.center[1] &&
    a.zoom === b.zoom &&
    a.bearing === b.bearing &&
    a.pitch === b.pitch
  );
}

/** Reactive enable-state plus actions for the back/forward viewport controls. */
export interface ViewportHistory {
  canGoBack: boolean;
  canGoForward: boolean;
  goBack: () => void;
  goForward: () => void;
}

/**
 * Tracks a browser-style back/forward history of map viewports.
 *
 * Every time the user settles the camera (a `moveend` that we did not trigger)
 * the new view is pushed onto a stack, dropping any "forward" entries the way a
 * browser does after you navigate from a back-stack position. `goBack`/
 * `goForward` jump the camera through that stack; the `moveend` those jumps emit
 * is flagged so it is not recorded as a fresh entry.
 *
 * The stack lives in refs so routine map panning does not re-render the toolbar;
 * only the two enable booleans are React state, and they update solely when they
 * actually change.
 *
 * Args:
 *     mapControllerRef: Ref to the live MapController.
 *     mapReadyGeneration: Counter that increments when the map (re)initialises,
 *         used to (re)attach the `moveend` listener once a map exists.
 *     projectGeneration: Counter that increments when a different project is
 *         loaded; the stack is cleared so "Previous View" can't jump back into
 *         the previous project's extents.
 *
 * Returns:
 *     The current navigability flags and the back/forward actions.
 */
export function useViewportHistory(
  mapControllerRef: React.RefObject<MapController | null>,
  mapReadyGeneration: number,
  projectGeneration: number,
): ViewportHistory {
  const historyRef = useRef<MapViewState[]>([]);
  const indexRef = useRef(-1);
  // Counts camera moves we drive ourselves whose `moveend` is still pending, so
  // those events are not recorded as new history entries. A counter (not a
  // boolean) is needed because rapid back/forward clicks cancel each in-flight
  // `easeTo`, firing one `moveend` per call — a boolean would be cleared by the
  // first and let a later cancelled-midway position leak into the stack.
  const restoringCountRef = useRef(0);
  // The project the current stack belongs to, so a project switch resets it.
  const projectGenerationRef = useRef(projectGeneration);
  const [nav, setNav] = useState({ canGoBack: false, canGoForward: false });

  const syncNav = useCallback(() => {
    const canGoBack = indexRef.current > 0;
    const canGoForward = indexRef.current >= 0 && indexRef.current < historyRef.current.length - 1;
    setNav((prev) =>
      prev.canGoBack === canGoBack && prev.canGoForward === canGoForward
        ? prev
        : { canGoBack, canGoForward },
    );
  }, []);

  useEffect(() => {
    const map = mapControllerRef.current?.getMap() ?? null;
    if (!map) return;
    const controller = mapControllerRef.current;

    // Loading a different project clears the stack so navigation can't cross
    // project boundaries. A basemap change (which only bumps mapReadyGeneration)
    // keeps the history, since the viewport is unchanged.
    if (projectGenerationRef.current !== projectGeneration) {
      projectGenerationRef.current = projectGeneration;
      historyRef.current = [];
      indexRef.current = -1;
      syncNav();
    }

    const record = () => {
      const view = controller?.readView();
      if (!view) return;
      // Seed the stack with the first view we see.
      if (indexRef.current < 0) {
        historyRef.current = [view];
        indexRef.current = 0;
        syncNav();
        return;
      }
      // Ignore no-op moves (the initial settle, a re-attach to the same map, or
      // a restore that landed exactly where we already were).
      if (viewsEqual(view, historyRef.current[indexRef.current])) return;
      // Drop any forward history, then append the new view.
      const next = historyRef.current.slice(0, indexRef.current + 1);
      next.push(view);
      // Cap the stack, trimming the oldest entries.
      if (next.length > MAX_HISTORY) next.splice(0, next.length - MAX_HISTORY);
      historyRef.current = next;
      indexRef.current = next.length - 1;
      syncNav();
    };

    const onMoveEnd = (event: { storyCameraToken?: number }) => {
      // Story presenter / chapter-preview camera moves carry a storyCameraToken
      // in their event data. Those are scripted playback, not user navigation,
      // so don't record them (checked before the restore counter so a story
      // move never consumes a pending restore's slot).
      if (event?.storyCameraToken !== undefined) return;
      if (restoringCountRef.current > 0) {
        restoringCountRef.current--;
        return;
      }
      record();
    };

    map.on("moveend", onMoveEnd);
    // Clear any pending count left by a restore that was in flight when a prior
    // map was torn down (its `moveend` never fired), so this map starts clean.
    restoringCountRef.current = 0;
    // Seed from the current camera right away (no-op if already seeded).
    record();

    return () => {
      map.off("moveend", onMoveEnd);
      restoringCountRef.current = 0;
    };
  }, [mapControllerRef, mapReadyGeneration, projectGeneration, syncNav]);

  const restore = useCallback(
    (nextIndex: number) => {
      const view = historyRef.current[nextIndex];
      if (!view) return;
      const controller = mapControllerRef.current;
      // Bail before touching the flag if there's no map to drive — otherwise it
      // would stay `true` (no `moveend` to clear it) and swallow the next pan.
      if (!controller) return;
      indexRef.current = nextIndex;
      restoringCountRef.current++;
      // Animate (easeTo) rather than jump, matching the browser-style framing.
      controller.easeToView(view);
      syncNav();
    },
    [mapControllerRef, syncNav],
  );

  const goBack = useCallback(() => {
    if (indexRef.current > 0) restore(indexRef.current - 1);
  }, [restore]);

  const goForward = useCallback(() => {
    if (indexRef.current < historyRef.current.length - 1) {
      restore(indexRef.current + 1);
    }
  }, [restore]);

  return { ...nav, goBack, goForward };
}
