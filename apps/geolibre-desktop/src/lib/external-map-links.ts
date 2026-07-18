// URL builders for "view this location in an external mapping site" actions
// (map context menu + View menu). Pure functions with no DOM or map access so
// they can be unit-tested in Node; call sites hand the result to
// `openExternalLink`.

/** Decimal places for coordinates in generated URLs (~0.1 m at the equator). */
const COORD_PRECISION = 6;

/** Zoom range Google Maps accepts in the `@lat,lng,{zoom}z` camera URL. */
const GOOGLE_MAPS_MIN_ZOOM = 2;
const GOOGLE_MAPS_MAX_ZOOM = 21;

/**
 * Scaling anchor for the zoom → Google Earth camera distance conversion, in
 * metres: the (theoretical) distance whose ~35° field of view spans the same
 * ground width as a web-mercator zoom-0 view (visible ground width is about
 * 0.63 × distance, and a ~1000 px viewport at zoom 0 spans ~156543 m/px ×
 * 1000 px). The distance halves per zoom level like mercator resolution does.
 * Note this anchor exceeds GOOGLE_EARTH_MAX_DISTANCE, so zooms below ~2 all
 * clamp to the same whole-globe view rather than tracking the formula.
 */
const GOOGLE_EARTH_DISTANCE_AT_ZOOM_0 = 248_500_000;
/** Keep the camera distance inside the range Google Earth web navigates to. */
const GOOGLE_EARTH_MIN_DISTANCE = 150;
const GOOGLE_EARTH_MAX_DISTANCE = 65_000_000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Wrap a longitude into [-180, 180]; MapLibre lets it run past the antimeridian. */
function wrapLongitude(lng: number): number {
  const wrapped = ((((lng + 180) % 360) + 360) % 360) - 180;
  // Avoid "-0.000000" in URLs.
  return Object.is(wrapped, -0) ? 0 : wrapped;
}

/**
 * Build a Google Maps URL centered on a coordinate at (approximately) the
 * given web-mercator zoom. With `marker: true` the coordinate is also passed
 * as a place query so Google Maps drops a pin on it — used by the map context
 * menu, where the clicked point matters more than the viewport.
 */
export function googleMapsUrl(
  lat: number,
  lng: number,
  zoom: number,
  options?: { marker?: boolean },
): string {
  const latText = clamp(lat, -90, 90).toFixed(COORD_PRECISION);
  const lngText = wrapLongitude(lng).toFixed(COORD_PRECISION);
  // Google Maps accepts fractional zoom; two decimals is plenty.
  const zoomText = String(
    Number(clamp(zoom, GOOGLE_MAPS_MIN_ZOOM, GOOGLE_MAPS_MAX_ZOOM).toFixed(2)),
  );
  const camera = `@${latText},${lngText},${zoomText}z`;
  return options?.marker
    ? `https://www.google.com/maps/place/${latText},${lngText}/${camera}`
    : `https://www.google.com/maps/${camera}`;
}

/**
 * Build a Google Earth web URL looking straight down at a coordinate from a
 * camera distance that matches the given web-mercator zoom. Mercator
 * metres-per-pixel shrink with cos(latitude), so the distance does too —
 * without the correction a high-latitude view would open far more zoomed out
 * in Google Earth than it looks in GeoLibre.
 */
export function googleEarthUrl(lat: number, lng: number, zoom: number): string {
  const clampedLat = clamp(lat, -90, 90);
  const distance = Math.round(
    clamp(
      (GOOGLE_EARTH_DISTANCE_AT_ZOOM_0 * Math.cos((clampedLat * Math.PI) / 180)) / 2 ** zoom,
      GOOGLE_EARTH_MIN_DISTANCE,
      GOOGLE_EARTH_MAX_DISTANCE,
    ),
  );
  const latText = clampedLat.toFixed(COORD_PRECISION);
  const lngText = wrapLongitude(lng).toFixed(COORD_PRECISION);
  return `https://earth.google.com/web/@${latText},${lngText},0a,${distance}d,35y,0h,0t,0r`;
}
