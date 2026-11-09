/**
 * Band combinations and spectral indices of a STAC item, drawn as ordinary raster tiles.
 *
 * Most catalogs publish each band as its own Cloud-Optimized GeoTIFF, so a false-color composite
 * or an NDVI cannot be a single COG layer. This reads each band's window for a map tile straight
 * from its file (picking the overview that matches the tile's ground resolution), warps it from
 * the file's own CRS to Web Mercator, and paints the result in the browser. It is served through
 * a MapLibre protocol, so a rendering is a plain XYZ store layer: it shows in the Layers panel,
 * saves with the project (the tile URL carries the recipe), and restores on reload once the
 * protocol is registered at startup.
 *
 * It is the general form of `sentinel2-composite.ts`: any item, any projection the COG declares
 * (UTM, state plane, geographic), per-band scale/offset, and a formula for an index. The pixel
 * math is pure and covered by `tests/stac-render.test.ts`.
 */
import { withGeoKeysDatumShift } from "@geolibre/core";
import { fromUrl, type GeoTIFF, type GeoTIFFImage } from "geotiff";
import { addProtocol, type RequestParameters } from "maplibre-gl";
import proj4 from "proj4";
import { compileFormula, formulaNames, isValidFormula } from "./stac-bands";
import { readableStacAssetHref, type StacAssetAccess } from "./stac-signing";

/** The URL scheme of rendering tiles. */
export const STAC_RENDER_PROTOCOL = "stacrender";
const TILE_SIZE = 256;
const HALF_WORLD = 20_037_508.342789244;
/** Projected sample points per tile edge; pixels between them interpolate. */
const GRID = 17;
/** Largest band window read for one tile, in pixels per side. */
const MAX_WINDOW = 2048;
/** Most bands one rendering reads: a formula past this is not an index anyone typed. */
const MAX_BANDS = 8;

/**
 * One band of one file, with the scale and offset that turn its values into reflectance.
 *
 * `href` is the address the catalog gave, never a signed one: a signed address carries a
 * credential, which would be saved into the project and shared with it, and it expires. Where the
 * catalog needs one, `access` says how to ask for a fresh signature each time the file is read.
 */
export interface RenderBand {
  href: string;
  /** 1-based band number inside the file. */
  index: number;
  scale: number;
  offset: number;
  /** The value that marks no data in this band, when the catalog declares one. */
  nodata?: number;
  /** How to sign `href` when the catalog keeps it private (Planetary Computer). */
  access?: StacAssetAccess;
}

/** Three-stop ramps an index can be drawn with: low, middle and high colour. */
export const RENDER_RAMPS = {
  /** Brown (bare) -> pale -> green (vegetation). */
  BrBG: ["#8c510a", "#f5f5f5", "#01665e"],
  RdYlGn: ["#d73027", "#ffffbf", "#1a9850"],
  RdBu: ["#b2182b", "#f7f7f7", "#2166ac"],
  Spectral: ["#2b83ba", "#ffffbf", "#d7191c"],
  Greys: ["#000000", "#808080", "#ffffff"],
} as const satisfies Record<string, readonly [string, string, string]>;

export type RenderRamp = keyof typeof RENDER_RAMPS;

/** The ramp an index uses until the user picks another. */
export const DEFAULT_RENDER_RAMP: RenderRamp = "BrBG";

/**
 * How a rendering is drawn, beyond which bands it reads. Every field is optional and leaves the
 * default alone when absent, so an unstyled recipe draws exactly as it always has.
 */
export interface RenderStyle {
  /** Colour channels: brightness, as a multiple of the default stretch (above 1 is brighter). */
  gain?: number;
  /** Colour channels: mid-tone curve (above 1 lifts the shadows). */
  gamma?: number;
  /** Index: the ramp it is drawn on. */
  ramp?: RenderRamp;
  /** Index: the value drawn as the low end of the ramp (default -1). */
  min?: number;
  /** Index: the value drawn as the high end of the ramp (default 1). */
  max?: number;
}

