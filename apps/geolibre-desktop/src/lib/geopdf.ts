/**
 * Georeferencing for Print Layout PDF exports (GeoPDF, GH #3523).
 *
 * A captured map image is georeferenced by an affine transform from its pixels
 * to the map's projected CRS. That transform exists only while the screen is a
 * linear view of the CRS (no pitch, not the globe), so {@link solveCaptureGeoref}
 * measures it on a grid of points and refuses when any of them misses by more
 * than a pixel. A refused capture still exports, as a plain PDF.
 *
 * The PDF side writes the ISO 32000 geospatial extension that GDAL, QGIS, Avenza
 * Maps and Acrobat read: a page `/VP` viewport over the map frame whose
 * `/Measure` dictionary pairs the frame's corners (`/LPTS`, in the unit square
 * of the viewport) with their latitude/longitude (`/GPTS`) and names the CRS the
 * map was drawn in (`/GCS`), so a reader can rebuild the exact transform.
 */

/** A projection the georeference is expressed in. */
export interface GeorefProjection {
  /** EPSG code written to the PDF, when the CRS has one. */
  epsg: number | null;
  /** OGC WKT 1 written to the PDF, when known. */
  wkt: string | null;
  /** Whether the CRS is geographic (degrees) rather than projected. */
  geographic: boolean;
  /** Longitude/latitude in degrees to CRS coordinates. */
  forward: (lng: number, lat: number) => [number, number];
  /** CRS coordinates to WGS 84 longitude/latitude in degrees. */
  inverse: (x: number, y: number) => [number, number];
  /**
   * CRS coordinates to longitude/latitude on the CRS's own datum, which is
   * what a GeoPDF's `/GPTS` holds. Defaults to {@link inverse}, which is
   * right for a CRS on WGS 84.
   */
  datumInverse?: (x: number, y: number) => [number, number];
}

/**
 * An affine map from captured-image pixels to CRS coordinates:
 * `x = a + b*px + c*py`, `y = d + e*px + f*py`.
 */
export type GeoTransform = readonly [number, number, number, number, number, number];

/** The georeference of a captured map image. */
export interface CaptureGeoref {
  transform: GeoTransform;
  projection: GeorefProjection;
}

/** A rectangle in page (canvas) pixels. */
export interface PageRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where the captured image lands on the page, from the layout geometry. */
export interface MapImagePlacement {
  /** The visible map: the body rectangle clipped to the drawn image. */
  clip: PageRect;
  /** Page-pixel position of the image's top-left corner. */
  dx: number;
  dy: number;
  /** Page pixels per image pixel. */
  scale: number;
}

const EARTH_RADIUS = 6378137;
const MAX_MERCATOR_LAT = 85.0511287798066;

/** WGS 84 / Pseudo-Mercator, the default map's CRS, as OGC WKT 1. */
export const WEB_MERCATOR_WKT =
  'PROJCS["WGS 84 / Pseudo-Mercator",GEOGCS["WGS 84",DATUM["WGS_1984",' +
  'SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],' +
  'PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,' +
  'AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]],PROJECTION["Mercator_1SP"],' +
  'PARAMETER["central_meridian",0],PARAMETER["scale_factor",1],PARAMETER["false_easting",0],' +
  'PARAMETER["false_northing",0],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Easting",EAST],' +
  'AXIS["Northing",NORTH],EXTENSION["PROJ4","+proj=merc +a=6378137 +b=6378137 +lat_ts=0 ' +
  '+lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs"],' +
  'AUTHORITY["EPSG","3857"]]';

/** The default map's Web Mercator projection. */
export const WEB_MERCATOR: GeorefProjection = {
  epsg: 3857,
  wkt: WEB_MERCATOR_WKT,
  geographic: false,
  forward: (lng, lat) => {
    const clamped = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
    return [
      (EARTH_RADIUS * lng * Math.PI) / 180,
      EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360)),
    ];
  },
  inverse: (x, y) => [
    (x / EARTH_RADIUS) * (180 / Math.PI),
    (2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2) * (180 / Math.PI),
  ],
};

/** The EPSG code in an `EPSG:NNNN` CRS code, or null for anything else. */
export function epsgFromCode(code: string): number | null {
  const match = /^EPSG:(\d{4,6})$/i.exec(code.trim());
  return match ? Number(match[1]) : null;
}

