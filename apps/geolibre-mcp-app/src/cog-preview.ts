import type { GeoLibreLayer } from "@geolibre/core";
import { BaseClient, BaseResponse, fromCustomClient } from "geotiff";
import type { NetworkConsent } from "./network-consent";

/** Longest side, in pixels, of the image a COG layer is previewed as. */
export const PREVIEW_COG_MAX_DIMENSION = 1024;
/** The most pixels the preview decodes from one image level before resampling. */
export const PREVIEW_COG_MAX_READ_PIXELS = 4096 * 4096;
/** The most bytes one COG layer may read through the preview's server tool. */
export const PREVIEW_COG_BYTE_BUDGET = 64 * 1024 * 1024;

const MAX_MERCATOR_LAT = 85.051129;
const EARTH_RADIUS = 6378137;

/** CRSs the preview places without a reprojection library. */
export type PreviewCogCrs = 4326 | 3857;

export interface CogPreviewStyle {
  mode: "rgb" | "single";
  /** 1-based band indices. */
  bands: number[];
  /** One `[min, max]` per rendered band, or null to stretch from the data. */
  rescale: Array<[number, number]> | null;
  colormap: string;
}

export interface CogPreviewImage {
  /** RGBA pixels, row-major, already resampled to Web Mercator rows. */
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  /** Top-left, top-right, bottom-right, bottom-left `[lng, lat]` corners. */
  corners: [[number, number], [number, number], [number, number], [number, number]];
  /** Colormap names the preview does not know and replaced with grayscale. */
  unknownColormap: string | null;
}

function remoteHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** The public URL a saved COG layer reads, or null when the preview cannot reach it. */
export function cogLayerUrl(layer: GeoLibreLayer): string | null {
  if (layer.type !== "cog") return null;
  const source = layer.source as Record<string, unknown> | undefined;
  return remoteHttpUrl(source?.url) ?? remoteHttpUrl(layer.sourcePath);
}

/** Whether the preview renders this layer as a decoded COG image. */
export function isPreviewCogLayer(layer: GeoLibreLayer): boolean {
  return cogLayerUrl(layer) !== null;
}

/**
 * The EPSG code a GeoTIFF's geo keys declare, folding the Web Mercator
 * aliases into 3857 and the WGS 84 look-alikes the preview cannot tell apart
 * at its resolution into 4326. Null when the keys name no code.
 */
export function cogEpsg(geoKeys: Record<string, unknown> | null | undefined): number | null {
  const projected = geoKeys?.ProjectedCSTypeGeoKey;
  if (typeof projected === "number" && projected !== 32767) {
    return [3857, 900913, 3785, 102100, 102113].includes(projected) ? 3857 : projected;
  }
  const geographic = geoKeys?.GeographicTypeGeoKey;
  if (typeof geographic === "number" && geographic !== 32767) {
    return [4326, 4269, 4258].includes(geographic) ? 4326 : geographic;
  }
  return null;
}

export function isPreviewCogCrs(code: number | null): code is PreviewCogCrs {
  return code === 4326 || code === 3857;
}

/**
 * The image level to decode: the smallest whose longest side still reaches
 * `target`, else the largest one there is.
 */
export function pickPreviewImage(
  sizes: ReadonlyArray<{ width: number; height: number }>,
  target = PREVIEW_COG_MAX_DIMENSION,
): number {
  let best = -1;
  let largest = 0;
  sizes.forEach((size, index) => {
    const side = Math.max(size.width, size.height);
    if (side > Math.max(sizes[largest].width, sizes[largest].height)) largest = index;
    if (side >= target && (best < 0 || side < Math.max(sizes[best].width, sizes[best].height))) {
      best = index;
    }
  });
  return best < 0 ? largest : best;
}

/** Fit `width`×`height` inside `max` on its longest side, keeping the aspect ratio. */
export function previewSize(
  width: number,
  height: number,
  max = PREVIEW_COG_MAX_DIMENSION,
): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function finitePair(value: unknown): [number, number] | null {
  return Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
    ? [Number(value[0]), Number(value[1])]
    : null;
}

