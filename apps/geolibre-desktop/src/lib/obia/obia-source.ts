import type { GeoLibreLayer } from "@geolibre/core";
import {
  OBIA_MAX_PIXELS,
  ObiaError,
  planImageRead,
  readImageLevels,
  readImageWindow,
  type ObiaImage,
  type ObiaImageLevel,
  type ObiaPixelWindow,
  type ObiaReadArea,
} from "@geolibre/processing";
import { fromArrayBuffer, fromUrl, type GeoTIFF } from "geotiff";
import { fetchableUrl } from "../url-utils";
import { fetchLayerBytes } from "../whitebox-layer-inputs";

/** What the workbench knows about a source image from its header alone. */
export interface ObiaSourceInfo {
  /** Full resolution first, then the overviews. */
  levels: ObiaImageLevel[];
  bandCount: number;
  /** Sample type, e.g. "UInt16". */
  dataType: string;
  /** Full-resolution pixel size in CRS units. */
  pixelSize: number;
  /** CRS linear unit for the pixel size ("m", "degree", ...), when known. */
  unit: string | null;
  /**
   * Project a WGS84 point to full-resolution pixel coordinates (fractional),
   * or null when the image's CRS cannot be resolved.
   */
  toPixel: ((lng: number, lat: number) => [number, number]) | null;
}

// The last image opened, so listing bands, segmenting and measuring the same
// layer open it once. One entry: the workbench works on one image at a time.
// `ranges`: opened by HTTP range requests rather than from downloaded bytes.
let cached: { key: string; tiff: Promise<GeoTIFF | null>; ranges: boolean } | null = null;
// Bumped by clearObiaSourceCache, so an open that was in flight when the
// cache was cleared does not store its result afterwards.
let generation = 0;

/**
 * Identity of a layer's data: its id plus wherever its bytes come from, so a
 * layer whose source is replaced (re-added file, new URL) is read afresh.
 */
export function obiaSourceKey(layer: GeoLibreLayer): string {
  const src = layer.source as Record<string, unknown>;
  return [layer.id, layer.metadata.localBytesUrl, src.url, layer.sourcePath].join("|");
}

/**
 * Release the cached image so its data is not pinned while the workbench is
 * closed; the next read opens the layer afresh.
 */
export function clearObiaSourceCache(): void {
  cached = null;
  generation += 1;
}

/**
 * An http(s) URL to read the layer from by byte ranges, so a large remote COG
 * is never downloaded in full. A layer loaded from a local file has none (its
 * bytes are already in memory, behind a blob URL).
 */
function remoteUrl(layer: GeoLibreLayer): string | null {
  if (layer.metadata.localBytesUrl) return null;
  const src = layer.source as Record<string, unknown>;
  const tiles = Array.isArray(src.tiles) ? src.tiles : [];
  for (const candidate of [src.url, tiles[0], layer.sourcePath]) {
    const url = fetchableUrl(candidate);
    if (url && /^https?:/i.test(url)) return url;
  }
  return null;
}

/** Open a layer's image, saying whether it is read by range requests. */
async function openTiff(
  layer: GeoLibreLayer,
  ranges = true,
): Promise<{ tiff: GeoTIFF; ranges: boolean } | null> {
  const url = ranges ? remoteUrl(layer) : null;
  if (url) {
    try {
      const tiff = await fromUrl(url);
      // Read the header now, so a server that ignores range requests or
      // serves something else falls back to a plain download below.
      await tiff.getImage();
      return { tiff, ranges: true };
    } catch (error) {
      // A server without range requests (or one blocking them) is still read,
      // by downloading the whole file; say so, since that is the slow path.
      // The layer name, not the URL or the error (which can carry it): a signed
      // URL's query string is a credential.
      console.warn(
        `Object-Based Analysis: "${layer.name}" could not be read by range requests (${
          error instanceof Error ? error.name : "error"
        }); downloading it whole.`,
      );
    }
  }
  const bytes = await fetchLayerBytes(layer);
  if (!bytes) return null;
  // The bytes' own buffer when it is a whole ArrayBuffer, else a copy.
  const whole =
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength;
  const tiff = await fromArrayBuffer(whole ? (bytes.buffer as ArrayBuffer) : bytes.slice().buffer);
  return { tiff, ranges: false };
}

/**
 * The layer's image as an opened GeoTIFF, cached for the last layer opened.
 *
 * @param layer A raster/COG layer.
 * @returns The GeoTIFF, or null when the layer's data is not readable in the
 *   browser.
 */
