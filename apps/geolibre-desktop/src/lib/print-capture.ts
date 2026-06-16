/**
 * Pure helpers for the Print Layout map capture.
 *
 * Kept dependency-free (no DOM, Tauri, or canvas APIs) so the decision logic can
 * be unit tested in isolation from {@link ./print-layout-export}, which pulls in
 * jsPDF and the Tauri filesystem bridge.
 */

/**
 * Decide whether a `<canvas>` found inside the map container is a full-viewport
 * map render surface that should be composited into the snapshot.
 *
 * The map container holds the MapLibre base canvas and, on desktop, a deck.gl
 * overlay canvas (both sized to the full viewport). It can also hold small UI
 * canvases that map controls render: the raster control's colorbar/colormap
 * previews and the lidar profile chart. Those must be skipped, otherwise the
 * capture loop stretches them to fill the whole page and clobbers the map with,
 * for example, a horizontal colormap ramp.
 *
 * This is a size heuristic, not an allow-list: it assumes the only
 * full-viewport canvases in the container are map render surfaces, and that
 * control/preview canvases are comfortably smaller than 90% of the base in at
 * least one dimension (today's previews are ~280x24, so they are). Two edges to
 * keep in mind if that assumption ever changes: a deck.gl overlay rendered at
 * under 90% of the base (e.g. a different device-pixel-ratio) would be dropped
 * from the snapshot, and a future near-full-screen widget canvas (e.g. a 95%
 * minimap) would be composited over the map. Prefer an explicit allow-list keyed
 * on the overlay canvas if either case becomes real.
 *
 * @param canvas - A candidate canvas, kept if it is the base by identity or
 *   matches the base size.
 * @param base - The MapLibre base canvas, used as the reference size.
 * @returns True for the base canvas and any other canvas at least 90% of the
 *   base's width and height; false for the smaller control/preview canvases.
 */
export function isFullViewportMapCanvas(
  canvas: { width: number; height: number },
  base: { width: number; height: number },
): boolean {
  if (canvas === base) return true;
  // If the base size is unknown, keep only the base itself: compositing other
  // canvases into a 0-sized output is a no-op anyway, and returning true here
  // would let a control's colorbar canvas through and reintroduce the bug.
  if (base.width === 0 || base.height === 0) return false;
  return canvas.width >= base.width * 0.9 && canvas.height >= base.height * 0.9;
}