/**
 * How a COG layer's saved `rasterState` asks for it to be drawn, falling back
 * to RGB for a three-band image and a grayscale stretch of band 1 otherwise.
 */
export function cogPreviewStyle(rasterState: unknown, samplesPerPixel: number): CogPreviewStyle {
  const state = (rasterState && typeof rasterState === "object" ? rasterState : {}) as Record<
    string,
    unknown
  >;
  const savedBands = Array.isArray(state.bands)
    ? state.bands.filter(
        (band): band is number =>
          Number.isInteger(band) && (band as number) >= 1 && (band as number) <= samplesPerPixel,
      )
    : [];
  const mode =
    state.mode === "rgb" || state.mode === "single"
      ? state.mode
      : savedBands.length >= 3 || (savedBands.length === 0 && samplesPerPixel >= 3)
        ? "rgb"
        : "single";
  const bands =
    mode === "rgb"
      ? savedBands.length >= 3
        ? savedBands.slice(0, 3)
        : samplesPerPixel >= 3
          ? [1, 2, 3]
          : [1, 1, 1]
      : [savedBands[0] ?? 1];
  const rescale = Array.isArray(state.rescale)
    ? state.rescale.map(finitePair).filter((pair): pair is [number, number] => pair !== null)
    : [];
  return {
    mode,
    bands,
    rescale: rescale.length ? bands.map((_band, index) => rescale[index] ?? rescale[0]) : null,
    colormap: typeof state.colormap === "string" && state.colormap ? state.colormap : "gray",
  };
}

/** The 2nd to 98th percentile of the finite, non-nodata values, from a bounded sample. */
export function stretchRange(values: ArrayLike<number>, nodata: number | null): [number, number] {
  const sample: number[] = [];
  const step = Math.max(1, Math.floor(values.length / 65536));
  for (let index = 0; index < values.length; index += step) {
    const value = values[index];
    if (Number.isFinite(value) && value !== nodata) sample.push(value);
  }
  if (sample.length === 0) return [0, 1];
  sample.sort((left, right) => left - right);
  const low = sample[Math.floor((sample.length - 1) * 0.02)];
  const high = sample[Math.ceil((sample.length - 1) * 0.98)];
  return low === high ? [low, low + 1] : [low, high];
}

// Colormap stops, evenly spaced from 0 to 1. Enough stops for a preview; the
// full-resolution tables live with the desktop raster renderer.
const COLORMAP_STOPS: Record<string, string[]> = {
  gray: ["#000000", "#ffffff"],
  viridis: [
    "#440154",
    "#482878",
    "#3e4989",
    "#31688e",
    "#26828e",
    "#1f9e89",
    "#35b779",
    "#6ece58",
    "#b5de2b",
    "#fde725",
  ],
  plasma: [
    "#0d0887",
    "#47039f",
    "#7301a8",
    "#9c179e",
    "#bd3786",
    "#d8576b",
    "#ed7953",
    "#fa9f3a",
    "#fdca26",
    "#f0f921",
  ],
  inferno: [
    "#000004",
    "#1b0c41",
    "#4a0c6b",
    "#781c6d",
    "#a52c60",
    "#cf4446",
    "#ed6925",
    "#fb9b06",
    "#f7d13d",
    "#fcffa4",
  ],
  magma: [
    "#000004",
    "#180f3d",
    "#440f76",
    "#721f81",
    "#9e2f7f",
    "#cd4071",
    "#f1605d",
    "#fd9668",
    "#feca8d",
    "#fcfdbf",
  ],
  cividis: [
    "#00224e",
    "#123570",
    "#3b496c",
    "#575d6d",
    "#707173",
    "#8a8678",
    "#a59c74",
    "#c3b369",
    "#e1cc55",
    "#fee838",
  ],
  turbo: [
    "#30123b",
    "#4662d7",
    "#36aaf9",
    "#1ae4b6",
    "#72fe5e",
    "#c8ef34",
    "#faba39",
    "#f66b19",
    "#ca2a04",
    "#7a0403",
  ],
  terrain: [
    "#333399",
    "#0294fa",
    "#00cc66",
    "#99e599",
    "#fefe98",
    "#ccbe7d",
    "#997c5c",
    "#99807b",
    "#ccc0bd",
    "#ffffff",
  ],
  rdylgn: [
    "#a50026",
    "#d73027",
    "#f46d43",
    "#fdae61",
    "#fee08b",
    "#d9ef8b",
    "#a6d96a",
    "#66bd63",
    "#1a9850",
    "#006837",
  ],
  spectral: [
    "#9e0142",
    "#d53e4f",
    "#f46d43",
    "#fdae61",
    "#fee08b",
    "#e6f598",
    "#abdda4",
    "#66c2a5",
    "#3288bd",
    "#5e4fa2",
  ],
  blues: [
    "#f7fbff",
    "#deebf7",
    "#c6dbef",
    "#9ecae1",
    "#6baed6",
    "#4292c6",
    "#2171b5",
    "#08519c",
    "#08306b",
  ],
  greens: [
    "#f7fcf5",
    "#e5f5e0",
    "#c7e9c0",
    "#a1d99b",
    "#74c476",
    "#41ab5d",
    "#238b45",
    "#006d2c",
    "#00441b",
  ],
  reds: [
    "#fff5f0",
    "#fee0d2",
    "#fcbba1",
    "#fc9272",
    "#fb6a4a",
    "#ef3b2c",
    "#cb181d",
    "#a50f15",
    "#67000d",
  ],
};
const COLORMAP_ALIASES: Record<string, string> = {
  grey: "gray",
  greys: "gray",
  grays: "gray",
};

