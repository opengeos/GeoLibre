import type { MapViewState } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * How many distinct viewports the history keeps. The oldest entries are trimmed
 * once the stack grows past this; the issue asks for at least five, so this
 * leaves comfortable headroom.
 */
const MAX_HISTORY = 50;

/** True when two viewports are close enough to treat as the same map state. */
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
 *
 * Returns:
 *     The current navigability flags and the back/forward actions.
 */
export function useViewportHistory(
  mapControllerRef: React.RefObject<MapController | null>,
  mapReadyGeneration: number,
): ViewportHistory {
  const historyRef = useRef<MapViewState[]>([]);
  const indexRef = useRef(-1);
  // Set while we drive the camera ourselves so the resulting `moveend` is not
  // recorded as a new history entry.
  const restoringRef = useRef(false);
  const [nav, setNav] = useState({ canGoBack: false, canGoForward: false });

  const syncNav = useCallback(() => {
    const canGoBack = indexRef.current > 0;
    const canGoForward =
      indexRef.current >= 0 &&
      indexRef.current < historyRef.current.length - 1;
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

    const onMoveEnd = () => {
      if (restoringRef.current) {
        restoringRef.current = false;
        return;
      }
      record();
    };

    map.on("moveend", onMoveEnd);
    // Seed from the current camera right away (no-op if already seeded).
    record();

    return () => {
      map.off("moveend", onMoveEnd);
    };
  }, [mapControllerRef, mapReadyGeneration, syncNav]);

  const restore = useCallback(
    (nextIndex: number) => {
      const view = historyRef.current[nextIndex];
      if (!view) return;
      indexRef.current = nextIndex;
      restoringRef.current = true;
      mapControllerRef.current?.applyView(view);
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