/**
 * What to draw: three bands as red, green and blue, or a formula over several bands. `bands` of
 * an index follow the order of {@link formulaNames}.
 */
export type StacRenderSpec =
  | { kind: "rgb"; bands: [RenderBand, RenderBand, RenderBand]; style?: RenderStyle }
  | { kind: "index"; formula: string; bands: RenderBand[]; style?: RenderStyle };

/**
 * The tile URL template of a rendering.
 *
 * @param spec - What to draw.
 * @returns A `stacrender://` template with `{z}/{x}/{y}` placeholders.
 */
export function renderTileUrl(spec: StacRenderSpec): string {
  return `${STAC_RENDER_PROTOCOL}://tile/{z}/{x}/{y}?s=${encodeURIComponent(JSON.stringify(spec))}`;
}

function isHttps(href: unknown): href is string {
  if (typeof href !== "string") return false;
  try {
    return new URL(href).protocol === "https:";
  } catch {
    return false;
  }
}

function parseAccess(value: unknown, href: string): StacAssetAccess | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) return null;
  const { catalogUrl, collectionId, href: accessHref } = value as Record<string, unknown>;
  if (!isHttps(catalogUrl) || typeof collectionId !== "string" || !collectionId) return null;
  // The signature is asked for the file this band reads, and no other.
  if (accessHref !== href) return null;
  return { catalogUrl, collectionId, href };
}

function parseBand(value: unknown): RenderBand | null {
  if (typeof value !== "object" || value === null) return null;
  const band = value as Record<string, unknown>;
  const { href, index, scale, offset, nodata } = band;
  if (!isHttps(href)) return null;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 1 || index > 1000) {
    return null;
  }
  if (typeof scale !== "number" || !Number.isFinite(scale) || scale === 0) return null;
  if (typeof offset !== "number" || !Number.isFinite(offset)) return null;
  if (nodata !== undefined && (typeof nodata !== "number" || !Number.isFinite(nodata))) return null;
  const access = parseAccess(band.access, href);
  if (access === null) return null;
  return {
    href,
    index,
    scale,
    offset,
    ...(nodata !== undefined ? { nodata } : {}),
    ...(access ? { access } : {}),
  };
}

function finiteIn(value: unknown, low: number, high: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= low && value <= high;
}

function parseStyle(value: unknown): RenderStyle | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { gain, gamma, ramp, min, max } = value as Record<string, unknown>;
  const style: RenderStyle = {};
  if (gain !== undefined) {
    if (!finiteIn(gain, 0.05, 20)) return null;
    style.gain = gain;
  }
  if (gamma !== undefined) {
    if (!finiteIn(gamma, 0.05, 20)) return null;
    style.gamma = gamma;
  }
  if (ramp !== undefined) {
    if (typeof ramp !== "string" || !Object.hasOwn(RENDER_RAMPS, ramp)) return null;
    style.ramp = ramp as RenderRamp;
  }
  if (min !== undefined) {
    if (!finiteIn(min, -1e6, 1e6)) return null;
    style.min = min;
  }
  if (max !== undefined) {
    if (!finiteIn(max, -1e6, 1e6)) return null;
    style.max = max;
  }
  // The window is judged as it will be drawn, with the default end standing in for one not given:
  // a minimum of 2 with the default maximum of 1 is no window at all.
  if (!((style.min ?? -1) < (style.max ?? 1))) return null;
  return style;
}

/** The parts of a rendering tile request. */
export interface RenderTileRequest {
  z: number;
  x: number;
  y: number;
  spec: StacRenderSpec;
}

/**
 * Parses a rendering tile URL. The recipe is checked before anything is fetched: every file must
 * be an https URL, and a formula must compile and match the bands it reads.
 *
 * @param url - A requested tile URL.
 * @returns The request, or null when the URL is not a valid rendering tile.
 */