/**
 * A 256-entry RGB lookup table for a colormap name (case-insensitive; a `_r`
 * suffix reverses it), or null when the preview does not know the name.
 */
export function colormapLut(name: string): Uint8Array | null {
  let key = name.trim().toLowerCase();
  const reversed = key.endsWith("_r");
  if (reversed) key = key.slice(0, -2);
  key = COLORMAP_ALIASES[key] ?? key;
  const stops = COLORMAP_STOPS[key];
  if (!stops) return null;
  const colors = stops.map((hex) =>
    [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16)),
  );
  if (reversed) colors.reverse();
  const lut = new Uint8Array(256 * 3);
  for (let index = 0; index < 256; index += 1) {
    const position = (index / 255) * (colors.length - 1);
    const lower = Math.floor(position);
    const upper = Math.min(colors.length - 1, lower + 1);
    const fraction = position - lower;
    for (let channel = 0; channel < 3; channel += 1) {
      lut[index * 3 + channel] = Math.round(
        colors[lower][channel] + (colors[upper][channel] - colors[lower][channel]) * fraction,
      );
    }
  }
  return lut;
}

function scaled(value: number, [min, max]: [number, number]): number {
  const unit = (value - min) / (max - min || 1);
  return Math.round(Math.min(1, Math.max(0, unit)) * 255);
}

/**
 * Paint decoded bands to RGBA: three bands as RGB, one band through a colormap.
 * Nodata and non-finite pixels are transparent.
 */
export function colorizeBands(
  bands: ReadonlyArray<ArrayLike<number>>,
  pixels: number,
  style: CogPreviewStyle,
  nodata: number | null,
): { rgba: Uint8ClampedArray; unknownColormap: string | null } {
  const rgba = new Uint8ClampedArray(pixels * 4);
  const ranges = bands.map((band, index) => style.rescale?.[index] ?? stretchRange(band, nodata));
  const isEmpty = (value: number) => !Number.isFinite(value) || value === nodata;
  if (style.mode === "rgb") {
    const [red, green, blue] = bands;
    for (let pixel = 0; pixel < pixels; pixel += 1) {
      const values = [red[pixel], green[pixel], blue[pixel]];
      if (values.every(isEmpty)) continue;
      const offset = pixel * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        rgba[offset + channel] = isEmpty(values[channel])
          ? 0
          : scaled(values[channel], ranges[channel]);
      }
      rgba[offset + 3] = 255;
    }
    return { rgba, unknownColormap: null };
  }
  const lut = colormapLut(style.colormap);
  const table = lut ?? colormapLut("gray")!;
  const [band] = bands;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const value = band[pixel];
    if (isEmpty(value)) continue;
    const index = scaled(value, ranges[0]) * 3;
    const offset = pixel * 4;
    rgba[offset] = table[index];
    rgba[offset + 1] = table[index + 1];
    rgba[offset + 2] = table[index + 2];
    rgba[offset + 3] = 255;
  }
  return { rgba, unknownColormap: lut ? null : style.colormap };
}

