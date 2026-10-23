/**
 * AlphaEarth Foundations (Google Satellite Embedding V1, annual) access.
 *
 * Taylor Geospatial Engine mirrors the Earth Engine dataset on Source
 * Cooperative as one Cloud-Optimized GeoTIFF per 8192 × 8192 px (81.92 km)
 * UTM block and year: 64 signed 8-bit bands (`A00`–`A63`), NoData -128,
 * band-separate, ZSTD-compressed, 1024 px internal tiles, full overviews.
 *
 * Two quirks shape this module:
 *
 * - The COGs are **bottom-up**: the geotransform's Y resolution is positive
 *   and row 0 is the southern edge. GeoLibre's COG renderers assume north-up
 *   and fail on them, so the plugin reads windows itself with geotiff.js and
 *   flips rows.
 * - File names do not say where a file is, so a search goes through the
 *   published STAC GeoParquet index (~5 MB, read with column projection).
 *
 * Values de-quantize as `sign(v) · (v / 127.5)²`, giving unit-length 64-D
 * vectors with components in [-1, 1].
 */

import {
  asyncBufferFromUrl,
  cachedAsyncBuffer,
  parquetReadObjects,
  type AsyncBuffer,
} from "hyparquet";
import { compressors } from "hyparquet-compressors";
import proj4 from "proj4";
import {
  type LonLatBbox,
  bboxesIntersect,
  parseUtmEpsg,
  utmProjection,
} from "./satellite-embeddings-grids";

export const AEF_BASE_URL = "https://data.source.coop/tge-labs/aef/v1/annual";
export const AEF_INDEX_URL = `${AEF_BASE_URL}/aef_index_stac_geoparquet.parquet`;
export const AEF_BAND_COUNT = 64;
export const AEF_NODATA = -128;
/** Earth Engine's example visualization: bands A01, A16, A09. */
export const AEF_DEFAULT_RGB_BANDS: [number, number, number] = [1, 16, 9];
/** Earth Engine's example stretch: de-quantized values in [-0.3, 0.3]. */
export const AEF_DEFAULT_STRETCH = 0.3;
/** Most tile-years one search lists. */
export const AEF_MAX_RESULTS = 200;

const S3_PREFIX = "s3://us-west-2.opendata.source.coop/";
const HTTPS_PREFIX = "https://data.source.coop/";

/** One COG of the dataset: a UTM block in one year. */
export interface AefTile {
  /** Stable id: `<year>/<zone>/<file stem>`. */
  id: string;
  /** HTTPS URL of the COG. */
  url: string;
  year: number;
  /** UTM zone label, e.g. `17N`. */
  utmZone: string;
  /** EPSG code of the tile's UTM zone. */
  epsg: number;
  /** Lon/lat bounding box of the tile's footprint. */
  bbox: LonLatBbox;
}

/** Band name for a 0-based band index, e.g. `A07`. */
export function aefBandName(index: number): string {
  return `A${String(index).padStart(2, "0")}`;
}

/** Converts an index `s3://` href to its public HTTPS URL. */
export function aefHttpsUrl(href: string): string {
  return href.startsWith(S3_PREFIX) ? HTTPS_PREFIX + href.slice(S3_PREFIX.length) : href;
}

/** The companion VRT that flips a bottom-up COG for GDAL. */
export function aefVrtUrl(tiffUrl: string): string {
  return tiffUrl.replace(/\.tiff?$/i, ".vrt");
}

/**
 * Builds a tile record from an index href, or null when the href does not
 * follow the `.../annual/<year>/<zone>/<stem>.tiff` layout.
 */
export function aefTileFromHref(
  href: string,
  epsgCode: string | number,
  bbox: LonLatBbox,
): AefTile | null {
  const url = aefHttpsUrl(href);
  const match = /\/annual\/(\d{4})\/(\d{1,2}[NS])\/([^/]+)\.tiff?$/i.exec(url);
  const utm = parseUtmEpsg(epsgCode);
  if (!match || !utm) return null;
  return {
    id: `${match[1]}/${match[2]}/${match[3]}`,
    url,
    year: Number(match[1]),
    utmZone: match[2].toUpperCase(),
    epsg: (utm.south ? 32700 : 32600) + utm.zone,
    bbox,
  };
}

