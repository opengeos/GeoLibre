import { VECTOR_COLOR_RAMPS } from "@geolibre/core";
import { addProtocol, type RequestParameters } from "maplibre-gl";

// JAXA Earth API (https://data.earth.jaxa.jp/): JAXA's catalog of Earth
// observation datasets (elevation, land cover, precipitation, land and sea
// surface temperature, vegetation, soil moisture, aerosols, ...) published as
// cloud-optimized GeoTIFFs indexed by STAC. Every dataset is one STAC
// collection whose items tile the globe at several resolution levels, so a map
// view has to pick a level and mosaic the COG tiles that cover it.
//
// JAXA's own "JAXA Earth API for JavaScript" does exactly that: its
// TileGenerator turns a collection, band, date and color map into PNG map
// tiles. The module is not published to npm, so GeoLibre fetches the pinned
// release from JAXA's server, checks its SHA-256 and imports it from a blob
// URL (the module has no imports of its own). Loading it that way keeps the
// app's `script-src` unchanged: `blob:` is already allowed and the bytes are
// fetched under `connect-src`.
//
// Layers are plain XYZ tile layers whose template names the `jaxa-earth://`
// protocol registered here, so they persist with a project and draw on every
// renderer that reads tiles through the MapLibre protocol registry.

/** The JAXA Earth API for JavaScript release GeoLibre runs. */
export const JAXA_EARTH_API_VERSION = "2.0.1";
/** Where that release's ES module is served. */
export const JAXA_EARTH_MODULE_URL = `https://data.earth.jaxa.jp/api/javascript/v${JAXA_EARTH_API_VERSION}/jaxa.earth.esm.js`;
/**
 * SHA-256 of the module at {@link JAXA_EARTH_MODULE_URL}. A module whose bytes
 * differ is refused rather than run; bump this with the version.
 */
export const JAXA_EARTH_MODULE_SHA256 =
  "d1d7c5e1692fc532d8edda7759ad21dbcba6f182ddc05c424be1b850a2f44e84";
/** JAXA's machine-readable list of every dataset (Markdown, CORS-enabled). */
export const JAXA_EARTH_CATALOG_URL = "https://data.earth.jaxa.jp/app/mcp/catalog.v2.md";
/** The bucket prefix every dataset's `collection.json` lives under. */
export const JAXA_EARTH_COLLECTION_BASE = "https://s3.ap-northeast-1.wasabisys.com/je-pds/cog/v1/";
/** The JAXA Earth API home page. */
export const JAXA_EARTH_HOME_URL = "https://data.earth.jaxa.jp/en/";
/** JAXA's terms of use for the data. */
export const JAXA_EARTH_TERMS_URL = "https://earth.jaxa.jp/en/data/policy/";
/** The MapLibre protocol JAXA tiles are drawn through. */
export const JAXA_EARTH_PROTOCOL = "jaxa-earth";
/** Attribution recorded on every JAXA Earth layer. */
export const JAXA_EARTH_ATTRIBUTION =
  '<a href="https://data.earth.jaxa.jp/en/" target="_blank" rel="noreferrer">JAXA Earth API</a>';

/** Tile size of the PNGs the protocol serves. */
export const JAXA_EARTH_TILE_SIZE = 256;

/** A dataset id is a dotted/dashed name; anything else is not a JAXA id. */
const DATASET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** A band id (`DSM`, `LST`, `PRECIP`, ...). */
const BAND_PATTERN = /^[A-Za-z0-9_-]+$/;

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/** One dataset of the JAXA Earth catalog. */
export interface JaxaDataset {
  id: string;
  title: string;
  description: string;
  keywords: string[];
  provider: string;
  bands: string[];
  /** `[west, south, east, north]` in degrees (EPSG:4326) or metres (polar). */
  bbox: [number, number, number, number] | null;
  epsg: number;
  /** Approximate pixel size in kilometres. */
  resolutionKm: number | null;
  /** ISO 8601 start of the time range. */
  startDate: string | null;
  /** ISO 8601 end of the time range, or null while it is still updated. */
  endDate: string | null;
  /** `daily`, `monthly`, `yearly`, `none`, ... as JAXA labels it. */
  temporalResolution: string;
  /** A climatology (a multi-year average) rather than observations. */
  normal: boolean;
}