export function parseRenderTileUrl(url: string): RenderTileRequest | null {
  const match = url.match(/^stacrender:\/\/tile\/(\d+)\/(\d+)\/(\d+)\?(.*)$/);
  if (!match) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(new URLSearchParams(match[4]).get("s") ?? "");
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const spec = raw as { kind?: unknown; formula?: unknown; bands?: unknown };
  if (!Array.isArray(spec.bands) || spec.bands.length > MAX_BANDS) return null;
  const bands = spec.bands.map(parseBand);
  if (bands.some((band) => band === null)) return null;
  const valid = bands as RenderBand[];
  const at = { z: Number(match[1]), x: Number(match[2]), y: Number(match[3]) };
  let style: RenderStyle | undefined;
  if ((raw as { style?: unknown }).style !== undefined) {
    const parsed = parseStyle((raw as { style?: unknown }).style);
    if (!parsed) return null;
    style = parsed;
  }
  if (spec.kind === "rgb") {
    if (valid.length !== 3) return null;
    return {
      ...at,
      spec: {
        kind: "rgb",
        bands: valid as [RenderBand, RenderBand, RenderBand],
        ...(style ? { style } : {}),
      },
    };
  }
  if (spec.kind === "index") {
    const formula = spec.formula;
    if (typeof formula !== "string" || formula.length > 500 || !isValidFormula(formula)) {
      return null;
    }
    if (formulaNames(formula).length !== valid.length) return null;
    return { ...at, spec: { kind: "index", formula, bands: valid, ...(style ? { style } : {}) } };
  }
  return null;
}

/**
 * The recipe a rendering layer's tile URL template carries, or null when the URL is not one of
 * ours. Lets the Style panel read a saved layer without keeping a second copy of the recipe.
 */
export function specFromTileUrl(template: string): StacRenderSpec | null {
  const url = template.replace("{z}", "0").replace("{x}", "0").replace("{y}", "0");
  return parseRenderTileUrl(url)?.spec ?? null;
}

/**
 * The recipe with a style applied. Fields equal to their default are left out, so a reset style
 * gives back the original URL.
 */
export function withRenderStyle(spec: StacRenderSpec, style: RenderStyle): StacRenderSpec {
  const kept: RenderStyle = {};
  if (style.gain !== undefined && style.gain !== 1) kept.gain = style.gain;
  if (style.gamma !== undefined && style.gamma !== 1) kept.gamma = style.gamma;
  if (style.ramp !== undefined && style.ramp !== DEFAULT_RENDER_RAMP) kept.ramp = style.ramp;
  if (style.min !== undefined && style.min !== -1) kept.min = style.min;
  if (style.max !== undefined && style.max !== 1) kept.max = style.max;
  const { style: _old, ...rest } = spec;
  return Object.keys(kept).length
    ? ({ ...rest, style: kept } as StacRenderSpec)
    : (rest as StacRenderSpec);
}

const hexRgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/** How a band's values map to 0..255 when it is a colour channel. */
export interface Stretch {
  low: number;
  high: number;
}

/**
 * The stretch for a band shown as a colour channel. A band with a scale or offset is reflectance
 * (about 0 to 0.3 over land); without them the sample type says: 8-bit is already display range,
 * and 16-bit is taken as reflectance times 10,000, which is how Sentinel-2 and most others store it.
 */
export function stretchFor(band: RenderBand, bitsPerSample: number): Stretch {
  if (band.scale !== 1 || band.offset !== 0) return { low: 0, high: 0.3 };
  return bitsPerSample <= 8 ? { low: 0, high: 255 } : { low: 0, high: 3000 };
}

/**
 * Paints a rendering's pixels into RGBA. A pixel where any band is NaN (nodata, or outside the
 * file) is transparent. Colour channels are stretched linearly; an index is computed on the
 * scaled values and drawn on its ramp over -1..1, with a result that is not a number transparent.
 *
 * @param spec - The rendering.
 * @param samples - One array per band in `spec.bands`, already scaled, `count` values each.
 * @param stretches - One stretch per colour channel (used for `rgb`).
 * @param out - RGBA output, `4 * count` bytes.
 */