export async function obiaSourceTiff(layer: GeoLibreLayer, ranges = true): Promise<GeoTIFF | null> {
  const key = obiaSourceKey(layer);
  if (cached?.key === key && (ranges || !cached.ranges)) return cached.tiff;
  const started = generation;
  const opening = openTiff(layer, ranges).catch((error: unknown) => {
    console.warn(
      `Object-Based Analysis: could not open "${layer.name}" (${
        error instanceof Error ? error.name : "error"
      }).`,
    );
    return null;
  });
  // Range reads are recorded once known: an open by range can fall back to
  // a whole download, which a later read must not repeat.
  const entry = { key, tiff: opening.then((opened) => opened?.tiff ?? null), ranges: false };
  if (started === generation) cached = entry;
  const opened = await opening;
  if (cached === entry) {
    if (opened) entry.ranges = opened.ranges;
    // Do not keep a failure: the next read retries.
    else cached = null;
  }
  return opened?.tiff ?? null;
}

let geokeysParser: Promise<((keys: Record<string, unknown>) => string | null) | null> | null = null;

/**
 * A proj4 definition for a GeoTIFF's geokeys, through the same
 * `geotiff-geokeys-to-proj4` the COG layer renders with, or null.
 */
async function projectionFor(geoKeys: Record<string, unknown> | undefined): Promise<string | null> {
  if (!geoKeys || !Object.keys(geoKeys).length) return null;
  geokeysParser ??= import("geotiff-geokeys-to-proj4")
    .then((mod) => (keys: Record<string, unknown>) => {
      try {
        const projection = mod.toProj4(keys as never);
        // `+axis=` makes proj4 swap easting and northing on some CRSs, which
        // would transpose the pixel window.
        return projection?.proj4 ? projection.proj4.replace(/\+axis=\w+\s*/g, "") : null;
      } catch {
        return null;
      }
    })
    .catch(() => {
      geokeysParser = null;
      return null;
    });
  const parse = await geokeysParser;
  return parse ? parse(geoKeys) : null;
}

/**
 * Header facts of the source image: its resolution levels, bands and pixel
 * size, and how to place a map position on its pixel grid.
 *
 * @param layer A raster/COG layer.
 * @returns The facts, or null when the layer's data is not readable.
 */
export async function obiaSourceInfo(layer: GeoLibreLayer): Promise<ObiaSourceInfo | null> {
  const tiff = await obiaSourceTiff(layer);
  if (!tiff) return null;
  const { levels, bandCount, dataType } = await readImageLevels(tiff);
  const image = await tiff.getImage(0);
  const [originX, originY] = image.getOrigin();
  const [resX, resY] = image.getResolution();
  // A rotated or sheared grid (a ModelTransformation with off-diagonal terms)
  // has no axis-aligned windows: offer only the whole image for it.
  const matrix = image.fileDirectory.getValue("ModelTransformation") as
    | ArrayLike<number>
    | undefined;
  const rotated = Boolean(matrix && (matrix[1] !== 0 || matrix[4] !== 0));
  const definition = rotated
    ? null
    : await projectionFor(image.getGeoKeys() as Record<string, unknown>);
  let toPixel: ObiaSourceInfo["toPixel"] = null;
  let unit: string | null = null;
  if (definition) {
    const { default: proj4 } = await import("proj4");
    const project = proj4("EPSG:4326", definition);
    toPixel = (lng, lat) => {
      const [x, y] = project.forward([lng, lat]) as [number, number];
      return [(x - originX) / resX, (y - originY) / resY];
    };
    unit = /\+proj=longlat/.test(definition)
      ? "degree"
      : (/\+units=(\S+)/.exec(definition)?.[1] ?? "m");
  }
  return { levels, bandCount, dataType, pixelSize: Math.abs(resX), unit, toPixel };
}

/** The whole image as a full-resolution pixel window. */
export function wholeImageWindow(info: ObiaSourceInfo): ObiaPixelWindow {
  return [0, 0, info.levels[0].width, info.levels[0].height];
}

/**
 * The full-resolution pixel window covering a WGS84 bounding box (such as the
 * map view), clamped to the image.
 *
 * @param info The source image's header facts.
 * @param bounds `[west, south, east, north]` in degrees.
 * @returns The window, or null when the box misses the image or its CRS is
 *   unknown.
 */
