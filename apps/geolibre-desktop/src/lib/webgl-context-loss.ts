/**
 * Notices when a map canvas loses its WebGL context (a graphics driver reset,
 * the GPU process crashing, or the browser reclaiming contexts under memory
 * pressure). The map then freezes or goes blank with nothing in the UI saying
 * why, and only a reload brings it back unless the engine restores it.
 *
 * WebGL context events do not bubble, so the tracker listens in the capture
 * phase on an ancestor of every canvas: one listener covers MapLibre, Mapbox,
 * the globe, ArcGIS, and deck.gl overlay canvases alike.
 */

/** What the tracker reports to its caller. */
export interface WebglContextLossCallbacks {
  /** The first canvas lost its context (fires once until all are restored). */
  onLost: () => void;
  /** Every lost canvas got its context back. */
  onRestored: () => void;
}

/**
 * Watch `target`'s subtree for lost and restored WebGL contexts.
 *
 * @param target - An ancestor of the map canvases (or a canvas itself).
 * @param callbacks - Called on the first loss and once all are restored.
 * @returns A cleanup function that removes the listeners.
 */
export function trackWebglContextLoss(
  target: EventTarget,
  callbacks: WebglContextLossCallbacks,
): () => void {
  const lost = new Set<EventTarget>();
  // A pane removed while its context was lost never sends a restore, so forget
  // detached canvases; otherwise a later loss elsewhere would go unreported.
  const pruneDetached = () => {
    for (const canvas of lost) {
      if ((canvas as { isConnected?: boolean }).isConnected === false) lost.delete(canvas);
    }
  };
  const handleLost = (event: Event) => {
    const canvas = event.target ?? target;
    pruneDetached();
    const wasClear = lost.size === 0;
    lost.add(canvas);
    if (wasClear) callbacks.onLost();
  };
  const handleRestored = (event: Event) => {
    const canvas = event.target ?? target;
    if (!lost.delete(canvas)) return;
    pruneDetached();
    if (lost.size === 0) callbacks.onRestored();
  };
  target.addEventListener("webglcontextlost", handleLost, true);
  target.addEventListener("webglcontextrestored", handleRestored, true);
  return () => {
    target.removeEventListener("webglcontextlost", handleLost, true);
    target.removeEventListener("webglcontextrestored", handleRestored, true);
  };
}