export function paintRender(
  spec: StacRenderSpec,
  samples: ReadonlyArray<ArrayLike<number>>,
  stretches: readonly Stretch[],
  out: Uint8ClampedArray,
): void {
  const count = out.length / 4;
  const style = spec.style ?? {};
  if (spec.kind === "rgb") {
    // More gain narrows the window, so the same values land brighter.
    const gain = style.gain ?? 1;
    const gamma = style.gamma ?? 1;
    const scales = stretches.map((s) => 255 / ((s.high - s.low) / gain));
    for (let i = 0; i < count; i++) {
      const r = samples[0][i];
      const g = samples[1][i];
      const b = samples[2][i];
      const o = i * 4;
      if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
        out[o + 3] = 0;
        continue;
      }
      if (gamma === 1) {
        out[o] = (r - stretches[0].low) * scales[0];
        out[o + 1] = (g - stretches[1].low) * scales[1];
        out[o + 2] = (b - stretches[2].low) * scales[2];
      } else {
        const curve = (value: number, channel: number): number =>
          255 *
          Math.max(0, Math.min(1, ((value - stretches[channel].low) * scales[channel]) / 255)) **
            (1 / gamma);
        out[o] = curve(r, 0);
        out[o + 1] = curve(g, 1);
        out[o + 2] = curve(b, 2);
      }
      out[o + 3] = 255;
    }
    return;
  }
  const evaluate = compileFormula(spec.formula);
  const [lo, mid, hi] = RENDER_RAMPS[style.ramp ?? DEFAULT_RENDER_RAMP].map(hexRgb);
  // The window the ramp spans: its middle is the pale stop, and its ends are the two colours.
  const low = style.min ?? -1;
  const high = style.max ?? 1;
  const centre = (low + high) / 2;
  const half = (high - low) / 2;
  const values = new Array<number>(samples.length);
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    let missing = false;
    for (let b = 0; b < samples.length; b++) {
      values[b] = samples[b][i];
      if (Number.isNaN(values[b])) missing = true;
    }
    // A formula such as a ^ 0 turns a missing value into 1, so the check comes before it.
    if (missing) {
      out[o + 3] = 0;
      continue;
    }
    const raw = evaluate(values);
    if (!Number.isFinite(raw)) {
      out[o + 3] = 0;
      continue;
    }
    const v = Math.max(-1, Math.min(1, (raw - centre) / half));
    const t = v < 0 ? v + 1 : v;
    const [c0, c1] = v < 0 ? [lo, mid] : [mid, hi];
    out[o] = c0[0] + (c1[0] - c0[0]) * t;
    out[o + 1] = c0[1] + (c1[1] - c0[1]) * t;
    out[o + 2] = c0[2] + (c1[2] - c0[2]) * t;
    out[o + 3] = 255;
  }
}

// ---------------------------------------------------------------------------
// Band readers
// ---------------------------------------------------------------------------

interface BandDataset {
  tiff: GeoTIFF;
  /** Full resolution first, then overviews, coarser and coarser. */
  images: GeoTIFFImage[];
  /** Pixel width of each image, in the file's CRS units. */
  resX: number[];
  /** Pixel height of each image, in the file's CRS units (the two differ in some files). */
  resY: number[];
  originX: number;
  originY: number;
  /** proj4 definition of the file's CRS. */
  crs: string;
  /** The no-data value the file's own tag declares, when it does. */
  nodata: number | null;
  bitsPerSample: number;
}

/** Open band files, by URL. */
const bandCache = new Map<string, Promise<BandDataset>>();
const BAND_CACHE_MAX = 48;

