/**
 * Multi-file Sentinel-2 composites (false color IR, agriculture, SWIR) and
 * band indices (NDVI, NDWI), drawn as ordinary raster tiles.
 *
 * A Sentinel-2 L2A scene stores each band as its own Cloud-Optimized GeoTIFF,
 * at 10, 20 or 60 m on the scene's UTM grid, so a composite cannot be a single
 * COG layer. Like the reference explorer, this module reads each band's
 * window for a map tile straight from the COGs (picking the overview that
 * matches the tile's ground resolution), warps it from UTM to Web Mercator,
 * and paints the composite in the browser. It is served through a MapLibre
 * protocol, so a composite is a plain XYZ store layer: it shows in the Layers
 * panel, saves with the project (the tile URL carries the scene and preset),
 * and restores on reload once the protocol is registered at startup.
 *
 * The pixel math is pure and covered by `tests/sentinel2-explorer.test.ts`.
 */
import { addProtocol, type RequestParameters } from "maplibre-gl";
import { fromUrl, type GeoTIFF, type GeoTIFFImage } from "geotiff";
import proj4 from "proj4";
import { S2_SCENE_HOSTS, bandRescale } from "./sentinel2-explorer-data";

/** The URL scheme of composite tiles. */
export const S2_COMPOSITE_PROTOCOL = "s2composite";
const TILE_SIZE = 256;
const HALF_WORLD = 20_037_508.342789244;
/** Projected sample points per tile edge; pixels between them interpolate. */
const GRID = 17;
/** Largest band window read for one tile, in pixels per side. */
const MAX_WINDOW = 2048;

/** A composite of several band files. */
export type S2CompositeKey = "fcir" | "agri" | "swir" | "ndvi" | "ndwi";

export interface S2CompositeSpec {
  /** `rgb`: three bands, each stretched; `index`: (a - b) / (a + b) on a ramp. */
  kind: "rgb" | "index";
  /** Band file stems in channel order (`[a, b]` for an index). */
  bands: readonly string[];
  /** Three-stop diverging ramp over -1..1, for an index. */
  ramp?: readonly [string, string, string];
}

export const S2_COMPOSITES: Record<S2CompositeKey, S2CompositeSpec> = {
  fcir: { kind: "rgb", bands: ["B08", "B04", "B03"] },
  agri: { kind: "rgb", bands: ["B11", "B08", "B02"] },
  swir: { kind: "rgb", bands: ["B12", "B8A", "B04"] },
  // ColorBrewer BrBG ends: brown (bare) -> pale -> green (vegetation).
  ndvi: {
    kind: "index",
    bands: ["B08", "B04"],
    ramp: ["#8c510a", "#f5f5f5", "#01665e"],
  },
  // McFeeters NDWI (green/NIR): brown (land) -> pale -> blue (water).
  ndwi: {
    kind: "index",
    bands: ["B03", "B08"],
    ramp: ["#a6611a", "#f5f5f5", "#0571b0"],
  },
};

/**
 * Whether a key names a multi-file composite.
 *
 * @param key - A display key from the panel.
 * @returns True for one of {@link S2_COMPOSITES}.
 */
export function isComposite(key: string): key is S2CompositeKey {
  return Object.hasOwn(S2_COMPOSITES, key);
}

/**
 * The tile URL template of a scene composite.
 *
 * @param dir - The scene directory (see `sceneDirectory`).
 * @param key - The composite.
 * @param offset - The BOA offset to subtract (1000 from baseline 04.00, else 0).
 * @returns An `s2composite://` template with `{z}/{x}/{y}` placeholders.
 */
export function compositeTileUrl(dir: string, key: S2CompositeKey, offset: number): string {
  return `${S2_COMPOSITE_PROTOCOL}://tile/{z}/{x}/{y}?dir=${encodeURIComponent(
    dir,
  )}&c=${key}&o=${offset}`;
}

/** The parts of a composite tile request. */
export interface CompositeTileRequest {
  z: number;
  x: number;
  y: number;
  dir: string;
  key: S2CompositeKey;
  offset: number;
}

/**
 * Parses a composite tile URL; the scene directory must be an https URL on
 * an expected host, because the bands are fetched from it.
 *
 * @param url - A requested tile URL.
 * @returns The request, or null when the URL is not a valid composite tile.
 */
export function parseCompositeTileUrl(url: string): CompositeTileRequest | null {
  const match = url.match(/^s2composite:\/\/tile\/(\d+)\/(\d+)\/(\d+)\?(.*)$/);
  if (!match) return null;
  const params = new URLSearchParams(match[4]);
  const dir = params.get("dir") ?? "";
  const key = params.get("c") ?? "";
  const offset = Number(params.get("o"));
  if (!isComposite(key) || (offset !== 0 && offset !== 1000)) return null;
  try {
    const parsed = new URL(dir);
    if (parsed.protocol !== "https:" || !S2_SCENE_HOSTS.has(parsed.hostname)) {
      return null;
    }
  } catch {
    return null;
  }
  return {
    z: Number(match[1]),
    x: Number(match[2]),
    y: Number(match[3]),
    dir,
    key,
    offset,
  };
}

const hexRgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/**
 * Paints composite pixels into RGBA. A pixel where any band is 0 (the
 * Sentinel-2 nodata value) is transparent. RGB channels are stretched
 * linearly over each band's reflectance range ({@link bandRescale}); an index
 * is computed on offset-corrected DN and drawn on its ramp over -1..1.
 *
 * @param spec - The composite.
 * @param samples - One array per band in `spec.bands`, `count` values each.
 * @param offset - The BOA offset to subtract.
 * @param out - RGBA output, `4 * count` bytes.
 */
export function paintComposite(
  spec: S2CompositeSpec,
  samples: ReadonlyArray<ArrayLike<number>>,
  offset: number,
  out: Uint8ClampedArray,
): void {
  const count = out.length / 4;
  if (spec.kind === "rgb") {
    const ranges = spec.bands.map((band) => {
      const [base, top] = bandRescale(band, null);
      const lo = base + offset;
      const hi = top + offset;
      return [lo, 255 / (hi - lo)] as const;
    });
    for (let i = 0; i < count; i++) {
      const r = samples[0][i];
      const g = samples[1][i];
      const b = samples[2][i];
      const o = i * 4;
      if (!r || !g || !b) {
        out[o + 3] = 0;
        continue;
      }
      out[o] = (r - ranges[0][0]) * ranges[0][1];
      out[o + 1] = (g - ranges[1][0]) * ranges[1][1];
      out[o + 2] = (b - ranges[2][0]) * ranges[2][1];
      out[o + 3] = 255;
    }
    return;
  }
  const [lo, mid, hi] = (spec.ramp ?? ["#000000", "#808080", "#ffffff"]).map(hexRgb);
  for (let i = 0; i < count; i++) {
    const rawA = samples[0][i];
    const rawB = samples[1][i];
    const o = i * 4;
    const a = rawA - offset;
    const b = rawB - offset;
    if (!rawA || !rawB || a + b <= 0) {
      out[o + 3] = 0;
      continue;
    }
    const v = Math.max(-1, Math.min(1, (a - b) / (a + b)));
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
  /** Ground resolution of each image, meters per pixel. */
  resolutions: number[];
  originX: number;
  originY: number;
  /** proj4 definition of the band's UTM zone. */
  crs: string;
}

/** Open band files, by URL; a scene's bands share a zone. */
const bandCache = new Map<string, Promise<BandDataset>>();
const BAND_CACHE_MAX = 48;

/**
 * The proj4 definition of a WGS 84 / UTM EPSG code (326zz north, 327zz south).
 *
 * @param epsg - The EPSG code from the GeoTIFF's geokeys.
 * @returns A proj4 string.
 * @throws When the code is not a WGS 84 UTM zone.
 */
export function utmProj4(epsg: number): string {
  const zone = epsg % 100;
  const hemisphere = Math.floor(epsg / 100);
  if ((hemisphere !== 326 && hemisphere !== 327) || zone < 1 || zone > 60) {
    throw new Error(`Not a WGS 84 UTM zone: EPSG:${epsg}`);
  }
  return `+proj=utm +zone=${zone}${
    hemisphere === 327 ? " +south" : ""
  } +datum=WGS84 +units=m +no_defs`;
}

function openBand(url: string): Promise<BandDataset> {
  let cached = bandCache.get(url);
  if (!cached) {
    cached = (async () => {
      const tiff = await fromUrl(url);
      const count = await tiff.getImageCount();
      const images: GeoTIFFImage[] = [];
      for (let i = 0; i < Math.min(count, 16); i++) images.push(await tiff.getImage(i));
      const full = images[0];
      const [resX] = full.getResolution();
      const [originX, originY] = full.getOrigin();
      const epsg = Number(full.getGeoKeys()?.ProjectedCSTypeGeoKey);
      const resolutions = images.map((image) => (resX * full.getWidth()) / image.getWidth());
      return {
        tiff,
        images,
        resolutions,
        originX,
        originY,
        crs: utmProj4(epsg),
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
 * @param groundRes - The tile's ground resolution, meters per pixel.
 * @returns The index of the image to read.
 */
export function pickOverview(resolutions: readonly number[], groundRes: number): number {
  let pick = 0;
  for (let i = 0; i < resolutions.length; i++) {
    if (resolutions[i] <= groundRes) pick = i;
  }
  return pick;
}

/** UTM coordinates of every output pixel, bilinear between grid points. */
function tileUtmCoordinates(
  z: number,
  x: number,
  y: number,
  crs: string,
): { e: Float64Array; n: Float64Array } {
  const span = (2 * HALF_WORLD) / 2 ** z;
  const west = -HALF_WORLD + x * span;
  const north = HALF_WORLD - y * span;
  const toUtm = proj4("EPSG:3857", crs);
  const ge = new Float64Array(GRID * GRID);
  const gn = new Float64Array(GRID * GRID);
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const [e, n] = toUtm.forward([
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
 * One band resampled to the tile's pixels (nearest neighbour), or null when
 * the tile misses the band's footprint.
 */
async function sampleBand(
  dataset: BandDataset,
  coords: { e: Float64Array; n: Float64Array },
): Promise<Uint16Array | null> {
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
  const level = pickOverview(dataset.resolutions, (maxE - minE) / TILE_SIZE);
  const image = dataset.images[level];
  const res = dataset.resolutions[level];
  const width = image.getWidth();
  const height = image.getHeight();
  const x0 = Math.max(0, Math.floor((minE - dataset.originX) / res));
  const x1 = Math.min(width, Math.ceil((maxE - dataset.originX) / res) + 1);
  const y0 = Math.max(0, Math.floor((dataset.originY - maxN) / res));
  const y1 = Math.min(height, Math.ceil((dataset.originY - minN) / res) + 1);
  if (x1 <= x0 || y1 <= y0 || x1 - x0 > MAX_WINDOW || y1 - y0 > MAX_WINDOW) return null;
  // No abort signal: geotiff.js shares a block fetch between concurrent
  // readers, so cancelling one tile's read can truncate a block another tile
  // is decoding ("buffer error"). A cancelled tile's read just completes and
  // is discarded, and its blocks stay cached for the neighbours.
  const rasters = await image.readRasters({ window: [x0, y0, x1, y1], samples: [0] });
  const data = (rasters as unknown as ArrayLike<number>[])[0];
  const w = x1 - x0;
  const out = new Uint16Array(coords.e.length);
  for (let k = 0; k < out.length; k++) {
    const col = Math.floor((coords.e[k] - dataset.originX) / res) - x0;
    const row = Math.floor((dataset.originY - coords.n[k]) / res) - y0;
    out[k] = col >= 0 && col < w && row >= 0 && row < y1 - y0 ? data[row * w + col] : 0;
  }
  return out;
}

/**
 * Renders one composite tile as RGBA, or null when the tile misses the scene.
 *
 * @param request - The parsed tile request.
 * @param signal - Aborts the band reads.
 * @returns `256 * 256 * 4` RGBA bytes, or null.
 */
export async function renderCompositeTile(
  request: CompositeTileRequest,
  signal?: AbortSignal,
): Promise<Uint8ClampedArray | null> {
  const spec = S2_COMPOSITES[request.key];
  const urls = spec.bands.map((band) => `${request.dir}/${band}.tif`);
  try {
    return await renderWith(request, urls, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    // A failed read or decode may have left a bad block in the reader's
    // cache; reopen the bands and try once more.
    for (const url of urls) bandCache.delete(url);
    return renderWith(request, urls, signal);
  }
}

async function renderWith(
  request: CompositeTileRequest,
  urls: string[],
  signal?: AbortSignal,
): Promise<Uint8ClampedArray | null> {
  const spec = S2_COMPOSITES[request.key];
  const datasets = await Promise.all(urls.map(openBand));
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const coords = tileUtmCoordinates(request.z, request.x, request.y, datasets[0].crs);
  const samples = await Promise.all(datasets.map((dataset) => sampleBand(dataset, coords)));
  if (samples.some((band) => band === null)) return null;
  const rgba = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4);
  paintComposite(spec, samples as Uint16Array[], request.offset, rgba);
  return rgba;
}

async function rgbaToPng(rgba: Uint8ClampedArray): Promise<ArrayBuffer> {
  const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create a canvas for a Sentinel-2 composite tile.");
  context.putImageData(new ImageData(new Uint8ClampedArray(rgba), TILE_SIZE, TILE_SIZE), 0, 0);
  return (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer();
}

let emptyTile: Promise<ArrayBuffer> | null = null;

let registered = false;

/**
 * Registers the `s2composite://` tile protocol with MapLibre. Idempotent. The
 * host calls it at startup so a saved project's composite layers restore even
 * before the Sentinel-2 Explorer is opened.
 */
export function registerSentinel2CompositeProtocol(): void {
  if (registered) return;
  addProtocol(
    S2_COMPOSITE_PROTOCOL,
    async (params: RequestParameters, controller: AbortController) => {
      const request = parseCompositeTileUrl(params.url);
      if (!request) throw new Error(`Invalid Sentinel-2 composite tile: ${params.url}`);
      const rgba = await renderCompositeTile(request, controller.signal);
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
