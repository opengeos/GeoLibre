/**
 * Globe-safe camera fitting.
 *
 * A globe can only ever show half the planet's longitudes at once, so an extent
 * wider than a hemisphere has no camera that contains it. MapLibre's `fitBounds`
 * does not treat that as the special case it is: past roughly a hemisphere its
 * globe camera solver stops pulling back and starts zooming *in* again. Measured
 * against the live map on a 576x648 viewport with 40px padding, sampling the
 * box outline to see how much of it lands inside the padded viewport:
 *
 * | bbox width | globe zoom | outline in frame | flat-map zoom |
 * | ---------- | ---------- | ---------------- | ------------- |
 * | 90°        | 2.27       | 42/42            | 1.95          |
 * | 150°       | 1.97       | 42/42            | 1.22          |
 * | 170°       | 2.00       | 42/42            | 1.07          |
 * | 175°       | 2.01       | 34/42            | 1.03          |
 * | 259°       | 3.10       | 10/42            | 0.43          |
 * | 360°       | 2.36       | 46/84            | 0.00          |
 *
 * So MapLibre frames narrow and continent-scale extents correctly and only
 * breaks down past a hemisphere, where it leaves the data behind the horizon and
 * the layer reads to the user as "added, but nothing shows up on the map". It
 * takes very little to get there: a mostly-US point layer with three records in
 * Europe and Asia already spans 259° (#1552).
 *
 * {@link globeSafeMaxZoom} therefore engages only for those extents, capping the
 * fit at the flat Web Mercator zoom so the camera settles on a whole-globe view
 * instead. Fits MapLibre already handles are left exactly as they were.
 *
 * The cap is a ceiling, never a floor, so it cannot tighten a fit; and under the
 * mercator projection it equals what `fitBounds` computes anyway, making it a
 * no-op there.
 */

/**
 * The latitude at which Web Mercator is truncated; the projection runs to
 * infinity at the poles.
 */
const MAX_MERCATOR_LATITUDE = 85.051129;

/** The tile size MapLibre's zoom scale is defined against. */
const TILE_SIZE = 512;

/**
 * The widest longitude span a globe can show at once: half the planet. Past
 * this, no camera contains the extent and MapLibre's globe fit degrades (see
 * the measurements above), so the flat-map ceiling takes over. The measured
 * boundary sits a little under this (containment ends around 175° on a 576x648
 * viewport, since the padding eats into the visible hemisphere), but the
 * geometric limit is used rather than a viewport-tuned constant: extents in
 * that narrow band keep MapLibre's own fit, which puts only their extreme
 * east/west edges just outside the padding.
 */
const GLOBE_VISIBLE_LONGITUDE_SPAN = 180;

/** Normalized (0..1) Web Mercator northing for a latitude in degrees. */
function mercatorY(latitude: number): number {
  const clamped = Math.min(MAX_MERCATOR_LATITUDE, Math.max(-MAX_MERCATOR_LATITUDE, latitude));
  return 0.5 - Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360)) / (2 * Math.PI);
}

/**
 * The longitude span of a bounding box in degrees, taking the short way round
 * so an extent that crosses the antimeridian (`west` greater than `east`, e.g.
 * `[170, …, -170, …]`) reads as the ~20° it covers rather than the ~340°
 * complement. A full-world box (`[-180, …, 180, …]`) still reads as 360.
 */
function longitudeSpan(west: number, east: number): number {
  const span = east - west;
  if (span >= 360) return 360;
  return ((span % 360) + 360) % 360;
}

/**
 * Compute the zoom at which a bounding box fits a viewport under flat Web
 * Mercator — the ceiling that keeps the globe camera honest.
 *
 * @param bounds - The extent to fit, as `[west, south, east, north]` in WGS84
 *   degrees. A `west` greater than `east` is read as crossing the antimeridian.
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
  const worldFractionX = longitudeSpan(west, east) / 360;
  const worldFractionY = Math.abs(mercatorY(south) - mercatorY(north));

  const scales: number[] = [];
  if (worldFractionX > 0) scales.push(usableWidth / (TILE_SIZE * worldFractionX));
  if (worldFractionY > 0) scales.push(usableHeight / (TILE_SIZE * worldFractionY));
  if (scales.length === 0) return null;

  const zoom = Math.log2(Math.min(...scales));
  return Number.isFinite(zoom) ? zoom : null;
}

/**
 * The zoom ceiling to pass to `fitBounds` for `bounds`: the caller's own
 * ceiling, tightened to the flat-map fit for an extent too wide for any globe
 * camera to contain. Returns `null` when neither applies, so the caller can omit
 * `maxZoom` rather than send an undefined one.
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
  const [west, , east] = bounds;
  const spansMoreThanAGlobeShows =
    Number.isFinite(west) &&
    Number.isFinite(east) &&
    longitudeSpan(west, east) > GLOBE_VISIBLE_LONGITUDE_SPAN;
  if (!spansMoreThanAGlobeShows) return requestedMaxZoom ?? null;

  const flatZoom = viewport ? mercatorFitZoom(bounds, viewport, padding) : null;
  if (flatZoom === null) return requestedMaxZoom ?? null;
  return requestedMaxZoom === undefined ? flatZoom : Math.min(flatZoom, requestedMaxZoom);
}