/** The proj4 definition of a file's CRS from its geokeys, or null when it cannot be resolved. */
async function projectionOf(geoKeys: Record<string, unknown> | undefined): Promise<string | null> {
  if (!geoKeys) return null;
  try {
    const { toProj4 } = await import("geotiff-geokeys-to-proj4");
    const resolved = toProj4(geoKeys as never);
    if (!resolved?.proj4) return null;
    // The `+axis=` directive makes proj4 swap easting/northing on some CRSs, which would
    // transpose the pixel lookup. The datum shift matches the one the raster layers apply.
    return withGeoKeysDatumShift(resolved.proj4.replace(/\+axis=\w+\s*/g, ""), geoKeys);
  } catch {
    return null;
  }
}

/**
 * Whether an IFD holds imagery. A transparency mask (and an overview of one) is a page of its own
 * in a COG, flagged in NewSubfileType, with the same width as the image it masks; read as a band
 * it would paint 0/255 bytes.
 */
function isImagery(image: GeoTIFFImage): boolean {
  // geotiff.js hands tags out through getValue, not as properties of the directory.
  const flags = Number(image.getFileDirectory().getValue("NewSubfileType") ?? 0);
  return (flags & 4) === 0;
}

function openBand(url: string): Promise<BandDataset> {
  let cached = bandCache.get(url);
  if (!cached) {
    cached = (async () => {
      const tiff = await fromUrl(url);
      const count = await tiff.getImageCount();
      const pages: GeoTIFFImage[] = [];
      for (let i = 0; i < Math.min(count, 16); i++) pages.push(await tiff.getImage(i));
      const images = pages.filter(isImagery);
      const full = images[0];
      if (!full) throw new Error("This file has no image to read.");
      const [resX, resY] = full.getResolution();
      const [originX, originY] = full.getOrigin();
      const crs = await projectionOf(full.getGeoKeys() ?? undefined);
      if (!crs) throw new Error("This file's projection could not be read.");
      return {
        tiff,
        images,
        resX: images.map((image) => (Math.abs(resX) * full.getWidth()) / image.getWidth()),
        resY: images.map((image) => (Math.abs(resY) * full.getHeight()) / image.getHeight()),
        originX,
        originY,
        crs,
        nodata: full.getGDALNoData(),
        bitsPerSample: full.getBitsPerSample(0),
      };
    })();
    bandCache.set(url, cached);
    cached.catch(() => bandCache.delete(url));
    if (bandCache.size > BAND_CACHE_MAX) {
      const oldest = bandCache.keys().next().value;
      if (oldest !== undefined) bandCache.delete(oldest);
    }
  }
  return cached;
}

/**
 * Picks the coarsest image still at least as fine as the tile needs.
 *
 * @param resolutions - Image resolutions, finest first.
 * @param groundRes - The tile's ground resolution, in the same units.
 * @returns The index of the image to read.
 */
export function pickOverview(resolutions: readonly number[], groundRes: number): number {
  let pick = 0;
  for (let i = 0; i < resolutions.length; i++) {
    if (resolutions[i] <= groundRes) pick = i;
  }
  return pick;
}

interface Coordinates {
  e: Float64Array;
  n: Float64Array;
}

