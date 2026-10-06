// A WMS that lists only projected CRSs (UTM, national grids) rejects the Web
// Mercator GetMap MapLibre builds for every tile. When the tile template names
// such a CRS (`SRS=EPSG:25832&BBOX={bbox-epsg-3857}`), the desktop tile
// protocol asks for an extent in that CRS covering the tile and warps the image
// into Web Mercator pixel by pixel, the way a GeoTIFF in a projected CRS is
// reprojected. The geographic CRSs in GEOGRAPHIC_WMS_CRS take the cheaper strip
// path in wms-geographic.ts; any other geographic EPSG code (e.g. EPSG:4269) is
// warped here, in degrees.

import { resolveEpsgProjection } from "./epsg-proj4";
import {
  describeWmsFailure,
  GEOGRAPHIC_WMS_CRS,
  latitudeFromMercatorY,
  longitudeFromMercatorX,
  queryParam,
} from "./wms-geographic";

/** Segments each tile edge is split into (EDGE_SAMPLES + 1 points) to find the extent that covers it. */
const EDGE_SAMPLES = 8;
/** Cells per side of the grid reprojected exactly; pixels in between are interpolated. */
const WARP_GRID = 16;
/** Largest requested image, as a multiple of the tile size. */
const MAX_IMAGE_SCALE = 2;
const WEB_MERCATOR_CRS = new Set(["EPSG:3857", "EPSG:900913"]);

type Point = [number, number];

interface Projection {
  /** Longitude/latitude to easting/northing in the layer's CRS. */
  forward: (lonLat: Point) => Point;
  /** The EPSG axis order is north, east: WMS 1.3.0 writes the BBOX that way. */
  northFirst: boolean;
}

export interface ProjectedWmsRequest {
  /** The GetMap URL with BBOX, WIDTH and HEIGHT rewritten for the layer's CRS. */
  url: string;
  crs: string;
  /** The tile's Web Mercator extent, `[minX, minY, maxX, maxY]` in metres. */
  mercator: number[];
  /** The requested extent in the layer's CRS, `[minE, minN, maxE, maxN]`. */
  extent: number[];
  /** Size of the requested image, in pixels. */
  width: number;
  height: number;
  /** Size of the Web Mercator tile to draw, in pixels. */
  tileSize: number;
  forward: (lonLat: Point) => Point;
}

const projections = new Map<string, Promise<Projection | null>>();

/**
 * The projection for an `EPSG:n` CRS, resolved offline from the bundled EPSG
 * tables (epsg-proj4.ts), or null when the code is unknown. WMS identify uses it
 * too, so GetFeatureInfo goes out in the CRS the tiles are drawn in.
 */
export function resolveProjection(code: string): Promise<Projection | null> {
  let projection = projections.get(code);
  if (!projection) {
    projection = (async () => {
      const epsg = /^EPSG:(\d{4,6})$/.exec(code);
      if (!epsg) return null;
      const resolved = await resolveEpsgProjection(Number(epsg[1]));
      if (!resolved) return null;
      const converter = resolved.proj4("EPSG:4326", resolved.definition);
      return {
        forward: (lonLat: Point) => converter.forward(lonLat) as Point,
        northFirst: resolved.northFirst,
      };
    })();
    projections.set(code, projection);
  }
  return projection;
}

/**
 * Whether the desktop tile protocol can reproject tiles requested in `code`:
 * Web Mercator, the geographic CRSs of the strip path, or an EPSG code the
 * bundled EPSG tables resolve. Any other CRS would be requested with a Web
 * Mercator BBOX, which the server rejects or draws in the wrong place.
 */
export async function canReprojectWmsCrs(code: string): Promise<boolean> {
  const upper = code.trim().toUpperCase();
  if (WEB_MERCATOR_CRS.has(upper) || GEOGRAPHIC_WMS_CRS.has(upper)) return true;
  return (await resolveProjection(upper)) !== null;
}

/**
 * The codes among `codes` the desktop tile protocol can reproject. A code whose
 * check fails counts as unsupported, so one odd CRS in a long inherited list
 * never fails the whole probe.
 *
 * @param codes - The advertised CRS codes.
 * @param check - The per-code check; tests pass a stub.
 * @returns The supported codes, in their original order.
 */
export async function reprojectableWmsCodes(
  codes: string[],
  check: (code: string) => Promise<boolean> = canReprojectWmsCrs,
): Promise<string[]> {
  const supported = await Promise.all(codes.map((code) => check(code).catch(() => false)));
  return codes.filter((_, index) => supported[index]);
}

