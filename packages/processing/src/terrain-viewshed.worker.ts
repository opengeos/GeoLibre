/// <reference lib="webworker" />
import {
  computeViewshed,
  type TerrainDem,
  type ViewshedObserver,
  type ViewshedResult,
} from "./terrain-viewshed";

// Runs one viewshed off the main thread. The line-of-sight walk is O(n³) in the
// grid's side length with no yield points, so on the main thread it freezes the
// tab for its whole duration — several seconds at the 15 km preset on modest
// hardware, which reads worse than a network wait because nothing repaints.
//
// One viewshed per worker: the caller terminates this worker as soon as the
// terminal message arrives, so nothing here has to be reusable across runs.
const worker = self as unknown as DedicatedWorkerGlobalScope;

/** The request: a DEM, an observer, and the cull radius. */
export interface ViewshedWorkerRequest {
  dem: TerrainDem;
  observer: ViewshedObserver;
  radiusMeters: number;
}

/** The single message this worker posts back. */
export type ViewshedWorkerResponse =
  // Spread from ViewshedResult rather than restated: a field added there must
  // travel back with it, and the rest-spread in computeViewshedAsync would
  // otherwise drop it with no type error.
  ({ ok: true } & ViewshedResult) | { ok: false; error: string };

worker.addEventListener("message", (event: MessageEvent<ViewshedWorkerRequest>) => {
  const { dem, observer, radiusMeters } = event.data;
  try {
    const result = computeViewshed(dem, observer, radiusMeters);
    // The visibility grid is transferred rather than copied: it is the only
    // large payload going back, and this worker is terminated immediately
    // afterwards so it has no use for the buffer.
    worker.postMessage({ ok: true, ...result } satisfies ViewshedWorkerResponse, [
      result.visible.buffer as ArrayBuffer,
    ]);
  } catch (error) {
    worker.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies ViewshedWorkerResponse);
  }
});
