import type { GeoLibreLayer } from "@geolibre/core";
import {
  OBIA_MAX_PIXELS,
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
let cached: { key: string; tiff: Promise<GeoTIFF | null> } | null = null;
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

async function openTiff(layer: GeoLibreLayer): Promise<GeoTIFF | null> {
  const url = remoteUrl(layer);
  if (url) {
    try {
      const tiff = await fromUrl(url);
      // Read the header now, so a server that ignores range requests or
      // serves something else falls back to a plain download below.
      await tiff.getImage();
      return tiff;
    } catch {
      // fall through to fetching the whole file
    }
  }
  const bytes = await fetchLayerBytes(layer);
  if (!bytes) return null;
  return fromArrayBuffer(
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? (bytes.buffer as ArrayBuffer)
      : (bytes.slice().buffer as ArrayBuffer),
  );
}

/**
 * The layer's image as an opened GeoTIFF, cached for the last layer opened.
 *
 * @param layer A raster/COG layer.
 * @returns The GeoTIFF, or null when the layer's data is not readable in the
 *   browser.
 */
export async function obiaSourceTiff(layer: GeoLibreLayer): Promise<GeoTIFF | null> {
  const key = obiaSourceKey(layer);
  if (cached?.key === key) return cached.tiff;
  const started = generation;
  const tiff = openTiff(layer).catch(() => null);
  if (started === generation) cached = { key, tiff };
  const result = await tiff;
  // Do not keep a failure: the next read retries.
  if (!result && cached?.tiff === tiff) cached = null;
  return result;
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
  const definition = await projectionFor(image.getGeoKeys() as Record<string, unknown>);
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
  const plan = planImageRead(info.levels, window, maxPixels);
  if (plan)
    return {
      area: { level: plan.level, window },
      width: plan.width,
      height: plan.height,
      fits: true,
    };
  const level = info.levels.length - 1;
  const full = info.levels[0];
  const coarse = info.levels[level];
  return {
    area: { level, window },
    width: Math.ceil(((window[2] - window[0]) * coarse.width) / full.width),
    height: Math.ceil(((window[3] - window[1]) * coarse.height) / full.height),
    fits: false,
  };
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
  const tiff = await obiaSourceTiff(layer);
  if (!tiff) return null;
  if (area) return readImageWindow(tiff, bandIndexes, area);
  const { levels } = await readImageLevels(tiff);
  return readImageWindow(tiff, bandIndexes, {
    level: 0,
    window: [0, 0, levels[0].width, levels[0].height],
  });
}