/**
 * `crs` when the desktop tile protocol can reproject it, else undefined, which
 * requests the tiles in Web Mercator: a saved service may carry a CRS the
 * bundled EPSG tables do not know.
 */
export async function reprojectableWmsCrs(crs: string | undefined): Promise<string | undefined> {
  return crs && (await canReprojectWmsCrs(crs)) ? crs : undefined;
}

function distance([x1, y1]: Point, [x2, y2]: Point): number {
  return Math.hypot(x2 - x1, y2 - y1);
}

/**
 * Rewrite a concrete GetMap tile URL whose SRS/CRS is an EPSG CRS other than
 * Web Mercator but whose BBOX MapLibre filled in Web Mercator metres. Returns
 * null for Web Mercator, the geographic CRSs of the strip path and CRSs that
 * cannot be resolved, which are then fetched as they are.
 */
export async function projectedWmsRequest(url: string): Promise<ProjectedWmsRequest | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const params = parsed.searchParams;
  const crs = queryParam(params, "crs") ?? queryParam(params, "srs");
  const code = crs?.[1].trim().toUpperCase() ?? "";
  if (!code || WEB_MERCATOR_CRS.has(code) || GEOGRAPHIC_WMS_CRS.has(code)) return null;
  const bbox = queryParam(params, "bbox");
  if (!bbox) return null;
  const mercator = bbox[1].split(",").map(Number);
  if (mercator.length !== 4 || !mercator.every(Number.isFinite)) return null;
  const [minX, minY, maxX, maxY] = mercator;
  if (!(maxX > minX && maxY > minY)) return null;
  const projection = await resolveProjection(code);
  if (!projection) return null;

  const project = (x: number, y: number): Point =>
    projection.forward([longitudeFromMercatorX(x), latitudeFromMercatorY(y)]);
  // A tile edge is a curve in the layer's CRS: sample it, then take the
  // envelope, so the requested image covers the whole tile.
  let [minE, minN, maxE, maxN] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let step = 0; step <= EDGE_SAMPLES; step += 1) {
    const t = step / EDGE_SAMPLES;
    const x = minX + t * (maxX - minX);
    const y = minY + t * (maxY - minY);
    for (const [easting, northing] of [
      project(x, minY),
      project(x, maxY),
      project(minX, y),
      project(maxX, y),
    ]) {
      minE = Math.min(minE, easting);
      maxE = Math.max(maxE, easting);
      minN = Math.min(minN, northing);
      maxN = Math.max(maxN, northing);
    }
  }
  if (![minE, minN, maxE, maxN].every(Number.isFinite) || !(maxE > minE && maxN > minN)) {
    return null;
  }

  // Keep about one image pixel per tile pixel: scale the tile size by how much
  // larger the envelope is than the tile's own edges in the layer's CRS.
  const tileSize = Number(queryParam(params, "width")?.[1]) || 256;
  const topLeft = project(minX, maxY);
  const size = (span: number, edge: number) =>
    Math.min(tileSize * MAX_IMAGE_SCALE, Math.max(1, Math.round((tileSize * span) / edge)));
  const topEdge = distance(topLeft, project(maxX, maxY));
  const leftEdge = distance(topLeft, project(minX, minY));
  // An edge that collapses to a point (a singularity of the projection) cannot
  // be warped: send the request as is, like a degenerate BBOX.
  if (!(topEdge > 0 && leftEdge > 0)) return null;
  const width = size(maxE - minE, topEdge);
  const height = size(maxN - minN, leftEdge);

  const version = queryParam(params, "version")?.[1].trim() ?? "";
  const northFirst = version.startsWith("1.3") && projection.northFirst;
  params.set(bbox[0], (northFirst ? [minN, minE, maxN, maxE] : [minE, minN, maxE, maxN]).join(","));
  params.set(queryParam(params, "width")?.[0] ?? "WIDTH", String(width));
  params.set(queryParam(params, "height")?.[0] ?? "HEIGHT", String(height));
  return {
    url: parsed.toString(),
    crs: code,
    mercator,
    extent: [minE, minN, maxE, maxN],
    width,
    height,
    tileSize,
    forward: projection.forward,
  };
}

/**
 * For each pixel of the Web Mercator tile, row by row, the source image pixel
 * `(u, v)` it reads. Reprojected exactly on a grid and interpolated in between:
 * at tile scale the mapping is smooth, and this avoids a proj4 call per pixel.
 */