/**
 * Solve the affine transform from captured-image pixels to CRS coordinates and
 * check that it holds across the image.
 *
 * Args:
 *   width: Captured image width in pixels.
 *   height: Captured image height in pixels.
 *   locate: Longitude/latitude under an image pixel, or null when it is off
 *     the map (the sky of a pitched view, space around the globe).
 *   projection: The CRS the map is drawn in.
 *   tolerancePx: How far, in image pixels, a checked point may miss.
 *   options: Allow unwrapped longitudes for grid/inset cartography. GeoPDF
 *     export still validates its own visible viewport independently.
 *
 * Returns:
 *   The georeference, or null when the image is not an affine view of the CRS
 *   (pitch, globe, an off-map corner) or is degenerate.
 */
export function solveCaptureGeoref(
  width: number,
  height: number,
  locate: (px: number, py: number) => { lng: number; lat: number } | null,
  projection: GeorefProjection,
  tolerancePx = 1,
  options: { allowUnwrappedLongitude?: boolean } = {},
): CaptureGeoref | null {
  if (!(width >= 2) || !(height >= 2)) return null;
  const project = (px: number, py: number): [number, number] | null => {
    const ll = locate(px, py);
    if (!ll || !Number.isFinite(ll.lng) || !Number.isFinite(ll.lat)) return null;
    let xy: [number, number];
    try {
      xy = projection.forward(ll.lng, ll.lat);
    } catch {
      // A conversion that throws (a datum grid that will not load) refuses
      // the georeference; the capture still exports as a plain PDF.
      return null;
    }
    return Number.isFinite(xy[0]) && Number.isFinite(xy[1]) ? xy : null;
  };
  const origin = project(0, 0);
  const right = project(width, 0);
  const down = project(0, height);
  if (!origin || !right || !down) return null;
  const transform: GeoTransform = [
    origin[0],
    (right[0] - origin[0]) / width,
    (down[0] - origin[0]) / height,
    origin[1],
    (right[1] - origin[1]) / width,
    (down[1] - origin[1]) / height,
  ];
  const [, b, c, , e, f] = transform;
  const det = b * f - c * e;
  if (!Number.isFinite(det) || det === 0) return null;
  // Check the rest of a 3x3 grid: map each point's true CRS position back into
  // image pixels through the inverse transform and measure the miss there.
  for (const fx of [0, 0.5, 1]) {
    for (const fy of [0, 0.5, 1]) {
      const px = fx * width;
      const py = fy * height;
      const actual = project(px, py);
      if (!actual) return null;
      const dx = actual[0] - transform[0];
      const dy = actual[1] - transform[3];
      const backX = (f * dx - c * dy) / det;
      const backY = (-e * dx + b * dy) / det;
      if (Math.hypot(backX - px, backY - py) > tolerancePx) return null;
    }
  }
  const georef = { transform, projection };
  // A view across the antimeridian or of a repeated world unprojects to
  // longitudes past +/-180, which a GeoPDF cannot carry (see
  // geoPdfViewportEntry), so it is not georeferenced.
  for (const [px, py] of [
    [0, 0],
    [width, 0],
    [0, height],
    [width, height],
  ]) {
    const [lng] = georefLngLat(georef, px, py);
    if (!options.allowUnwrappedLongitude && !(Math.abs(lng) <= 180)) return null;
  }
  return georef;
}

/**
 * Longitude/latitude of an image pixel through a capture's georeference.
 *
 * Args:
 *   georef: The capture's georeference.
 *   px: Image x in pixels.
 *   py: Image y in pixels.
 *
 * Returns:
 *   `[lng, lat]` in degrees.
 */
export function georefLngLat(georef: CaptureGeoref, px: number, py: number): [number, number] {
  const [a, b, c, d, e, f] = georef.transform;
  return georef.projection.inverse(a + b * px + c * py, d + e * px + f * py);
}

/** Longitude/latitude of an image pixel on the georeference CRS's own datum. */
function georefDatumLngLat(georef: CaptureGeoref, px: number, py: number): [number, number] {
  const [a, b, c, d, e, f] = georef.transform;
  const { datumInverse, inverse } = georef.projection;
  return (datumInverse ?? inverse)(a + b * px + c * py, d + e * px + f * py);
}

/** PROJ parameters that describe a datum rather than a projection. */
const DATUM_PARAMS = new Set([
  "datum",
  "ellps",
  "towgs84",
  "nadgrids",
  "a",
  "b",
  "rf",
  "f",
  "R",
  "pm",
]);