/** Coordinates in `crs` of every output pixel, bilinear between grid points. */
function tileCoordinates(z: number, x: number, y: number, crs: string): Coordinates {
  const span = (2 * HALF_WORLD) / 2 ** z;
  const west = -HALF_WORLD + x * span;
  const north = HALF_WORLD - y * span;
  const transform = proj4("EPSG:3857", crs);
  const ge = new Float64Array(GRID * GRID);
  const gn = new Float64Array(GRID * GRID);
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const [e, n] = transform.forward([
        west + (span * i) / (GRID - 1),
        north - (span * j) / (GRID - 1),
      ]);
      ge[j * GRID + i] = e;
      gn[j * GRID + i] = n;
    }
  }
  const e = new Float64Array(TILE_SIZE * TILE_SIZE);
  const n = new Float64Array(TILE_SIZE * TILE_SIZE);
  const step = TILE_SIZE / (GRID - 1);
  for (let py = 0; py < TILE_SIZE; py++) {
    const fy = (py + 0.5) / step;
    const j0 = Math.min(GRID - 2, Math.floor(fy));
    const ty = fy - j0;
    for (let px = 0; px < TILE_SIZE; px++) {
      const fx = (px + 0.5) / step;
      const i0 = Math.min(GRID - 2, Math.floor(fx));
      const tx = fx - i0;
      const a = j0 * GRID + i0;
      const k = py * TILE_SIZE + px;
      e[k] =
        (ge[a] * (1 - tx) + ge[a + 1] * tx) * (1 - ty) +
        (ge[a + GRID] * (1 - tx) + ge[a + GRID + 1] * tx) * ty;
      n[k] =
        (gn[a] * (1 - tx) + gn[a + 1] * tx) * (1 - ty) +
        (gn[a + GRID] * (1 - tx) + gn[a + GRID + 1] * tx) * ty;
    }
  }
  return { e, n };
}

/**
 * One band resampled to the tile's pixels (nearest neighbour), scaled, with NaN where the file
 * has no data. Null when the tile misses the file's footprint.
 */
async function sampleBand(
  dataset: BandDataset,
  band: RenderBand,
  coords: Coordinates,
): Promise<Float32Array | null> {
  let minE = Infinity;
  let maxE = -Infinity;
  let minN = Infinity;
  let maxN = -Infinity;
  for (let k = 0; k < coords.e.length; k++) {
    if (coords.e[k] < minE) minE = coords.e[k];
    if (coords.e[k] > maxE) maxE = coords.e[k];
    if (coords.n[k] < minN) minN = coords.n[k];
    if (coords.n[k] > maxN) maxN = coords.n[k];
  }
  // Fine enough along both axes: the two pixel sizes can differ.
  const level = Math.min(
    pickOverview(dataset.resX, (maxE - minE) / TILE_SIZE),
    pickOverview(dataset.resY, (maxN - minN) / TILE_SIZE),
  );
  const image = dataset.images[level];
  const rx = dataset.resX[level];
  const ry = dataset.resY[level];
  const width = image.getWidth();
  const height = image.getHeight();
  const x0 = Math.max(0, Math.floor((minE - dataset.originX) / rx));
  const x1 = Math.min(width, Math.ceil((maxE - dataset.originX) / rx) + 1);
  const y0 = Math.max(0, Math.floor((dataset.originY - maxN) / ry));
  const y1 = Math.min(height, Math.ceil((dataset.originY - minN) / ry) + 1);
  if (x1 <= x0 || y1 <= y0) return null;
  const w = x1 - x0;
  const h = y1 - y0;
  // A file with no overview coarse enough would need a window larger than is sensible to read for
  // one tile; it is read thinned to fit instead of being left blank.
  const thin = Math.min(1, MAX_WINDOW / Math.max(w, h));
  const readW = Math.max(1, Math.round(w * thin));
  const readH = Math.max(1, Math.round(h * thin));
  // No abort signal: geotiff.js shares a block fetch between concurrent readers, so cancelling one
  // tile's read can truncate a block another tile is decoding ("buffer error"). A cancelled
  // tile's read just completes and is discarded, and its blocks stay cached for the neighbours.
  const rasters = await image.readRasters({
    window: [x0, y0, x1, y1],
    samples: [band.index - 1],
    ...(thin < 1 ? { width: readW, height: readH, resampleMethod: "nearest" } : {}),
  });
  const data = (rasters as unknown as ArrayLike<number>[])[0];
  // The band's own declaration first; the file's tag when the catalog says nothing.
  const nodata = band.nodata ?? dataset.nodata;
  const out = new Float32Array(coords.e.length);
  for (let k = 0; k < out.length; k++) {
    const colAt = (coords.e[k] - dataset.originX) / rx - x0;
    const rowAt = (dataset.originY - coords.n[k]) / ry - y0;
    if (colAt < 0 || colAt >= w || rowAt < 0 || rowAt >= h) {
      out[k] = NaN;
      continue;
    }
    const col = Math.min(readW - 1, Math.floor((colAt * readW) / w));
    const row = Math.min(readH - 1, Math.floor((rowAt * readH) / h));
    const raw = data[row * readW + col];
    out[k] = raw === nodata ? NaN : raw * band.scale + band.offset;
  }
  return out;
}