export function sourcePixelMap(request: ProjectedWmsRequest, grid = WARP_GRID): Float32Array {
  const { tileSize, width, height } = request;
  const [minX, minY, maxX, maxY] = request.mercator;
  const [minE, minN, maxE, maxN] = request.extent;
  const nodes = new Float64Array((grid + 1) * (grid + 1) * 2);
  for (let row = 0; row <= grid; row += 1) {
    for (let column = 0; column <= grid; column += 1) {
      // Node positions are pixel centres, from the first to the last.
      const i = (column / grid) * (tileSize - 1);
      const j = (row / grid) * (tileSize - 1);
      const x = minX + ((i + 0.5) / tileSize) * (maxX - minX);
      const y = maxY - ((j + 0.5) / tileSize) * (maxY - minY);
      const [easting, northing] = request.forward([
        longitudeFromMercatorX(x),
        latitudeFromMercatorY(y),
      ]);
      const node = (row * (grid + 1) + column) * 2;
      nodes[node] = ((easting - minE) / (maxE - minE)) * width - 0.5;
      nodes[node + 1] = ((maxN - northing) / (maxN - minN)) * height - 0.5;
    }
  }
  const map = new Float32Array(tileSize * tileSize * 2);
  const cell = (tileSize - 1) / grid;
  for (let j = 0; j < tileSize; j += 1) {
    const row = Math.min(grid - 1, Math.floor(j / cell));
    const fy = j / cell - row;
    for (let i = 0; i < tileSize; i += 1) {
      const column = Math.min(grid - 1, Math.floor(i / cell));
      const fx = i / cell - column;
      const a = (row * (grid + 1) + column) * 2;
      const b = a + 2;
      const c = a + (grid + 1) * 2;
      const d = c + 2;
      const out = (j * tileSize + i) * 2;
      for (let axis = 0; axis < 2; axis += 1) {
        const top = nodes[a + axis] + (nodes[b + axis] - nodes[a + axis]) * fx;
        const bottom = nodes[c + axis] + (nodes[d + axis] - nodes[c + axis]) * fx;
        map[out + axis] = top + (bottom - top) * fy;
      }
    }
  }
  return map;
}

/**
 * Fill an RGBA tile of `tileSize` pixels from `source` (RGBA, `sourceWidth` x
 * `sourceHeight`) through `map`, nearest pixel. Pixels that fall outside the
 * source stay transparent.
 */
export function warpToMercator(
  source: Uint8ClampedArray,
  sourceWidth: number,
  sourceHeight: number,
  map: Float32Array,
  tileSize: number,
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(tileSize * tileSize * 4);
  for (let pixel = 0; pixel < tileSize * tileSize; pixel += 1) {
    const u = Math.round(map[pixel * 2]);
    const v = Math.round(map[pixel * 2 + 1]);
    if (u < 0 || v < 0 || u >= sourceWidth || v >= sourceHeight) continue;
    const from = (v * sourceWidth + u) * 4;
    out[pixel * 4] = source[from];
    out[pixel * 4 + 1] = source[from + 1];
    out[pixel * 4 + 2] = source[from + 2];
    out[pixel * 4 + 3] = source[from + 3];
  }
  return out;
}

/** Warp a WMS image in a projected CRS into a Web Mercator PNG tile. */
export async function projectedTileToMercator(
  bytes: ArrayBuffer,
  request: ProjectedWmsRequest,
): Promise<ArrayBuffer> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes]));
  } catch {
    throw new Error(describeWmsFailure(bytes));
  }
  try {
    const source = new OffscreenCanvas(bitmap.width, bitmap.height);
    const sourceContext = source.getContext("2d");
    if (!sourceContext) throw new Error("2D canvas is unavailable.");
    sourceContext.drawImage(bitmap, 0, 0);
    const pixels = sourceContext.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const { tileSize } = request;
    const warped = warpToMercator(
      pixels,
      bitmap.width,
      bitmap.height,
      // Map onto the image actually returned: a server that caps WIDTH/HEIGHT
      // still covers the requested extent, at a lower resolution.
      sourcePixelMap({ ...request, width: bitmap.width, height: bitmap.height }),
      tileSize,
    );
    const tile = new OffscreenCanvas(tileSize, tileSize);
    const tileContext = tile.getContext("2d");
    if (!tileContext) throw new Error("2D canvas is unavailable.");
    tileContext.putImageData(new ImageData(warped, tileSize, tileSize), 0, 0);
    const blob = await tile.convertToBlob({ type: "image/png" });
    return blob.arrayBuffer();
  } finally {
    bitmap.close();
  }
}