export function boundsWindow(
  info: ObiaSourceInfo,
  bounds: readonly [number, number, number, number],
): ObiaPixelWindow | null {
  if (!info.toPixel) return null;
  const [west, south, east, north] = bounds;
  // MapLibre's bounds keep west < east (unwrapping past 180); anything else
  // is not a box to sample.
  if (!(east > west) || !(north > south)) return null;
  // Sample the box's edges, not only its corners: a projected grid bends
  // the box, and its extremes can fall between the corners.
  const xs: number[] = [];
  const ys: number[] = [];
  const steps = 8;
  for (let i = 0; i <= steps; i += 1) {
    const f = i / steps;
    for (const [lng, lat] of [
      [west + (east - west) * f, south],
      [west + (east - west) * f, north],
      [west, south + (north - south) * f],
      [east, south + (north - south) * f],
    ] as const) {
      const [x, y] = info.toPixel(lng, lat);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        xs.push(x);
        ys.push(y);
      }
    }
  }
  if (!xs.length) return null;
  const { width, height } = info.levels[0];
  const window: ObiaPixelWindow = [
    Math.max(0, Math.floor(Math.min(...xs))),
    Math.max(0, Math.floor(Math.min(...ys))),
    Math.min(width, Math.ceil(Math.max(...xs))),
    Math.min(height, Math.ceil(Math.max(...ys))),
  ];
  return window[2] > window[0] && window[3] > window[1] ? window : null;
}

/** The area a read would cover, and its size at the chosen level. */
export interface ObiaAreaPlan {
  area: ObiaReadArea;
  width: number;
  height: number;
  /** Pixel size at the chosen level, in CRS units (square pixels assumed). */
  pixelSize: number;
  /** False when even the coarsest level is over the workbench's pixel limit. */
  fits: boolean;
}

/**
 * The area to read for a window: the finest resolution level at which it fits
 * the workbench's pixel limit, or the coarsest level when none does (reading
 * it then fails with the limit's error).
 *
 * @param info The source image's header facts.
 * @param window The full-resolution pixel window.
 * @param maxPixels Pixel limit: the browser engine's by default, or the
 *   sidecar's for a native run.
 */
export function planObiaArea(
  info: ObiaSourceInfo,
  window: ObiaPixelWindow,
  maxPixels = OBIA_MAX_PIXELS,
): ObiaAreaPlan {
  const full = info.levels[0];
  const sizeAt = (level: number) => info.pixelSize * (full.width / info.levels[level].width);
  const plan = planImageRead(info.levels, window, maxPixels);
  if (plan) {
    return {
      area: { level: plan.level, window },
      width: plan.width,
      height: plan.height,
      pixelSize: sizeAt(plan.level),
      fits: true,
    };
  }
  const level = info.levels.length - 1;
  const coarse = info.levels[level];
  return {
    area: { level, window },
    width: Math.ceil(((window[2] - window[0]) * coarse.width) / full.width),
    height: Math.ceil(((window[3] - window[1]) * coarse.height) / full.height),
    pixelSize: sizeAt(level),
    fits: false,
  };
}

/**
 * Whether a read failed on the bytes rather than on getting them: pako throws
 * plain strings ("buffer error"), and truncated tiles overrun a DataView.
 */
function isDecodeFailure(error: unknown): boolean {
  if (typeof error === "string") return true;
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError" || error instanceof TypeError) return false;
  return error instanceof RangeError || /decod|inflat|buffer|header|compress/i.test(error.message);
}

/**
 * The source layer's bands over an area, as single-band GeoTIFFs in the
 * given order. Only that area, at that level, is read.
 *
 * @param layer A raster/COG layer.
 * @param bandIndexes 1-based source bands.
 * @param area The window and level to read; the whole image at full
 *   resolution when omitted.
 */
export async function obiaSourceBands(
  layer: GeoLibreLayer,
  bandIndexes: readonly number[],
  area?: ObiaReadArea,
): Promise<ObiaImage | null> {
  const read = async (tiff: GeoTIFF) => {
    const target: ObiaReadArea =
      area ??
      (await readImageLevels(tiff).then(({ levels }) => ({
        level: 0,
        window: [0, 0, levels[0].width, levels[0].height] as ObiaPixelWindow,
      })));
    return readImageWindow(tiff, bandIndexes, target);
  };
  const tiff = await obiaSourceTiff(layer);
  if (!tiff) return null;
  try {
    return await read(tiff);
  } catch (error) {
    // Some servers, or a browser cache in front of them, return range
    // responses whose bytes do not decode: read such a source whole instead.
    // Not for other failures (network, HTTP status, cancel), where a whole
    // download would fail the same way, only slower.
    if (error instanceof ObiaError || !cached?.ranges || !isDecodeFailure(error)) throw error;
    console.warn(
      `Object-Based Analysis: range reads of "${layer.name}" did not decode; downloading it whole.`,
    );
    const whole = await obiaSourceTiff(layer, false);
    if (!whole) return null;
    return read(whole);
  }
}