/** The address a band is read from now: signed afresh when the catalog keeps it private. */
function readableBandHref(band: RenderBand, signal?: AbortSignal): Promise<string> {
  return band.access
    ? readableStacAssetHref(band.access, band.href, signal)
    : Promise.resolve(band.href);
}

async function renderWith(
  request: RenderTileRequest,
  urls: readonly string[],
  signal?: AbortSignal,
): Promise<Uint8ClampedArray | null> {
  const { spec } = request;
  const datasets = await Promise.all(urls.map(openBand));
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  // Bands of one item usually share a CRS; each distinct one is computed once per tile.
  const byCrs = new Map<string, Coordinates>();
  const coordinatesFor = (crs: string): Coordinates => {
    let found = byCrs.get(crs);
    if (!found) {
      found = tileCoordinates(request.z, request.x, request.y, crs);
      byCrs.set(crs, found);
    }
    return found;
  };
  const samples = await Promise.all(
    spec.bands.map((band, i) => sampleBand(datasets[i], band, coordinatesFor(datasets[i].crs))),
  );
  if (samples.some((band) => band === null)) return null;
  const rgba = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4);
  const stretches = spec.bands.map((band, i) => stretchFor(band, datasets[i].bitsPerSample));
  paintRender(spec, samples as Float32Array[], stretches, rgba);
  return rgba;
}

/**
 * Renders one tile as RGBA, or null when the tile misses the item.
 *
 * @param request - The parsed tile request.
 * @param signal - Aborts the band reads.
 * @returns `256 * 256 * 4` RGBA bytes, or null.
 */
export async function renderStacTile(
  request: RenderTileRequest,
  signal?: AbortSignal,
): Promise<Uint8ClampedArray | null> {
  const urls = await Promise.all(request.spec.bands.map((band) => readableBandHref(band, signal)));
  try {
    return await renderWith(request, urls, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    // A failed read or decode may have left a bad block in the reader's cache; reopen the bands
    // and try once more.
    for (const url of urls) bandCache.delete(url);
    return renderWith(request, urls, signal);
  }
}

async function rgbaToPng(rgba: Uint8ClampedArray): Promise<ArrayBuffer> {
  const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create a canvas for a STAC rendering tile.");
  context.putImageData(new ImageData(new Uint8ClampedArray(rgba), TILE_SIZE, TILE_SIZE), 0, 0);
  return (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer();
}

let emptyTile: Promise<ArrayBuffer> | null = null;
let registered = false;

/**
 * Registers the `stacrender://` tile protocol with MapLibre. Idempotent. The host calls it at
 * startup so a saved project's renderings restore even before the STAC panel is opened.
 */
export function registerStacRenderProtocol(): void {
  if (registered) return;
  addProtocol(
    STAC_RENDER_PROTOCOL,
    async (params: RequestParameters, controller: AbortController) => {
      const request = parseRenderTileUrl(params.url);
      if (!request) throw new Error(`Invalid STAC rendering tile: ${params.url}`);
      const rgba = await renderStacTile(request, controller.signal);
      if (!rgba) {
        // A failed encode must not poison every later empty tile.
        emptyTile ??= rgbaToPng(new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4)).catch(
          (error: unknown) => {
            emptyTile = null;
            throw error;
          },
        );
        return { data: await emptyTile };
      }
      return { data: await rgbaToPng(rgba) };
    },
  );
  // Only once it took, so a failed registration is retried on the next call.
  registered = true;
}