/**
 * Groups sorted row indices into `[start, end)` ranges, merging indices less
 * than `maxGap` apart so nearby rows are decoded in one read.
 */
export function groupRowRanges(rows: number[], maxGap = 2048): [number, number][] {
  const ranges: [number, number][] = [];
  for (const row of rows) {
    const last = ranges[ranges.length - 1];
    if (last && row - last[1] < maxGap) last[1] = row + 1;
    else ranges.push([row, row + 1]);
  }
  return ranges;
}

// ---------------------------------------------------------------------------
// Index search
// ---------------------------------------------------------------------------

interface AefIndexColumns {
  west: Float64Array;
  south: Float64Array;
  east: Float64Array;
  north: Float64Array;
  year: Uint16Array;
}

let indexFile: Promise<AsyncBuffer> | null = null;
let indexColumns: Promise<AefIndexColumns> | null = null;

/** The index as a range-read buffer that caches the bytes it fetched. */
function getIndexFile(): Promise<AsyncBuffer> {
  indexFile ??= asyncBufferFromUrl({ url: AEF_INDEX_URL })
    .then((file) => cachedAsyncBuffer(file))
    .catch((error: unknown) => {
      indexFile = null;
      throw error;
    });
  return indexFile;
}

/**
 * The index's bbox and year columns as typed arrays, read once per session
 * (about 1.5 MB of the 5 MB file) and kept for every later search.
 */
function getIndexColumns(): Promise<AefIndexColumns> {
  indexColumns ??= (async () => {
    const file = await getIndexFile();
    const rows = await parquetReadObjects({ file, columns: ["bbox", "datetime"], compressors });
    const columns: AefIndexColumns = {
      west: new Float64Array(rows.length),
      south: new Float64Array(rows.length),
      east: new Float64Array(rows.length),
      north: new Float64Array(rows.length),
      year: new Uint16Array(rows.length),
    };
    rows.forEach((row, index) => {
      const bbox = row.bbox as { xmin: number; ymin: number; xmax: number; ymax: number };
      columns.west[index] = bbox.xmin;
      columns.south[index] = bbox.ymin;
      columns.east[index] = bbox.xmax;
      columns.north[index] = bbox.ymax;
      // Each item's datetime is 1 January of its year, in UTC.
      const date = row.datetime instanceof Date ? row.datetime : new Date(String(row.datetime));
      columns.year[index] = date.getUTCFullYear();
    });
    return columns;
  })().catch((error: unknown) => {
    indexColumns = null;
    throw error;
  });
  return indexColumns;
}

/** Result of {@link searchAefTiles}. */
export interface AefSearchResult {
  tiles: AefTile[];
  /** Tile-years that matched, which can exceed `tiles.length`. */
  total: number;
}

/**
 * Lists the tiles overlapping a box in the given years, newest year first.
 * At most {@link AEF_MAX_RESULTS} are returned.
 */
export async function searchAefTiles(bbox: LonLatBbox, years: number[]): Promise<AefSearchResult> {
  const columns = await getIndexColumns();
  const wanted = new Set(years);
  const hits: number[] = [];
  for (let row = 0; row < columns.year.length; row += 1) {
    if (wanted.size > 0 && !wanted.has(columns.year[row])) continue;
    const rowBbox: LonLatBbox = [
      columns.west[row],
      columns.south[row],
      columns.east[row],
      columns.north[row],
    ];
    if (bboxesIntersect(rowBbox, bbox)) hits.push(row);
  }
  const total = hits.length;
  // Newest first, keeping the index's spatial order within a year.
  hits.sort((a, b) => columns.year[b] - columns.year[a] || a - b);
  const selected = hits.slice(0, AEF_MAX_RESULTS).sort((a, b) => a - b);
  const file = await getIndexFile();
  const tiles: AefTile[] = [];
  for (const [rowStart, rowEnd] of groupRowRanges(selected)) {
    const rows = await parquetReadObjects({
      file,
      columns: ["assets", "proj:epsg"],
      rowStart,
      rowEnd,
      compressors,
    });
    for (const row of selected) {
      if (row < rowStart || row >= rowEnd) continue;
      const record = rows[row - rowStart] as {
        assets?: { data?: { href?: string } };
        "proj:epsg"?: string;
      };
      const href = record.assets?.data?.href;
      if (!href || !record["proj:epsg"]) continue;
      const tile = aefTileFromHref(href, record["proj:epsg"], [
        columns.west[row],
        columns.south[row],
        columns.east[row],
        columns.north[row],
      ]);
      if (tile) tiles.push(tile);
    }
  }
  tiles.sort(
    (a, b) => b.year - a.year || a.utmZone.localeCompare(b.utmZone) || a.id.localeCompare(b.id),
  );
  return { tiles, total };
}