function mercatorY(lat: number): number {
  const clamped = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
  return Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360));
}

function latFromMercatorY(y: number): number {
  return (Math.atan(Math.sinh(y)) * 180) / Math.PI;
}

/**
 * Resample an equirectangular (EPSG:4326) image's rows so they are evenly
 * spaced in Web Mercator. MapLibre stretches an image source linearly between
 * its corners in Mercator space, so without this a tall WGS 84 raster drifts
 * north or south of its true position away from its edges.
 */
export function resampleToMercatorRows(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  north: number,
  south: number,
): Uint8ClampedArray {
  const top = Math.min(north, MAX_MERCATOR_LAT);
  const bottom = Math.max(south, -MAX_MERCATOR_LAT);
  const output = new Uint8ClampedArray(rgba.length);
  const yTop = mercatorY(top);
  const yBottom = mercatorY(bottom);
  const rowBytes = width * 4;
  for (let row = 0; row < height; row += 1) {
    const lat = latFromMercatorY(yTop + ((yBottom - yTop) * (row + 0.5)) / height);
    const source = Math.min(
      height - 1,
      Math.max(0, Math.floor(((north - lat) / (north - south)) * height)),
    );
    output.set(rgba.subarray(source * rowBytes, source * rowBytes + rowBytes), row * rowBytes);
  }
  return output;
}

/**
 * The `[lng, lat]` image-source corners (top-left, top-right, bottom-right,
 * bottom-left) of a bounding box in the COG's CRS.
 */
export function cogCorners(
  [minX, minY, maxX, maxY]: readonly [number, number, number, number] | readonly number[],
  crs: PreviewCogCrs,
): CogPreviewImage["corners"] {
  const toLngLat = (x: number, y: number): [number, number] =>
    crs === 3857
      ? [(x / EARTH_RADIUS) * (180 / Math.PI), latFromMercatorY(y / EARTH_RADIUS)]
      : [x, Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, y))];
  return [toLngLat(minX, maxY), toLngLat(maxX, maxY), toLngLat(maxX, minY), toLngLat(minX, minY)];
}

class PreviewRangeResponse extends BaseResponse {
  constructor(
    private readonly bytes: ArrayBuffer,
    private readonly start: number,
    private readonly total: number | undefined,
  ) {
    super();
  }

  get status(): number {
    return 206;
  }

  getHeader(name: string): string | undefined {
    if (name.toLowerCase() !== "content-range") return undefined;
    const end = this.start + Math.max(0, this.bytes.byteLength - 1);
    return `bytes ${this.start}-${end}/${this.total ?? "*"}`;
  }

  async getData(): Promise<ArrayBuffer> {
    return this.bytes;
  }
}

/** A geotiff.js client whose every range read goes through preview network consent. */
class PreviewRangeClient extends BaseClient {
  private spent = 0;
  /** The last read failure; geotiff.js drops it when it reports a failed block. */
  lastError: unknown = null;

  constructor(
    url: string,
    private readonly fetchRange: NetworkConsent["fetchRange"],
    private readonly budget: number,
  ) {
    super(url);
  }

  async request(options: RequestInit = {}): Promise<BaseResponse> {
    const headers = new Headers(options.headers);
    const match = headers.get("range")?.match(/^bytes=(\d+)-(\d+)$/);
    if (!match) throw new Error("The COG preview only reads byte ranges.");
    const offset = Number(match[1]);
    const length = Number(match[2]) - offset + 1;
    try {
      this.spent += length;
      if (this.spent > this.budget)
        throw new Error(
          `The COG preview stopped after reading ${Math.max(
            1,
            Math.round(this.budget / 1048576),
          )} MiB; open the project in GeoLibre to view it.`,
        );
      const range = await this.fetchRange(this.url, offset, length, options.signal ?? undefined);
      return new PreviewRangeResponse(range.data, offset, range.totalSize);
    } catch (error) {
      this.lastError = error;
      throw error;
    }
  }
}

