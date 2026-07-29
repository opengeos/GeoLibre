/**
 * Globe-safe camera fitting.
 *
 * MapLibre's `fitBounds` stops behaving under the globe projection — the app's
 * default — once an extent grows past roughly a third of the planet: instead of
 * continuing to pull back, the globe camera solver starts zooming *in* again.
 * Measured against the live map on a 576x648 viewport with 40px padding:
 *
 * | bbox width | globe zoom | flat-map zoom |
 * | ---------- | ---------- | ------------- |
 * | 90°        | 2.27       | 1.95          |
 * | 150°       | 1.97       | 1.22          |
 * | 259°       | 3.10       | 0.43          |
 * | 359°       | 5.00       | 0.00          |
 *
 * A layer that spans most of the world therefore gets framed on an empty patch
 * of ocean with every feature behind the horizon, and reads to the user as
 * "added, but nothing shows up on the map". It takes very little to trigger:
 * a mostly-US point layer with three records in Europe and Asia already spans
 * 259°.
 *
 * {@link mercatorFitZoom} computes the flat Web Mercator fit, which callers
 * hand to `fitBounds` as a zoom ceiling. It can only ever loosen the camera:
 * the globe shows less of the world than Web Mercator does at the same zoom,
 * and MapLibre already pulls back further than this to account for bearing and
 * pitch. A sane fit is left untouched; a broken one lands on a whole-globe view
 * with the data in frame.
 */

/**
 * The latitude at which Web Mercator is truncated; the projection runs to
 * infinity at the poles.
 */
const MAX_MERCATOR_LATITUDE = 85.051129;

/** The tile size MapLibre's zoom scale is defined against. */
const TILE_SIZE = 512;

/** Normalized (0..1) Web Mercator northing for a latitude in degrees. */
function mercatorY(latitude: number): number {
  const clamped = Math.min(MAX_MERCATOR_LATITUDE, Math.max(-MAX_MERCATOR_LATITUDE, latitude));
  return 0.5 - Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360)) / (2 * Math.PI);
}

/**
 * Compute the zoom at which a bounding box fits a viewport under flat Web
 * Mercator — the ceiling that keeps the globe camera honest.
 *
 * @param bounds - The extent to fit, as `[west, south, east, north]` in WGS84
 *   degrees.
 * @param viewport - The map viewport size in CSS pixels.
 * @param padding - Padding to keep free on every side, in CSS pixels.
 * @returns The fitting zoom, or `null` when the inputs cannot produce one: a
 *   non-finite extent, a viewport smaller than its own padding, or a
 *   point-sized extent (no width and no height to constrain the zoom).
 */
export function mercatorFitZoom(
  bounds: [number, number, number, number],
  viewport: { width: number; height: number },
  padding: number,
): number | null {
  if (!bounds.every((value) => Number.isFinite(value))) return null;
  const [west, south, east, north] = bounds;
  const usableWidth = viewport.width - 2 * padding;
  const usableHeight = viewport.height - 2 * padding;
  if (!(usableWidth > 0) || !(usableHeight > 0)) return null;

  // Either span may be zero (a single point, or a perfectly horizontal line);
  // such an axis simply places no constraint on the zoom.
  const worldFractionX = Math.abs(east - west) / 360;
  const worldFractionY = Math.abs(mercatorY(south) - mercatorY(north));

  const scales: number[] = [];
  if (worldFractionX > 0) scales.push(usableWidth / (TILE_SIZE * worldFractionX));
  if (worldFractionY > 0) scales.push(usableHeight / (TILE_SIZE * worldFractionY));
  if (scales.length === 0) return null;

  const zoom = Math.log2(Math.min(...scales));
  return Number.isFinite(zoom) ? zoom : null;
}

/**
 * The zoom ceiling to pass to `fitBounds` for `bounds`, combining the caller's
 * own ceiling (if any) with the flat-map fit. Returns `null` when neither
 * applies, so the caller can omit `maxZoom` rather than send an undefined one.
 *
 * @param bounds - The extent about to be fit, as `[west, south, east, north]`.
 * @param viewport - The map viewport size in CSS pixels, or `null` when it
 *   cannot be measured (a canvas that has never been laid out reports zero,
 *   and a ceiling computed from that would be nonsense).
 * @param padding - The padding the fit will use, in CSS pixels.
 * @param requestedMaxZoom - A ceiling the caller wants regardless of extent.
 */
export function globeSafeMaxZoom(
  bounds: [number, number, number, number],
  viewport: { width: number; height: number } | null,
  padding: number,
  requestedMaxZoom?: number,
): number | null {
  const flatZoom = viewport ? mercatorFitZoom(bounds, viewport, padding) : null;
  if (flatZoom === null) return requestedMaxZoom ?? null;
  return requestedMaxZoom === undefined ? flatZoom : Math.min(flatZoom, requestedMaxZoom);
}