// ---------------------------------------------------------------------------
// Window planning
// ---------------------------------------------------------------------------

/** Full-resolution georeferencing of a COG: `x = originX + col·resX`, likewise y. */
export interface AefGeoref {
  originX: number;
  originY: number;
  resX: number;
  /** Positive for a bottom-up raster (row 0 at the south edge). */
  resY: number;
  width: number;
  height: number;
}

/** A pixel window chosen by {@link planAefWindow}. */
export interface AefWindowPlan {
  /** Index into the image pyramid (0 = full resolution). */
  level: number;
  /** `[col0, row0, col1, row1)` in that level's pixels. */
  window: [number, number, number, number];
  width: number;
  height: number;
  /** UTM bounds the window covers: `[minX, minY, maxX, maxY]`. */
  bounds: [number, number, number, number];
  /** Whether stored rows run south to north. */
  bottomUp: boolean;
}

/**
 * Chooses the pyramid level and pixel window covering a UTM box. Picks the
 * finest level whose window fits within `maxDimension` pixels on each side
 * (pass `levels: [georef.width]` to force full resolution). Returns null when
 * the box misses the raster.
 */
export function planAefWindow(
  georef: AefGeoref,
  [minX, minY, maxX, maxY]: [number, number, number, number],
  levelWidths: number[],
  maxDimension = Infinity,
): AefWindowPlan | null {
  let fallback: AefWindowPlan | null = null;
  for (let level = 0; level < levelWidths.length; level += 1) {
    const factor = georef.width / levelWidths[level];
    const levelWidth = levelWidths[level];
    const levelHeight = Math.max(1, Math.round(georef.height / factor));
    const resX = georef.resX * factor;
    const resY = georef.resY * factor;
    const colA = (minX - georef.originX) / resX;
    const colB = (maxX - georef.originX) / resX;
    const rowA = (minY - georef.originY) / resY;
    const rowB = (maxY - georef.originY) / resY;
    const col0 = Math.max(0, Math.floor(Math.min(colA, colB)));
    const col1 = Math.min(levelWidth, Math.ceil(Math.max(colA, colB)));
    const row0 = Math.max(0, Math.floor(Math.min(rowA, rowB)));
    const row1 = Math.min(levelHeight, Math.ceil(Math.max(rowA, rowB)));
    if (col1 <= col0 || row1 <= row0) return null;
    const xs = [georef.originX + col0 * resX, georef.originX + col1 * resX];
    const ys = [georef.originY + row0 * resY, georef.originY + row1 * resY];
    const plan: AefWindowPlan = {
      level,
      window: [col0, row0, col1, row1],
      width: col1 - col0,
      height: row1 - row0,
      bounds: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      bottomUp: georef.resY > 0,
    };
    if (plan.width <= maxDimension && plan.height <= maxDimension) return plan;
    fallback = plan;
  }
  return fallback;
}

/**
 * Projects a lon/lat box into a UTM zone, sampling its edges so the result
 * contains the whole box (a lon/lat rectangle is curved in UTM).
 */