/**
 * The geographic (longitude/latitude) PROJ definition on the same datum as a
 * projected one: `+proj=longlat` plus the datum, ellipsoid and shift
 * parameters, with every projection parameter dropped.
 *
 * Args:
 *   definition: A PROJ string.
 *
 * Returns:
 *   The geographic PROJ string.
 */
export function geographicDefinitionOf(definition: string): string {
  const kept = definition
    .trim()
    .split(/\s+/)
    .filter((token) => {
      const match = /^\+([A-Za-z_0-9]+)(?:=|$)/.exec(token);
      return match !== null && DATUM_PARAMS.has(match[1]);
    });
  return ["+proj=longlat", ...kept, "+no_defs"].join(" ");
}

/** Format a number for a PDF content stream: finite, without exponent notation. */
function pdfNum(value: number, digits: number): string {
  const fixed = value.toFixed(digits);
  // Trim trailing zeros, keeping at least one digit, so "12.500000" -> "12.5".
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") || "0" : fixed;
}

/** Escape a string for a PDF literal string `( ... )`. */
function pdfString(value: string): string {
  return value.replace(/[\\()]/g, (ch) => `\\${ch}`);
}

/**
 * The `/VP` page entry that georeferences a page's map frame.
 *
 * Args:
 *   georef: The captured image's georeference.
 *   placement: Where the image lands on the page, in page pixels.
 *   pageWidthPx: Page width in the same pixels.
 *   pageHeightPx: Page height in the same pixels.
 *   pageWidthPt: Page width in PDF points.
 *   pageHeightPt: Page height in PDF points.
 *
 * Returns:
 *   The `/VP [ ... ]` text to write into the page dictionary, or null when the
 *   frame is empty or the CRS carries neither an EPSG code nor a WKT.
 */
export function geoPdfViewportEntry(
  georef: CaptureGeoref,
  placement: MapImagePlacement,
  pageWidthPx: number,
  pageHeightPx: number,
  pageWidthPt: number,
  pageHeightPt: number,
): string | null {
  const { clip, dx, dy, scale } = placement;
  const { epsg, wkt, geographic } = georef.projection;
  if (!(clip.w > 0) || !(clip.h > 0) || !(scale > 0) || (epsg === null && !wkt)) return null;
  if (!(pageWidthPx > 0) || !(pageHeightPx > 0)) return null;
  const kx = pageWidthPt / pageWidthPx;
  const ky = pageHeightPt / pageHeightPx;
  // PDF user space runs bottom-up from the page's lower-left corner.
  const x0 = clip.x * kx;
  const x1 = (clip.x + clip.w) * kx;
  const yTop = pageHeightPt - clip.y * ky;
  const yBottom = pageHeightPt - (clip.y + clip.h) * ky;
  // GPTS pairs follow LPTS: upper-left, lower-left, lower-right, upper-right.
  const corners = [
    [clip.x, clip.y],
    [clip.x, clip.y + clip.h],
    [clip.x + clip.w, clip.y + clip.h],
    [clip.x + clip.w, clip.y],
  ].map(([pageX, pageY]) => georefDatumLngLat(georef, (pageX - dx) / scale, (pageY - dy) / scale));
  // A frame across the antimeridian (or a repeated world) has longitudes past
  // +/-180. GPTS cannot carry them: a reader wraps 181 to -179 and rebuilds a
  // reversed, nearly world-wide extent. Such a frame exports as a plain PDF.
  if (corners.some(([lng, lat]) => !(Math.abs(lng) <= 180) || !(Math.abs(lat) <= 90))) return null;
  const gpts = corners.map(([lng, lat]) => `${pdfNum(lat, 9)} ${pdfNum(lng, 9)}`).join(" ");
  const gcs = [
    `/Type /${geographic ? "GEOGCS" : "PROJCS"}`,
    epsg !== null ? `/EPSG ${epsg}` : "",
    wkt ? `/WKT (${pdfString(wkt)})` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const bbox = [x0, yBottom, x1, yTop].map((n) => pdfNum(n, 4)).join(" ");
  return (
    `/VP [<< /Type /Viewport /Name (Map) /BBox [${bbox}] ` +
    `/Measure << /Type /Measure /Subtype /GEO /Bounds [0 1 0 0 1 0 1 1] ` +
    `/LPTS [0 1 0 0 1 0 1 1] /GPTS [${gpts}] /GCS << ${gcs} >> >> >>]`
  );
}