/** A themed group of JAXA's recommended datasets. */
export interface JaxaRecommendedGroup {
  title: string;
  ids: string[];
}

/** The parsed catalog. */
export interface JaxaCatalog {
  datasets: JaxaDataset[];
  recommended: JaxaRecommendedGroup[];
}

/** Whether a string is a well-formed JAXA dataset id. */
export function isJaxaDatasetId(value: string): boolean {
  return DATASET_ID_PATTERN.test(value) && !value.includes("..");
}

/** The `collection.json` URL of a dataset. */
export function jaxaCollectionUrl(id: string): string {
  if (!isJaxaDatasetId(id)) throw new Error(`Invalid JAXA Earth dataset id: ${id}`);
  return `${JAXA_EARTH_COLLECTION_BASE}${id}/collection.json`;
}

/** The dataset's page on JAXA's site. */
export function jaxaDatasetPageUrl(id: string): string {
  return `https://data.earth.jaxa.jp/en/datasets/#/id/${encodeURIComponent(id)}`;
}

/** Whether GeoLibre can map a dataset: the polar-stereographic ones are not yet supported. */
export function isJaxaDatasetMappable(dataset: Pick<JaxaDataset, "epsg">): boolean {
  return dataset.epsg === 4326;
}

function parseBbox(value: string): [number, number, number, number] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      Array.isArray(parsed) &&
      parsed.length === 4 &&
      parsed.every((n) => typeof n === "number" && Number.isFinite(n))
    ) {
      return parsed as [number, number, number, number];
    }
  } catch {
    // fall through
  }
  return null;
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseDate(value: string | undefined): string | null {
  if (!value || value === "present") return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

/**
 * Parses JAXA's Markdown dataset catalog (`catalog.v2.md`).
 *
 * The file has a "Main Recommended Data" section (themed `##` groups listing
 * dataset ids) and a "Dataset List" section where each `##` heading is a
 * dataset with `* key: value` lines.
 *
 * Args:
 *   markdown: The catalog file's text.
 *
 * Returns:
 *   The datasets (malformed entries dropped) and the recommended groups
 *   (limited to ids present in the list).
 */
export function parseJaxaCatalog(markdown: string): JaxaCatalog {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let section = "";
  const recommended: JaxaRecommendedGroup[] = [];
  const datasets: JaxaDataset[] = [];
  let fields: Record<string, string> | null = null;
  let heading = "";

  const flush = (): void => {
    if (!fields) return;
    const id = fields.id ?? "";
    const bands = splitList(fields.bands).filter((band) => BAND_PATTERN.test(band));
    if (isJaxaDatasetId(id) && bands.length > 0) {
      const epsg = Number(fields.epsg);
      const resolution = Number(fields.spatialResolution);
      datasets.push({
        id,
        title: fields.title || heading || id,
        description: fields.description ?? "",
        keywords: splitList(fields.keywords),
        provider: fields.dataProvider ?? "",
        bands,
        bbox: fields.bbox ? parseBbox(fields.bbox) : null,
        epsg: Number.isFinite(epsg) && epsg > 0 ? epsg : 4326,
        resolutionKm: Number.isFinite(resolution) && resolution > 0 ? resolution : null,
        startDate: parseDate(fields.startDate),
        endDate: parseDate(fields.endDate),
        temporalResolution: fields.temporalResolution ?? "",
        normal: fields.normal === "true",
      });
    }
    fields = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const top = /^#\s+(.*)$/.exec(line);
    if (top) {
      flush();
      section = top[1].trim().toLowerCase();
      continue;
    }
    const sub = /^##\s+(.*)$/.exec(line);
    if (sub) {
      flush();
      heading = sub[1].trim();
      if (section.startsWith("main recommended")) {
        recommended.push({ title: heading, ids: [] });
      } else if (section.startsWith("dataset list")) {
        fields = {};
      }
      continue;
    }
    if (section.startsWith("main recommended") && recommended.length > 0) {
      const id = line.replace(/^[-*]\s*/, "");
      if (id && isJaxaDatasetId(id) && id.includes(".")) {
        recommended[recommended.length - 1].ids.push(id);
      }
      continue;
    }
    if (fields) {
      const field = /^\*\s*([A-Za-z]+)\s*:\s*(.*)$/.exec(line);
      if (field) fields[field[1]] = field[2].trim();
    }
  }
  flush();

  const known = new Set(datasets.map((dataset) => dataset.id));
  return {
    datasets,
    recommended: recommended
      .map((group) => ({ title: group.title, ids: group.ids.filter((id) => known.has(id)) }))
      .filter((group) => group.ids.length > 0),
  };
}

/**
 * Fetches and parses JAXA's dataset catalog.
 *
 * Args:
 *   fetchImpl: The fetch to use (tests pass a stub).
 *   signal: Aborts the request.
 *
 * Returns:
 *   The parsed catalog.
 */
export async function fetchJaxaCatalog(
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<JaxaCatalog> {
  const response = await fetchImpl(JAXA_EARTH_CATALOG_URL, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const catalog = parseJaxaCatalog(await response.text());
  if (catalog.datasets.length === 0) throw new Error("The catalog lists no datasets.");
  return catalog;
}

/**
 * Filters datasets by a free-text query over id, title, keywords, provider and
 * bands; every whitespace-separated term must match.
 */
export function searchJaxaDatasets(datasets: JaxaDataset[], query: string): JaxaDataset[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return datasets;
  return datasets.filter((dataset) => {
    const haystack = [
      dataset.id,
      dataset.title,
      dataset.provider,
      dataset.temporalResolution,
      ...dataset.keywords,
      ...dataset.bands,
    ]
      .join(" ")
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/**
 * The highest zoom worth requesting for a dataset: the first web-mercator
 * level whose 256 px tiles are finer than the dataset's pixels (at the
 * equator). Deeper zooms upsample the last level.
 */
export function jaxaMaxZoom(resolutionKm: number | null): number {
  if (!resolutionKm || !Number.isFinite(resolutionKm) || resolutionKm <= 0) return 12;
  const equatorKm = 40_075.016_686;
  const zoom = Math.ceil(Math.log2(equatorKm / (JAXA_EARTH_TILE_SIZE * resolutionKm)));
  return Math.max(2, Math.min(14, zoom));
}

// ---------------------------------------------------------------------------
// Color maps
// ---------------------------------------------------------------------------

/** The color maps JAXA's module names itself. */
export const JAXA_NATIVE_COLORMAPS = ["jet", "gray", "ndvi", "smc", "ic"] as const;

/** Every color map the panel offers: JAXA's, then GeoLibre's curated ramps. */
export const JAXA_COLORMAP_NAMES: readonly string[] = [
  ...JAXA_NATIVE_COLORMAPS,
  ...VECTOR_COLOR_RAMPS.map((ramp) => ramp.value).filter(
    (name) => !(JAXA_NATIVE_COLORMAPS as readonly string[]).includes(name),
  ),
];

/**
 * The `colors` value for JAXA's ColorMapObject: a JAXA preset name as is, or a
 * GeoLibre ramp as `RRGGBB` strings. Unknown names fall back to `jet`.
 */
export function jaxaColorsFor(name: string): string | string[] {
  if ((JAXA_NATIVE_COLORMAPS as readonly string[]).includes(name)) return name;
  const ramp = VECTOR_COLOR_RAMPS.find((candidate) => candidate.value === name);
  if (!ramp) return "jet";
  return ramp.colors.map((color) => color.replace(/^#/, "").toLowerCase());
}

/**
 * A starting color map for a band, from what the band measures. The range is
 * read from the data itself (see the panel's Auto range).
 */
export function defaultJaxaColormap(datasetId: string, band: string): string {
  const key = `${datasetId} ${band}`.toLowerCase();
  if (/ndvi/.test(key)) return "ndvi";
  if (/smc|ssw/.test(key)) return "smc";
  if (/ic0|ice/.test(key)) return "ic";
  if (/dsm|aw3d/.test(key)) return "spectral";
  if (/precip|gsmap|spi/.test(key)) return "blues";
  if (/lst|sst|temperature/.test(key)) return "turbo";
  return "viridis";
}

// ---------------------------------------------------------------------------
// Tile URLs
// ---------------------------------------------------------------------------

/** What a JAXA Earth tile layer draws. */
export interface JaxaTileSpec {
  datasetId: string;
  band: string;
  /** The observation date (ISO 8601); JAXA rounds it down to the nearest available one. */
  date: string;
  min: number;
  max: number;
  /** A {@link JAXA_COLORMAP_NAMES} entry. */
  colormap: string;
  resampling: "nearest" | "bilinear";
}

/**
 * The XYZ tile template of a JAXA Earth layer.
 *
 * Args:
 *   spec: What the layer draws.
 *
 * Returns:
 *   A `jaxa-earth://tile/{z}/{x}/{y}?...` template.
 */
export function jaxaTileUrl(spec: JaxaTileSpec): string {
  const params = new URLSearchParams({
    id: spec.datasetId,
    band: spec.band,
    date: spec.date,
    min: String(spec.min),
    max: String(spec.max),
    colormap: spec.colormap,
    resampling: spec.resampling,
  });
  return `${JAXA_EARTH_PROTOCOL}://tile/{z}/{x}/{y}?${params.toString()}`;
}

/** A requested tile: its address plus the layer's spec. */
export interface JaxaTileRequest extends JaxaTileSpec {
  z: number;
  x: number;
  y: number;
}

/**
 * Parses a JAXA tile spec from a tile template or a requested tile URL. The
 * dataset id must be a well-formed JAXA id, since it names the bucket path the
 * data is read from.
 *
 * Args:
 *   url: A `jaxa-earth://` URL (with numbers or `{z}/{x}/{y}` placeholders).
 *
 * Returns:
 *   The spec (and the tile address when the URL has one), or null when the URL
 *   is not a valid JAXA Earth tile.
 */
export function parseJaxaTileUrl(
  url: string,
): (JaxaTileSpec & Partial<Pick<JaxaTileRequest, "z" | "x" | "y">>) | null {
  const match = new RegExp(
    `^${JAXA_EARTH_PROTOCOL}://tile/(\\d+|\\{z\\})/(\\d+|\\{x\\})/(\\d+|\\{y\\})\\?(.*)$`,
  ).exec(url);
  if (!match) return null;
  const params = new URLSearchParams(match[4]);
  const datasetId = params.get("id") ?? "";
  const band = params.get("band") ?? "";
  const date = params.get("date") ?? "";
  const min = Number(params.get("min"));
  const max = Number(params.get("max"));
  const colormap = params.get("colormap") ?? "jet";
  const resampling = params.get("resampling") === "bilinear" ? "bilinear" : "nearest";
  if (!isJaxaDatasetId(datasetId) || !BAND_PATTERN.test(band)) return null;
  if (Number.isNaN(Date.parse(date))) return null;
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) return null;
  const spec: JaxaTileSpec & Partial<Pick<JaxaTileRequest, "z" | "x" | "y">> = {
    datasetId,
    band,
    date,
    min,
    max,
    colormap: JAXA_COLORMAP_NAMES.includes(colormap) ? colormap : "jet",
    resampling,
  };
  if (/^\d+$/.test(match[1])) {
    spec.z = Number(match[1]);
    spec.x = Number(match[2]);
    spec.y = Number(match[3]);
  }
  return spec;
}

// ---------------------------------------------------------------------------
// The JAXA Earth API for JavaScript module
// ---------------------------------------------------------------------------

/** The parts of JAXA's ColorMapObject GeoLibre sets. */
export interface JaxaColorMapObject {
  min: number;
  max: number;
  colors?: string | string[];
}

/** The parts of JAXA's DataObject GeoLibre reads. */
export interface JaxaDataObject {
  width: number;
  height: number;
  data: Float32Array | Uint32Array;
  unit: string;
  date: Date;
  formattedDate: string;
  /** 1: measured values; 2: RGB colors; 3: palette classes. */
  photometricInterpretation: number;
}

/** The parts of JAXA's Image GeoLibre uses. */
export interface JaxaImage {
  getDataObject(options: {
    bbox?: [number, number, number, number];
    width?: number;
    height?: number;
  }): Promise<JaxaDataObject>;
  getDate(): Date;
  getFormattedDate(): string;
  getBand(): string;
}

/** The parts of JAXA's ImageCollection GeoLibre uses. */
export interface JaxaImageCollection {
  init(): Promise<void>;
  formatDate(date: Date): string;
  first(): Date;
  last(): Date;
  prev(date: Date): Promise<Date>;
  next(date: Date): Promise<Date>;
  getBandIdAll(): string[];
  getImage(options: { date?: Date; band?: string }): Promise<JaxaImage>;
}

/** The parts of JAXA's TileGenerator GeoLibre uses. */
export interface JaxaTileGenerator {
  init(): Promise<void>;
  getPng(x: number, y: number, z: number, abortSignal?: AbortSignal): Promise<Uint8Array>;
}

/** The parts of JAXA's ColorMap GeoLibre uses. */
export interface JaxaColorMap {
  createColorBarCanvas(width: number, height: number): HTMLCanvasElement;
}

/** The parts of the JAXA Earth API for JavaScript module GeoLibre uses. */
export interface JaxaEarthModule {
  ImageCollection: new (options: { collectionUrl: string }) => JaxaImageCollection;
  TileGenerator: new (options: {
    collectionUrl: string;
    date?: Date;
    band?: string;
    resampling?: string;
    colorMapObject?: JaxaColorMapObject;
    tileSize?: number;
    delay?: number;
  }) => JaxaTileGenerator;
  Resampling: { NEAREST: string; BILINEAR: string };
  image: { ColorMap: new (colorMapObject: JaxaColorMapObject) => JaxaColorMap };
}

/** Hex-encodes a digest. */
function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Downloads the pinned JAXA module, checks its SHA-256 and imports it from a
 * blob URL.
 */
async function importJaxaEarthModule(): Promise<JaxaEarthModule> {
  const response = await fetch(JAXA_EARTH_MODULE_URL);
  if (!response.ok) throw new Error(`HTTP ${response.status} loading the JAXA Earth API module`);
  const source = await response.arrayBuffer();
  const digest = toHex(await crypto.subtle.digest("SHA-256", source));
  if (digest !== JAXA_EARTH_MODULE_SHA256) {
    throw new Error(
      `The JAXA Earth API module at ${JAXA_EARTH_MODULE_URL} changed (SHA-256 ${digest}); GeoLibre refuses to run it.`,
    );
  }
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    return (await import(/* @vite-ignore */ url)) as JaxaEarthModule;
  } finally {
    URL.revokeObjectURL(url);
  }
}

let moduleLoader: () => Promise<JaxaEarthModule> = importJaxaEarthModule;
let modulePromise: Promise<JaxaEarthModule> | null = null;

/**
 * Loads (once) the JAXA Earth API for JavaScript module. A failed load is
 * retried on the next call.
 */
export function loadJaxaEarthModule(): Promise<JaxaEarthModule> {
  modulePromise ??= moduleLoader().catch((error: unknown) => {
    modulePromise = null;
    throw error;
  });
  return modulePromise;
}

/**
 * Replaces the module loader (tests), dropping the loaded module and every
 * cached generator and collection. `null` restores the network loader.
 */
export function setJaxaEarthModuleLoader(loader: (() => Promise<JaxaEarthModule>) | null): void {
  moduleLoader = loader ?? importJaxaEarthModule;
  modulePromise = null;
  generators.clear();
  collections.clear();
}

const collections = new Map<string, Promise<JaxaImageCollection>>();

/**
 * The initialized ImageCollection of a dataset, shared by the panel. A failed
 * init is not cached.
 */
export function getJaxaImageCollection(datasetId: string): Promise<JaxaImageCollection> {
  let pending = collections.get(datasetId);
  if (!pending) {
    pending = (async () => {
      const je = await loadJaxaEarthModule();
      const collection = new je.ImageCollection({ collectionUrl: jaxaCollectionUrl(datasetId) });
      await collection.init();
      return collection;
    })();
    pending.catch(() => collections.delete(datasetId));
    collections.set(datasetId, pending);
  }
  return pending;
}

/** Most TileGenerators kept alive; each holds a COG tile cache. */
const MAX_GENERATORS = 8;
const generators = new Map<string, Promise<JaxaTileGenerator>>();

function generatorKey(spec: JaxaTileSpec): string {
  return [
    spec.datasetId,
    spec.band,
    spec.date,
    spec.min,
    spec.max,
    spec.colormap,
    spec.resampling,
  ].join("|");
}

/** The TileGenerator for a spec, created and initialized once (LRU-capped). */
function getGenerator(spec: JaxaTileSpec): Promise<JaxaTileGenerator> {
  const key = generatorKey(spec);
  const cached = generators.get(key);
  if (cached) {
    // Refresh its place in the LRU order.
    generators.delete(key);
    generators.set(key, cached);
    return cached;
  }
  const pending = (async () => {
    const je = await loadJaxaEarthModule();
    const generator = new je.TileGenerator({
      collectionUrl: jaxaCollectionUrl(spec.datasetId),
      band: spec.band,
      date: new Date(spec.date),
      resampling: spec.resampling === "bilinear" ? je.Resampling.BILINEAR : je.Resampling.NEAREST,
      colorMapObject: { min: spec.min, max: spec.max, colors: jaxaColorsFor(spec.colormap) },
      tileSize: JAXA_EARTH_TILE_SIZE,
      // JAXA batches the tile requests that arrive within this window into
      // one read; shorter than its 500 ms default so a pan feels responsive.
      delay: 150,
    });
    await generator.init();
    return generator;
  })();
  pending.catch(() => {
    if (generators.get(key) === pending) generators.delete(key);
  });
  generators.set(key, pending);
  while (generators.size > MAX_GENERATORS) {
    const oldest = generators.keys().next().value as string;
    generators.delete(oldest);
  }
  return pending;
}

/** An `ArrayBuffer` holding exactly a view's bytes. */
function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}

/**
 * Renders one tile as PNG bytes.
 *
 * Args:
 *   url: A requested `jaxa-earth://tile/z/x/y?...` URL.
 *   signal: Aborts the read when MapLibre drops the tile.
 *
 * Returns:
 *   The PNG bytes.
 */
export async function renderJaxaTile(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const request = parseJaxaTileUrl(url);
  if (!request || request.z === undefined || request.x === undefined || request.y === undefined) {
    throw new Error(`Invalid JAXA Earth tile: ${url}`);
  }
  const generator = await getGenerator(request);
  const png = await generator.getPng(request.x, request.y, request.z, signal);
  return exactBuffer(png);
}

let registered = false;

/**
 * Registers the `jaxa-earth://` MapLibre protocol. Called at startup so a
 * saved project's JAXA layers draw before the plugin is opened; the JAXA
 * module itself loads on the first tile.
 */
export function registerJaxaEarthProtocol(): void {
  if (registered) return;
  addProtocol(
    JAXA_EARTH_PROTOCOL,
    async (params: RequestParameters, controller: AbortController) => ({
      data: await renderJaxaTile(params.url, controller.signal),
    }),
  );
  // Only once it took, so a failed registration is retried on the next call.
  registered = true;
}

// ---------------------------------------------------------------------------
// Value ranges
// ---------------------------------------------------------------------------

/**
 * A display range for sampled values: the 2nd and 98th percentiles of the
 * finite values, so a few outliers do not wash out the color map. A constant
 * sample is widened by one unit.
 *
 * Args:
 *   values: Sampled pixel values (NaN for no data).
 *
 * Returns:
 *   `[min, max]` rounded to three significant digits, or null when the sample
 *   holds no finite value.
 */
export function percentileRange(values: ArrayLike<number>): [number, number] | null {
  const finite: number[] = [];
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (Number.isFinite(value)) finite.push(value);
  }
  if (finite.length === 0) return null;
  finite.sort((a, b) => a - b);
  const at = (fraction: number): number =>
    finite[Math.min(finite.length - 1, Math.max(0, Math.round(fraction * (finite.length - 1))))];
  let min = roundSignificant(at(0.02));
  let max = roundSignificant(at(0.98));
  if (!(max > min)) {
    min = roundSignificant(finite[0]);
    max = roundSignificant(finite[finite.length - 1]);
  }
  if (!(max > min)) {
    min -= 0.5;
    max += 0.5;
  }
  return [min, max];
}

/** Rounds to three significant digits. */
function roundSignificant(value: number): number {
  if (value === 0) return 0;
  return Number(value.toPrecision(3));
}
