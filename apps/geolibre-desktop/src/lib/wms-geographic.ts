// A WMS that does not offer EPSG:3857 rejects the Web Mercator GetMap that
// MapLibre builds for every tile. When the tile template names a geographic
// CRS instead (`SRS=EPSG:4326&BBOX={bbox-epsg-3857}`), the desktop tile
// protocol asks for the tile's lon/lat extent in that CRS and redraws the
// latitude-linear image into Web Mercator, strip by strip.

/**
 * Geographic CRSs the desktop can request and redraw into Web Mercator. Keep in
 * step with `WMS_CRS` in `python/src/geolibre/project.py`, which is this set
 * plus EPSG:3857: a CRS Python accepts but this set lacks renders blank. A
 * test in `tests/wms-geographic.test.ts` fails when the two drift.
 */
export const GEOGRAPHIC_WMS_CRS = new Set(["EPSG:4326", "EPSG:4258", "EPSG:6706", "CRS:84"]);

const WEB_MERCATOR_HALF_WORLD = 20037508.342789244;
const LATITUDE_STRIPS = 16;

export interface GeographicWmsRequest {
  /** The GetMap URL with the BBOX rewritten in degrees for the geographic CRS. */
  url: string;
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface StripPlacement {
  sourceY: number;
  sourceHeight: number;
  targetY: number;
  targetHeight: number;
}

export function queryParam(params: URLSearchParams, name: string): [string, string] | null {
  for (const [key, value] of params) if (key.toLowerCase() === name) return [key, value];
  return null;
}

export function longitudeFromMercatorX(x: number): number {
  return (x / WEB_MERCATOR_HALF_WORLD) * 180;
}

export function latitudeFromMercatorY(y: number): number {
  return (Math.atan(Math.sinh((y / WEB_MERCATOR_HALF_WORLD) * Math.PI)) * 180) / Math.PI;
}

/** Normalized Web Mercator y (0 at the top of the world, 1 at the bottom). */
function mercatorY(latitude: number): number {
  const lat = Math.max(-85.05112878, Math.min(85.05112878, latitude));
  const radians = (lat * Math.PI) / 180;
  return (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2;
}

/**
 * Rewrite a concrete GetMap tile URL whose SRS/CRS is geographic but whose
 * BBOX MapLibre filled in Web Mercator metres. Returns null for any other
 * request, which is then fetched unchanged.
 */
export function geographicWmsRequest(url: string): GeographicWmsRequest | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const params = parsed.searchParams;
  const crs = queryParam(params, "crs") ?? queryParam(params, "srs");
  const crsCode = crs?.[1].trim().toUpperCase() ?? "";
  if (!GEOGRAPHIC_WMS_CRS.has(crsCode)) return null;
  const bbox = queryParam(params, "bbox");
  if (!bbox) return null;
  const values = bbox[1].split(",").map(Number);
  if (values.length !== 4 || !values.every(Number.isFinite)) return null;

  const [minX, minY, maxX, maxY] = values;
  // A zero-height or inverted extent has nothing to redraw.
  if (!(maxX > minX && maxY > minY)) return null;
  const west = longitudeFromMercatorX(minX);
  const east = longitudeFromMercatorX(maxX);
  const south = latitudeFromMercatorY(minY);
  const north = latitudeFromMercatorY(maxY);
  // WMS 1.3.0 follows the EPSG axis order, latitude first, for EPSG:4326,
  // EPSG:4258 and EPSG:6706. CRS:84 and WMS 1.1.1 stay longitude first.
  // Any 1.3.x version, as Python's `_normalize_wms_version` reads it, so a
  // hand-written `VERSION=1.3` does not silently swap the axes.
  const version = queryParam(params, "version")?.[1].trim() ?? "";
  const latitudeFirst = version.startsWith("1.3") && crsCode !== "CRS:84";
  const degrees = latitudeFirst ? [south, west, north, east] : [west, south, east, north];
  params.set(bbox[0], degrees.join(","));
  return { url: parsed.toString(), west, south, east, north };
}

/**
 * Where each horizontal strip of a latitude-linear image lands in a Web
 * Mercator tile of `targetSize` pixels covering the same extent.
 */
export function mercatorStrips(
  south: number,
  north: number,
  sourceHeight: number,
  targetSize: number,
): StripPlacement[] {
  const top = mercatorY(north);
  const span = mercatorY(south) - top;
  const strips: StripPlacement[] = [];
  // Strips divide by the extent's height: a degenerate one yields no strips
  // rather than NaN placements that would make drawImage throw.
  if (!(span > 0)) return strips;
  for (let strip = 0; strip < LATITUDE_STRIPS; strip += 1) {
    const stripNorth = north - ((north - south) * strip) / LATITUDE_STRIPS;
    const stripSouth = north - ((north - south) * (strip + 1)) / LATITUDE_STRIPS;
    const targetY = ((mercatorY(stripNorth) - top) / span) * targetSize;
    strips.push({
      sourceY: (strip / LATITUDE_STRIPS) * sourceHeight,
      sourceHeight: sourceHeight / LATITUDE_STRIPS,
      targetY,
      targetHeight: ((mercatorY(stripSouth) - top) / span) * targetSize - targetY,
    });
  }
  return strips;
}

/**
 * The start of a GetMap response that is not an image, typically an XML
 * `ServiceException` naming the real cause (an unsupported CRS, a bad BBOX).
 */
export function describeWmsFailure(bytes: ArrayBuffer): string {
  const text = new TextDecoder().decode(bytes.slice(0, 400)).replace(/\s+/g, " ").trim();
  return `WMS GetMap returned no image${text ? `: ${text}` : ""}`;
}

/** Redraw a latitude-linear WMS image as a Web Mercator PNG tile. */
export async function geographicTileToMercator(
  bytes: ArrayBuffer,
  request: GeographicWmsRequest,
): Promise<ArrayBuffer> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes]));
  } catch {
    throw new Error(describeWmsFailure(bytes));
  }
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2D canvas is unavailable.");
    for (const strip of mercatorStrips(
      request.south,
      request.north,
      bitmap.height,
      bitmap.height,
    )) {
      context.drawImage(
        bitmap,
        0,
        strip.sourceY,
        bitmap.width,
        strip.sourceHeight,
        0,
        strip.targetY,
        bitmap.width,
        strip.targetHeight,
      );
    }
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return blob.arrayBuffer();
  } finally {
    bitmap.close();
  }
}