/**
 * Decode a COG layer into a single preview image: pick an overview near
 * {@link PREVIEW_COG_MAX_DIMENSION}, read it through consent-gated range
 * requests, color it from the layer's saved raster state, and place it.
 *
 * @throws When the COG's CRS is neither EPSG:4326 nor EPSG:3857, when it has
 *   no level small enough to decode, or when a read fails.
 */
export async function loadCogPreview(
  layer: GeoLibreLayer,
  fetchRange: NetworkConsent["fetchRange"],
  signal?: AbortSignal,
  budget = PREVIEW_COG_BYTE_BUDGET,
): Promise<CogPreviewImage> {
  const url = cogLayerUrl(layer);
  if (!url) throw new Error("The COG layer has no public URL.");
  const client = new PreviewRangeClient(url, fetchRange, budget);
  try {
    return await decodeCogPreview(layer, client, signal);
  } catch (error) {
    // geotiff.js reports any failed block read as `AggregateError: Request
    // failed` without the cause; the read's own error says why (consent
    // declined, budget spent, server refused the range).
    if (error instanceof Error && error.name === "AggregateError" && client.lastError) {
      throw client.lastError;
    }
    throw error;
  }
}

async function decodeCogPreview(
  layer: GeoLibreLayer,
  client: PreviewRangeClient,
  signal: AbortSignal | undefined,
): Promise<CogPreviewImage> {
  const tiff = await fromCustomClient(
    client,
    // The server caps one response at 4 MiB, and several small blocks merged
    // into one range keep the number of tool calls down.
    { blockSize: 256 * 1024 } as never,
    signal,
  );
  const count = await tiff.getImageCount();
  const images = await Promise.all(
    Array.from({ length: count }, (_value, index) => tiff.getImage(index)),
  );
  const primary = images[0];
  const crs = cogEpsg(primary.getGeoKeys() as Record<string, unknown> | null);
  if (!isPreviewCogCrs(crs)) {
    throw new Error(
      crs === null
        ? "The COG declares no coordinate reference system, so the preview cannot place it."
        : `The COG uses EPSG:${crs}; this preview places only EPSG:4326 and EPSG:3857 rasters.`,
    );
  }
  const level =
    images[
      pickPreviewImage(
        images.map((image) => ({
          width: image.getWidth(),
          height: image.getHeight(),
        })),
      )
    ];
  if (level.getWidth() * level.getHeight() > PREVIEW_COG_MAX_READ_PIXELS) {
    throw new Error(
      "The COG has no overview small enough to preview; add overviews or open it in GeoLibre.",
    );
  }
  const style = cogPreviewStyle(layer.metadata?.rasterState, primary.getSamplesPerPixel());
  const size = previewSize(level.getWidth(), level.getHeight());
  const samples = [...new Set(style.bands)].map((band) => band - 1);
  const rasters = (await level.readRasters({
    samples,
    width: size.width,
    height: size.height,
    resampleMethod: "nearest",
    interleave: false,
    signal,
  })) as unknown as ArrayLike<number>[];
  const bands = style.bands.map((band) => rasters[samples.indexOf(band - 1)]);
  const nodataValue = primary.getGDALNoData();
  const { rgba, unknownColormap } = colorizeBands(
    bands,
    size.width * size.height,
    style,
    typeof nodataValue === "number" && Number.isFinite(nodataValue) ? nodataValue : null,
  );
  const bbox = primary.getBoundingBox();
  return {
    rgba:
      crs === 4326 ? resampleToMercatorRows(rgba, size.width, size.height, bbox[3], bbox[1]) : rgba,
    width: size.width,
    height: size.height,
    corners: cogCorners(bbox, crs),
    unknownColormap,
  };
}