export function lonLatBboxToUtm(
  [west, south, east, north]: LonLatBbox,
  epsg: number,
): [number, number, number, number] {
  const utm = parseUtmEpsg(epsg);
  if (!utm) throw new Error(`Not a UTM EPSG code: ${epsg}`);
  const toUtm = proj4("EPSG:4326", utmProjection(utm.zone, utm.south));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const steps = 8;
  for (let i = 0; i <= steps; i += 1) {
    for (let j = 0; j <= steps; j += 1) {
      if (i !== 0 && i !== steps && j !== 0 && j !== steps) continue; // edges only
      const lon = west + ((east - west) * i) / steps;
      const lat = south + ((north - south) * j) / steps;
      const [x, y] = toUtm.forward([lon, lat]);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return [minX, minY, maxX, maxY];
}

/**
 * The lon/lat corners of a UTM box in MapLibre image-source order: top-left,
 * top-right, bottom-right, bottom-left.
 */
export function utmBoundsToCorners(
  [minX, minY, maxX, maxY]: [number, number, number, number],
  epsg: number,
): [[number, number], [number, number], [number, number], [number, number]] {
  const utm = parseUtmEpsg(epsg);
  if (!utm) throw new Error(`Not a UTM EPSG code: ${epsg}`);
  const toLonLat = proj4(utmProjection(utm.zone, utm.south), "EPSG:4326");
  const corner = (x: number, y: number): [number, number] => {
    const [lon, lat] = toLonLat.forward([x, y]);
    return [lon, lat];
  };
  return [corner(minX, maxY), corner(maxX, maxY), corner(maxX, minY), corner(minX, minY)];
}

// ---------------------------------------------------------------------------
// Pixel values
// ---------------------------------------------------------------------------

/** De-quantizes one raw value to [-1, 1]; NoData becomes NaN. */
export function dequantizeAef(value: number): number {
  if (value === AEF_NODATA) return Number.NaN;
  const scaled = value / 127.5;
  return Math.sign(value) * scaled * scaled;
}

/**
 * Renders three raw bands as RGBA, mapping de-quantized values in
 * `[-stretch, stretch]` to 0–255. NoData pixels are transparent. When
 * `bottomUp` is set the rows are flipped so the output's first row is north.
 */
export function renderAefRgba(
  bands: [Int8Array, Int8Array, Int8Array],
  width: number,
  height: number,
  bottomUp: boolean,
  stretch = AEF_DEFAULT_STRETCH,
): Uint8ClampedArray {
  // A 256-entry lookup from raw int8 to display byte, shared by all bands.
  const lut = new Uint8ClampedArray(256);
  for (let raw = -128; raw <= 127; raw += 1) {
    const value = dequantizeAef(raw);
    lut[raw + 128] = Number.isNaN(value) ? 0 : ((value + stretch) / (2 * stretch)) * 255;
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  const [red, green, blue] = bands;
  for (let row = 0; row < height; row += 1) {
    const sourceRow = bottomUp ? height - 1 - row : row;
    for (let col = 0; col < width; col += 1) {
      const source = sourceRow * width + col;
      const target = (row * width + col) * 4;
      const r = red[source];
      if (r === AEF_NODATA) continue; // NoData is set in every band at once
      rgba[target] = lut[r + 128];
      rgba[target + 1] = lut[green[source] + 128];
      rgba[target + 2] = lut[blue[source] + 128];
      rgba[target + 3] = 255;
    }
  }
  return rgba;
}

/** Flips a band's rows in place so the first row is the northern edge. */
export function flipRows<T extends Int8Array | Float32Array>(
  band: T,
  width: number,
  height: number,
): T {
  const scratch = band.slice(0, width) as T;
  for (let top = 0, bottom = height - 1; top < bottom; top += 1, bottom -= 1) {
    const topStart = top * width;
    const bottomStart = bottom * width;
    scratch.set(band.subarray(topStart, topStart + width));
    band.copyWithin(topStart, bottomStart, bottomStart + width);
    band.set(scratch, bottomStart);
  }
  return band;
}

/** De-quantizes a raw band to float32, with NoData as NaN. */
export function dequantizeBand(band: Int8Array): Float32Array {
  const lut = new Float32Array(256);
  for (let raw = -128; raw <= 127; raw += 1) lut[raw + 128] = dequantizeAef(raw);
  const out = new Float32Array(band.length);
  for (let index = 0; index < band.length; index += 1) out[index] = lut[band[index] + 128];
  return out;
}

// ---------------------------------------------------------------------------
// Reading windows
// ---------------------------------------------------------------------------

/** An opened COG: its georeferencing and pyramid. */
export interface AefTileReader {
  georef: AefGeoref;
  /** Width of each pyramid level, full resolution first. */
  levelWidths: number[];
  /** Reads `bands` (0-based) of a planned window as raw int8 arrays. */
  readBands: (plan: AefWindowPlan, bands: number[], signal?: AbortSignal) => Promise<Int8Array[]>;
}

/**
 * Derives the full-resolution georeferencing from GeoTIFF tags. Reads the
 * affine ModelTransformation directly, because geotiff.js's `getResolution`
 * reports north-up signs and would hide a bottom-up raster.
 */
export function georefFromTags(
  width: number,
  height: number,
  transformation: ArrayLike<number> | undefined,
  tiepoint: ArrayLike<number> | undefined,
  pixelScale: ArrayLike<number> | undefined,
): AefGeoref {
  if (transformation && transformation.length >= 8) {
    if (transformation[1] !== 0 || transformation[4] !== 0) {
      throw new Error("Rotated rasters are not supported");
    }
    return {
      originX: transformation[3],
      originY: transformation[7],
      resX: transformation[0],
      resY: transformation[5],
      width,
      height,
    };
  }
  if (tiepoint && tiepoint.length >= 6 && pixelScale && pixelScale.length >= 2) {
    return {
      originX: tiepoint[3] - tiepoint[0] * pixelScale[0],
      originY: tiepoint[4] + tiepoint[1] * pixelScale[1],
      resX: pixelScale[0],
      resY: -pixelScale[1],
      width,
      height,
    };
  }
  throw new Error("The GeoTIFF has no affine georeferencing");
}

/** Opens an AlphaEarth COG for windowed reads. */
export async function openAefTile(url: string, signal?: AbortSignal): Promise<AefTileReader> {
  const { fromUrl } = await import("geotiff");
  const tiff = await fromUrl(url, {}, signal);
  const count = await tiff.getImageCount();
  const images = await Promise.all(
    Array.from({ length: count }, (_, index) => tiff.getImage(index)),
  );
  const base = images[0];
  const directory = base.fileDirectory;
  const georef = georefFromTags(
    base.getWidth(),
    base.getHeight(),
    directory.getValue("ModelTransformation") as ArrayLike<number> | undefined,
    directory.getValue("ModelTiepoint") as ArrayLike<number> | undefined,
    directory.getValue("ModelPixelScale") as ArrayLike<number> | undefined,
  );
  // geotiff.js otherwise fetches each tile's offset and byte count with its
  // own tiny range request (two extra round trips per tile, ~0.5 s each in a
  // browser). Loading a level's whole tables once (a few KB) removes them.
  const tileTables = new Map<number, Promise<unknown>>();
  const loadTileTables = (level: number): Promise<unknown> => {
    let tables = tileTables.get(level);
    if (!tables) {
      const directory = images[level].fileDirectory;
      tables = Promise.all([
        directory.loadValue("TileOffsets"),
        directory.loadValue("TileByteCounts"),
      ]).catch((error: unknown) => {
        tileTables.delete(level);
        throw error;
      });
      tileTables.set(level, tables);
    }
    return tables;
  };
  return {
    georef,
    levelWidths: images.map((image) => image.getWidth()),
    readBands: async (plan, bands, readSignal) => {
      await loadTileTables(plan.level);
      const rasters = await images[plan.level].readRasters({
        window: plan.window,
        samples: bands,
        interleave: false,
        signal: readSignal,
      });
      return Array.from(rasters as unknown as ArrayLike<Int8Array>);
    },
  };
}
