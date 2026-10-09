import type { Feature, FeatureCollection, MultiPolygon, Polygon, Position } from "geojson";
import { fromArrayBuffer } from "geotiff";
import {
  MAX_CLIENT_RASTER_BYTES,
  readRasterData,
  writeRasterBands,
  writeUint8Bands,
} from "./raster-client";
import { runWasmToolInBackground } from "./wasm-tool-runner";

/**
 * Object-based image analysis (OBIA) engine for the Object-Based Analysis
 * workbench (#3053).
 *
 * Wraps the geolibre-wasm OBIA tools (segmentation, polygonization) so the
 * workbench drives typed functions instead of CLI strings. Everything runs in
 * the browser on the WASI tool runner; nothing here touches the store or the
 * map, so the app layer owns layers and UI state.
 */

/** Why an OBIA call refused its input, for the UI to translate. */
export type ObiaErrorCode =
  | "image-too-large"
  | "too-many-bands"
  | "no-such-band"
  | "no-bands"
  | "missing-fields";

/**
 * An input the workbench rejects, with a stable `code` and `params` the app
 * maps to a translated message (`message` stays English for logs and scripts).
 */
export class ObiaError extends Error {
  readonly code: ObiaErrorCode;
  readonly params: Record<string, number>;

  constructor(code: ObiaErrorCode, message: string, params: Record<string, number> = {}) {
    super(message);
    this.name = "ObiaError";
    this.code = code;
    this.params = params;
  }
}

/** Object ids are the segment label values the segmentation raster carries. */
export const OBIA_SEGMENT_ID_FIELD = "segment_id";

/** Pixel-count ceiling for a workbench run (about a 4096 x 4096 scene). */
export const OBIA_MAX_PIXELS = 16_777_216;

/** Parameters of the seeded region-growing segmentation. */
export interface RegionGrowingParams {
  /**
   * Growth threshold as a distance in standardized (z-score) band space: a
   * pixel joins a region while its distance to the region seed is at most this
   * value. Larger values give fewer, larger objects.
   */
  threshold: number;
  /** Objects smaller than this many pixels merge into their most similar neighbor. */
  minArea: number;
  /** Number of seed-priority bins (homogeneous pixels seed first). */
  steps: number;
}

export const DEFAULT_REGION_GROWING_PARAMS: RegionGrowingParams = {
  threshold: 0.8,
  minArea: 20,
  steps: 10,
};

/** One band of the source image, written as a single-band GeoTIFF. */
export interface ObiaBand {
  /** 1-based band index in the source image. */
  index: number;
  bytes: Uint8Array;
}

/** A source image split into the single-band rasters the OBIA tools read. */
export interface ObiaImage {
  width: number;
  height: number;
  bandCount: number;
  nodata: number | null;
  bands: ObiaBand[];
}

/** Result of segmenting an image into objects. */
export interface ObiaSegmentation {
  /** Label raster (GeoTIFF): each pixel holds its object's `segment_id`. */
  labels: Uint8Array;
  /** One feature per object in WGS84, `id` and `segment_id` set to the label. */
  objects: FeatureCollection;
  objectCount: number;
  /** Mean object size in pixels. */
  meanObjectArea: number;
  /** Exact tool invocation, for provenance. */
  tool: string;
  args: string[];
}

function toArrayBuffer(bytes: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Split a (multi-band) GeoTIFF into single-band GeoTIFFs, one per band, keeping
 * the georeferencing and NoData. The OBIA tools take an array of single-band
 * rasters, and the spectral features name their columns by that order.
 *
 * @param bytes GeoTIFF bytes of the source image.
 * @param bandIndexes 1-based bands to keep; all bands when omitted.
 * @returns The image dimensions and one GeoTIFF per kept band.
 */
export async function splitImageBands(
  bytes: ArrayBuffer | Uint8Array,
  bandIndexes?: readonly number[],
): Promise<ObiaImage> {
  const buffer = toArrayBuffer(bytes);
  // Check the size from the header before decoding anything.
  const { width, height, bandCount } = await readImageSummary(buffer);
  if (width * height > OBIA_MAX_PIXELS) {
    throw new ObiaError(
      "image-too-large",
      `This image has ${width} x ${height} pixels, over the workbench's limit of ${OBIA_MAX_PIXELS.toLocaleString("en-US")} pixels. Clip it to a smaller area first.`,
      { width, height, max: OBIA_MAX_PIXELS },
    );
  }
  const wanted = bandIndexes?.length
    ? [...bandIndexes]
    : Array.from({ length: bandCount }, (_, index) => index + 1);
  const missing = wanted.find(
    (index) => !Number.isInteger(index) || index < 1 || index > bandCount,
  );
  if (missing !== undefined) {
    throw new ObiaError("no-such-band", `The image has no band ${missing}.`, { index: missing });
  }
  // The decoder holds each chosen band as Float32; refuse up front, with a
  // translatable error, a selection it would reject for memory.
  if (width * height * wanted.length * Float32Array.BYTES_PER_ELEMENT > MAX_CLIENT_RASTER_BYTES) {
    throw new ObiaError(
      "too-many-bands",
      `${wanted.length} bands of this image need more memory than the in-browser workbench allows. Select fewer bands, or clip the image.`,
      { bands: wanted.length },
    );
  }
  // Decode only the chosen bands, in the order asked for.
  const raster = await readRasterData(buffer, { samples: wanted.map((index) => index - 1) });
  const bands = wanted.map((index, i) => {
    const single = writeRasterBands({ ...raster, bands: [raster.bands[i]] });
    return { index, bytes: new Uint8Array(single) };
  });
  return {
    width: raster.width,
    height: raster.height,
    bandCount,
    nodata: raster.nodata,
    bands,
  };
}

/** Size and band count of an image, read from its header only. */
export interface ObiaImageSummary {
  width: number;
  height: number;
  bandCount: number;
}

/**
 * Read an image's dimensions and band count without decoding its pixels, so
 * the workbench can list bands before the user commits to a run.
 *
 * @param bytes GeoTIFF bytes.
 */
export async function readImageSummary(bytes: ArrayBuffer | Uint8Array): Promise<ObiaImageSummary> {
  const tiff = await fromArrayBuffer(toArrayBuffer(bytes));
  const image = await tiff.getImage();
  return {
    width: image.getWidth(),
    height: image.getHeight(),
    bandCount: image.getSamplesPerPixel(),
  };
}

/** Stage the bands under /work and return their paths and the input map. */
export function stageBands(bands: readonly ObiaBand[]): {
  paths: string[];
  input: Record<string, Uint8Array>;
} {
  const input: Record<string, Uint8Array> = {};
  const paths = bands.map((band) => {
    const file = `band_${band.index}.tif`;
    input[file] = band.bytes;
    return `/work/${file}`;
  });
  return { paths, input };
}

/** CLI args for `image_segmentation` (seeded region growing). */
export function regionGrowingArgs(
  bandPaths: readonly string[],
  params: RegionGrowingParams,
  output = "/work/segments.tif",
): string[] {
  return [
    `--inputs=${bandPaths.join(",")}`,
    `--threshold=${params.threshold}`,
    `--steps=${Math.max(1, Math.round(params.steps))}`,
    `--min_area=${Math.max(1, Math.round(params.minArea))}`,
    `--output=${output}`,
  ];
}

function toolFailure(tool: string, stdout: readonly string[]): Error {
  const detail = stdout
    .filter((line) => line.trim())
    .slice(-3)
    .join(" ");
  return new Error(`${tool} failed${detail ? `: ${detail}` : ""}`);
}

/**
 * How a long OBIA call reports and stops: `signal` cancels it (the running
 * WASM tool is terminated and the call rejects with an `AbortError`), and
 * `onStep` is told the id of each tool as it starts.
 */
export interface ObiaRunOptions {
  signal?: AbortSignal;
  onStep?: (tool: string) => void;
}

async function runTool(
  tool: string,
  args: string[],
  input: Record<string, Uint8Array>,
  run: ObiaRunOptions = {},
): Promise<Record<string, Uint8Array>> {
  run.onStep?.(tool);
  const result = await runWasmToolInBackground({ tool, args, input }, { signal: run.signal });
  if (result.exitCode !== 0) throw toolFailure(tool, result.stdout);
  return result.files;
}

/**
 * Group polygonized pieces by segment label into one feature per object. A
 * label can come back as several polygons (pixels joined only diagonally are
 * separate rings in the 4-connected trace), which become one MultiPolygon so
 * each object has exactly one feature and one id.
 *
 * @param pieces Polygonizer output, the label in `idProperty`.
 * @param idProperty Property holding the label (`VALUE` for segments_to_polygons).
 */
export function dissolveSegmentPolygons(
  pieces: FeatureCollection,
  idProperty = "VALUE",
): FeatureCollection {
  const rings = new Map<number, Position[][][]>();
  for (const feature of pieces.features) {
    const raw = feature.properties?.[idProperty];
    const id = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(id) || id <= 0) continue;
    const geometry = feature.geometry;
    let polygons: Position[][][];
    if (geometry?.type === "Polygon") polygons = [geometry.coordinates];
    else if (geometry?.type === "MultiPolygon") polygons = geometry.coordinates;
    else continue;
    const list = rings.get(id);
    if (list) list.push(...polygons);
    else rings.set(id, [...polygons]);
  }
  const features: Feature[] = [...rings.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([id, polygons]) => {
      const geometry: Polygon | MultiPolygon =
        polygons.length === 1
          ? { type: "Polygon", coordinates: polygons[0] }
          : { type: "MultiPolygon", coordinates: polygons };
      return {
        type: "Feature",
        id,
        properties: { [OBIA_SEGMENT_ID_FIELD]: id },
        geometry,
      };
    });
  return { type: "FeatureCollection", features };
}

/**
 * Fingerprint a label raster: the number of distinct objects (positive
 * labels) and a hash of every pixel's label. Two label rasters with the same
 * fingerprint describe the same objects, which is how a reloaded project
 * checks that a rebuilt segmentation still matches its saved objects.
 *
 * @param labels Label raster (GeoTIFF).
 * @returns The object count and a 32-bit FNV-1a hash of the labels, as hex.
 */
export async function fingerprintSegmentLabels(
  labels: Uint8Array,
): Promise<{ objectCount: number; hash: string }> {
  const raster = await readRasterData(toArrayBuffer(labels));
  const ids = new Set<number>();
  let hash = 0x811c9dc5;
  for (const value of raster.bands[0]) {
    const label = value > 0 && value !== raster.nodata ? value : 0;
    if (label) ids.add(label);
    // Hash the label's four bytes, so ids above 255 hash distinctly.
    for (let shift = 0; shift < 32; shift += 8) {
      hash ^= (label >>> shift) & 0xff;
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return { objectCount: ids.size, hash: (hash >>> 0).toString(16).padStart(8, "0") };
}

/**
 * Run the region-growing segmentation alone, returning the label raster. The
 * tool is deterministic, so the same image and parameters give the same
 * labels, which is how a reloaded project rebuilds labels it did not save.
 *
 * @param image Bands from {@link splitImageBands}.
 * @param params Region-growing parameters.
 */
export async function segmentLabels(
  image: ObiaImage,
  params: RegionGrowingParams,
  run: ObiaRunOptions = {},
): Promise<{ labels: Uint8Array; tool: string; args: string[] }> {
  if (!image.bands.length) {
    throw new ObiaError("no-bands", "Choose at least one band to segment.");
  }
  const { paths, input } = stageBands(image.bands);
  const tool = "image_segmentation";
  const args = regionGrowingArgs(paths, params);
  const files = await runTool(tool, args, input, run);
  const labels = files["segments.tif"];
  if (!labels) throw new Error(`${tool} did not write a segment raster.`);
  return { labels, tool, args };
}

/**
 * Segment an image into objects with seeded region growing and polygonize the
 * labels. Runs entirely in the browser.
 *
 * @param image Bands from {@link splitImageBands}.
 * @param params Region-growing parameters.
 */
export async function segmentImage(
  image: ObiaImage,
  params: RegionGrowingParams,
  run: ObiaRunOptions = {},
): Promise<ObiaSegmentation> {
  const { labels, tool, args } = await segmentLabels(image, params, run);

  const polygonFiles = await runTool(
    "segments_to_polygons",
    ["--segments=/work/segments.tif", "--output=/work/segments.geojson"],
    { "segments.tif": labels },
    run,
  );
  const geojson = polygonFiles["segments.geojson"];
  if (!geojson) throw new Error("segments_to_polygons did not write polygons.");
  const pieces = JSON.parse(new TextDecoder().decode(geojson)) as FeatureCollection;
  const objects = dissolveSegmentPolygons(pieces);
  const objectCount = objects.features.length;
  return {
    labels,
    objects,
    objectCount,
    meanObjectArea: objectCount ? (image.width * image.height) / objectCount : 0,
    tool,
    args,
  };
}

// --- Object features --------------------------------------------------------

/** A parsed OBIA tool CSV (the tools write plain, unquoted CSV). */
export interface ObiaCsv {
  headers: string[];
  rows: string[][];
}

/**
 * Parse the plain CSV the OBIA tools write (no quoting, comma separated).
 *
 * @param text CSV text with a header row.
 */
export function parseObiaCsv(text: string): ObiaCsv {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = lines[0].split(",").map((h) => h.trim());
  const rows = lines.slice(1).map((line) => line.split(",").map((cell) => cell.trim()));
  return { headers, rows };
}

/**
 * Per-object feature values keyed by `segment_id`. A value is null when the
 * tool produced no row for that object (e.g. GLCM texture of a 1-pixel object).
 */
export interface ObiaFeatureTable {
  /** Feature names, in column order. */
  fields: string[];
  rows: Map<number, Record<string, number | null>>;
}

/** Band roles for the spectral indices, as 1-based source band numbers. */
export interface ObiaIndexBands {
  red?: number;
  green?: number;
  nir?: number;
}

/** Which feature groups to compute. */
export interface ObiaFeatureOptions {
  spectral: boolean;
  shape: boolean;
  /** GLCM texture on this 1-based source band; omitted for none. */
  textureBand?: number;
  context: boolean;
  /** Indices derived from the band means; needs `spectral`. */
  indices?: ObiaIndexBands;
}

export const DEFAULT_OBIA_FEATURE_OPTIONS: ObiaFeatureOptions = {
  spectral: true,
  shape: true,
  context: false,
};

/** One tool run behind a feature table, for provenance. */
export interface ObiaToolCall {
  tool: string;
  args: string[];
}

function csvToTable(
  csv: ObiaCsv,
  rename: (field: string) => string | null,
  table: ObiaFeatureTable,
): void {
  const idCol = csv.headers.indexOf(OBIA_SEGMENT_ID_FIELD);
  if (idCol < 0) throw new Error(`Feature table has no ${OBIA_SEGMENT_ID_FIELD} column.`);
  const columns: { index: number; name: string }[] = [];
  csv.headers.forEach((header, index) => {
    if (index === idCol) return;
    const name = rename(header);
    if (!name || table.fields.includes(name)) return;
    table.fields.push(name);
    columns.push({ index, name });
  });
  for (const row of csv.rows) {
    // A blank cell would read as id 0 and create a phantom object.
    if (!row[idCol]) continue;
    const id = Number(row[idCol]);
    if (!Number.isFinite(id)) continue;
    let record = table.rows.get(id);
    if (!record) {
      record = {};
      table.rows.set(id, record);
    }
    for (const { index, name } of columns) {
      const raw = row[index];
      const value =
        raw === "true"
          ? 1
          : raw === "false"
            ? 0
            : raw === undefined || raw === ""
              ? NaN
              : Number(raw);
      record[name] = Number.isFinite(value) ? value : null;
    }
  }
}

/**
 * Rename a spectral column from the tool's input order (`mean_b2` = the second
 * band passed in) to the source band number, so `mean_b4` always means band 4
 * of the image whichever bands were selected.
 */
export function sourceBandColumn(header: string, bandIndexes: readonly number[]): string {
  const match = header.match(/^(.+)_b(\d+)$/);
  if (!match) return header;
  const source = bandIndexes[Number(match[2]) - 1];
  return source ? `${match[1]}_b${source}` : header;
}

const round = (value: number) => Math.round(value * 1e6) / 1e6;

function normalizedDifference(a: number | null, b: number | null): number | null {
  if (a == null || b == null || a + b === 0) return null;
  return round((a - b) / (a + b));
}

/**
 * Add per-object indices computed from the band means: brightness (mean of
 * the band means), NDVI from red/NIR, and NDWI (McFeeters) from green/NIR.
 *
 * @param table Table holding `mean_b<n>` columns (source band numbers).
 * @param bandIndexes Source bands the means were computed for.
 * @param roles Which source bands are red, green and NIR.
 */
export function addSpectralIndices(
  table: ObiaFeatureTable,
  bandIndexes: readonly number[],
  roles: ObiaIndexBands = {},
): void {
  const meanOf = (record: Record<string, number | null>, band?: number) =>
    band != null && bandIndexes.includes(band) ? (record[`mean_b${band}`] ?? null) : null;
  const add = (field: string) => {
    if (!table.fields.includes(field)) table.fields.push(field);
  };
  add("brightness");
  const hasNdvi = roles.red != null && roles.nir != null;
  const hasNdwi = roles.green != null && roles.nir != null;
  if (hasNdvi) add("ndvi");
  if (hasNdwi) add("ndwi");
  for (const record of table.rows.values()) {
    const means = bandIndexes
      .map((band) => record[`mean_b${band}`])
      .filter((value): value is number => value != null);
    record.brightness = means.length
      ? round(means.reduce((sum, value) => sum + value, 0) / means.length)
      : null;
    if (hasNdvi)
      record.ndvi = normalizedDifference(meanOf(record, roles.nir), meanOf(record, roles.red));
    if (hasNdwi)
      record.ndwi = normalizedDifference(meanOf(record, roles.green), meanOf(record, roles.nir));
  }
}

/**
 * Measure each object: spectral statistics per band, shape, optional GLCM
 * texture and neighborhood context, all from the label raster and the
 * original (unscaled) bands.
 *
 * @param labels Label raster from {@link segmentImage}.
 * @param image The same bands the objects were segmented from.
 * @param options Feature groups to compute.
 */
export async function computeObjectFeatures(
  labels: Uint8Array,
  image: ObiaImage,
  options: ObiaFeatureOptions,
  runOptions: ObiaRunOptions = {},
): Promise<{ table: ObiaFeatureTable; calls: ObiaToolCall[] }> {
  const table: ObiaFeatureTable = { fields: [], rows: new Map() };
  const calls: ObiaToolCall[] = [];
  const bandIndexes = image.bands.map((band) => band.index);
  const { paths, input } = stageBands(image.bands);
  const segments = { "segments.tif": labels };
  const decode = (bytes: Uint8Array | undefined, tool: string) => {
    if (!bytes) throw new Error(`${tool} did not write its feature table.`);
    return parseObiaCsv(new TextDecoder().decode(bytes));
  };
  const run = async (
    tool: string,
    args: string[],
    files: Record<string, Uint8Array>,
    rename: (field: string) => string | null,
  ) => {
    const out = await runTool(tool, args, files, runOptions);
    calls.push({ tool, args });
    csvToTable(decode(out["features.csv"], tool), rename, table);
  };

  if (options.spectral) {
    await run(
      "object_features_spectral_basic",
      [
        "--segments=/work/segments.tif",
        `--inputs=${paths.join(",")}`,
        "--output=/work/features.csv",
      ],
      { ...segments, ...input },
      // `count` duplicates shape's area_px; keep it only without shape.
      (field) =>
        field === "count"
          ? options.shape
            ? null
            : "area_px"
          : sourceBandColumn(field, bandIndexes),
    );
    if (options.indices) addSpectralIndices(table, bandIndexes, options.indices);
  }
  if (options.shape) {
    await run(
      "object_features_shape_basic",
      ["--segments=/work/segments.tif", "--output=/work/features.csv"],
      segments,
      (field) => field,
    );
  }
  if (options.textureBand != null) {
    const band = image.bands.find((item) => item.index === options.textureBand);
    if (!band) throw new Error(`Band ${options.textureBand} is not among the segmented bands.`);
    await run(
      "object_features_texture_glcm_basic",
      ["--segments=/work/segments.tif", "--input=/work/texture.tif", "--output=/work/features.csv"],
      { ...segments, "texture.tif": band.bytes },
      // pair_count is a sample size, not a texture measure.
      (field) => (field === "pair_count" ? null : `${field}_b${band.index}`),
    );
  }
  if (options.context) {
    await run(
      "object_features_context_neighbors",
      ["--segments=/work/segments.tif", "--output=/work/features.csv"],
      segments,
      (field) => field,
    );
  }
  return { table, calls };
}

/**
 * Copy a feature table onto the objects as properties (matched by
 * `segment_id`), replacing earlier feature values but keeping other
 * properties such as training labels.
 *
 * @param objects Objects from {@link segmentImage}.
 * @param table Features to write.
 * @param previousFields Fields an earlier run wrote, removed first.
 */
export function applyObjectFeatures(
  objects: FeatureCollection,
  table: ObiaFeatureTable,
  previousFields: readonly string[] = [],
): FeatureCollection {
  return {
    ...objects,
    features: objects.features.map((feature) => {
      const id = Number(feature.properties?.[OBIA_SEGMENT_ID_FIELD] ?? feature.id);
      const properties: Record<string, unknown> = { ...(feature.properties ?? {}) };
      for (const field of previousFields) delete properties[field];
      const record = table.rows.get(id);
      for (const field of table.fields) properties[field] = record?.[field] ?? null;
      return { ...feature, properties };
    }),
  };
}

// --- Training samples -------------------------------------------------------

/** Object property holding a sample's class name. */
export const OBIA_CLASS_FIELD = "obia_class";
/** Object property holding a sample's role: training or validation. */
export const OBIA_SAMPLE_FIELD = "obia_sample";

export type ObiaSampleRole = "training" | "validation";

/** A labeled object. */
export interface ObiaSample {
  segmentId: number;
  className: string;
  role: ObiaSampleRole;
}

/** A land-cover class the user labels objects with. */
export interface ObiaClass {
  name: string;
  /** CSS hex color, e.g. "#22c55e". */
  color: string;
}

function objectSegmentId(feature: Feature): number {
  return Number(feature.properties?.[OBIA_SEGMENT_ID_FIELD] ?? feature.id);
}

/**
 * Label objects as samples of a class, or clear their labels.
 *
 * @param objects The objects layer's features.
 * @param segmentIds Objects to change.
 * @param label Class and role to assign, or null to clear.
 */
export function labelObjects(
  objects: FeatureCollection,
  segmentIds: ReadonlySet<number>,
  label: { className: string; role: ObiaSampleRole } | null,
): FeatureCollection {
  return {
    ...objects,
    features: objects.features.map((feature) => {
      const id = objectSegmentId(feature);
      // An object with no usable id is never a match (Set.has(NaN) can be true).
      if (!Number.isFinite(id) || !segmentIds.has(id)) return feature;
      const properties: Record<string, unknown> = { ...(feature.properties ?? {}) };
      if (label) {
        properties[OBIA_CLASS_FIELD] = label.className;
        properties[OBIA_SAMPLE_FIELD] = label.role;
      } else {
        delete properties[OBIA_CLASS_FIELD];
        delete properties[OBIA_SAMPLE_FIELD];
      }
      return { ...feature, properties };
    }),
  };
}

/**
 * Rename a class on every object labeled with it.
 *
 * @param objects The objects layer's features.
 * @param from Current class name.
 * @param to New class name.
 */
export function renameObjectClass(
  objects: FeatureCollection,
  from: string,
  to: string,
): FeatureCollection {
  return {
    ...objects,
    features: objects.features.map((feature) =>
      feature.properties?.[OBIA_CLASS_FIELD] === from
        ? { ...feature, properties: { ...feature.properties, [OBIA_CLASS_FIELD]: to } }
        : feature,
    ),
  };
}

/** The labeled objects, read back from their properties. */
export function collectSamples(objects: FeatureCollection): ObiaSample[] {
  const samples: ObiaSample[] = [];
  for (const feature of objects.features) {
    const className = feature.properties?.[OBIA_CLASS_FIELD];
    if (typeof className !== "string" || !className) continue;
    const segmentId = objectSegmentId(feature);
    if (!Number.isFinite(segmentId)) continue;
    const role: ObiaSampleRole =
      feature.properties?.[OBIA_SAMPLE_FIELD] === "validation" ? "validation" : "training";
    samples.push({ segmentId, className, role });
  }
  return samples;
}

/** Deterministic PRNG (mulberry32) so a split is reproducible from its seed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Pick a stratified, seeded subset of the training samples to hold out for
 * validation: `fraction` of each class (rounded, at least one per class that
 * has two or more samples, and never a class's last training sample).
 *
 * @param samples All samples; only training samples are candidates.
 * @param fraction Share of each class to hold out, 0 to 1.
 * @param seed Seed for the shuffle.
 * @returns Segment ids to relabel as validation.
 */
export function stratifiedHoldout(
  samples: readonly ObiaSample[],
  fraction: number,
  seed: number,
): Set<number> {
  const random = seededRandom(seed);
  const byClass = new Map<string, number[]>();
  for (const sample of samples) {
    if (sample.role !== "training") continue;
    const list = byClass.get(sample.className) ?? [];
    list.push(sample.segmentId);
    byClass.set(sample.className, list);
  }
  const held = new Set<number>();
  for (const className of [...byClass.keys()].sort()) {
    const ids = byClass.get(className)!.sort((a, b) => a - b);
    // Fisher-Yates with the seeded generator.
    for (let i = ids.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    if (ids.length < 2) continue;
    const count = Math.min(ids.length - 1, Math.max(1, Math.round(ids.length * fraction)));
    for (const id of ids.slice(0, count)) held.add(id);
  }
  return held;
}

// --- Classification ---------------------------------------------------------

/** Object property holding the predicted class. */
export const OBIA_PREDICTED_FIELD = "obia_predicted";

export type ObiaRuleOp = ">" | ">=" | "<" | "<=" | "==" | "!=";
export const OBIA_RULE_OPS: readonly ObiaRuleOp[] = [">", ">=", "<", "<=", "==", "!="];

/** One threshold rule: objects whose `field` satisfies `op value` get `className`. */
export interface ObiaRule {
  field: string;
  op: ObiaRuleOp;
  value: number;
  className: string;
}

/** Predicted class per object, plus how it was produced. */
export interface ObiaClassification {
  predictions: Map<number, string>;
  /** Features the classifier saw. */
  fields: string[];
  /** Missing values replaced by the column mean, per field (only fields that had any). */
  imputed: Record<string, number>;
  trainingCount: number;
  call: ObiaToolCall;
}

/**
 * Write a feature table as the tools' plain CSV. Columns with no values at all
 * are dropped. Missing values are replaced by the column mean when `impute`
 * is set (the random forest rejects empty cells), or left empty otherwise (the
 * rules tool then skips a rule for an object it has no value for).
 *
 * @param table Feature table.
 * @param fields Columns to include, in order.
 * @param options `impute` (default true) fills missing values with the mean.
 */
export function featureTableCsv(
  table: ObiaFeatureTable,
  fields: readonly string[],
  { impute = true }: { impute?: boolean } = {},
): { csv: string; fields: string[]; imputed: Record<string, number> } {
  const ids = [...table.rows.keys()].sort((a, b) => a - b);
  const kept: string[] = [];
  const means = new Map<string, number>();
  const imputed: Record<string, number> = {};
  for (const field of fields) {
    let sum = 0;
    let n = 0;
    for (const id of ids) {
      const value = table.rows.get(id)?.[field];
      if (value != null && Number.isFinite(value)) {
        sum += value;
        n += 1;
      }
    }
    if (!n) continue;
    kept.push(field);
    means.set(field, sum / n);
    if (impute && n < ids.length) imputed[field] = ids.length - n;
  }
  const lines = [[OBIA_SEGMENT_ID_FIELD, ...kept].join(",")];
  for (const id of ids) {
    const row = table.rows.get(id)!;
    lines.push(
      [id, ...kept.map((field) => String(row[field] ?? (impute ? means.get(field) : "")))].join(
        ",",
      ),
    );
  }
  return { csv: `${lines.join("\n")}\n`, fields: kept, imputed };
}

/**
 * The feature table with an empty row for every object a feature tool skipped
 * (e.g. GLCM texture of a 1-pixel object), so every object is classified: the
 * random forest fills the gaps with column means, and rules give it the
 * default class.
 *
 * @param table Feature table.
 * @param objects The objects layer's features.
 */
export function tableForAllObjects(
  table: ObiaFeatureTable,
  objects: FeatureCollection,
): ObiaFeatureTable {
  const rows = new Map(table.rows);
  for (const feature of objects.features) {
    const id = objectSegmentId(feature);
    if (Number.isFinite(id) && !rows.has(id)) rows.set(id, {});
  }
  return { fields: table.fields, rows };
}

/**
 * CSV-safe stand-ins for class names: the tools' CSV has no quoting, so a
 * class named "trees, shrubs" would split a row.
 */
function classTokens(names: Iterable<string>): {
  token: (name: string) => string;
  name: (token: string) => string;
} {
  const toToken = new Map<string, string>();
  const toName = new Map<string, string>();
  for (const name of names) {
    if (toToken.has(name)) continue;
    const token = `c${toToken.size}`;
    toToken.set(name, token);
    toName.set(token, name);
  }
  return {
    token: (name) => toToken.get(name) ?? name,
    name: (token) => toName.get(token) ?? token,
  };
}

function readPredictions(
  bytes: Uint8Array | undefined,
  tool: string,
  decodeClass: (token: string) => string,
): Map<number, string> {
  if (!bytes) throw new Error(`${tool} did not write predictions.`);
  const csv = parseObiaCsv(new TextDecoder().decode(bytes));
  const idCol = csv.headers.indexOf(OBIA_SEGMENT_ID_FIELD);
  const classCol = csv.headers.indexOf("predicted_class");
  if (idCol < 0 || classCol < 0) throw new Error(`${tool} wrote an unexpected table.`);
  const predictions = new Map<number, string>();
  for (const row of csv.rows) {
    const token = row[classCol];
    // Skip a malformed row rather than storing a NaN or blank (0) id or an
    // undefined class.
    if (!row[idCol] || !token) continue;
    const id = Number(row[idCol]);
    if (!Number.isFinite(id)) continue;
    predictions.set(id, decodeClass(token));
  }
  return predictions;
}

/**
 * Classify every object with a random forest trained on the training samples
 * (`classify_objects_random_forest`; deterministic, the engine fixes its seed).
 *
 * @param table Object features.
 * @param samples Labeled objects; only training samples are used.
 * @param options Feature columns and number of trees.
 */
export async function classifyRandomForest(
  table: ObiaFeatureTable,
  samples: readonly ObiaSample[],
  options: { fields: readonly string[]; trees: number },
  run: ObiaRunOptions = {},
): Promise<ObiaClassification> {
  const training = samples.filter(
    (sample) => sample.role === "training" && table.rows.has(sample.segmentId),
  );
  const classNames = new Set(training.map((sample) => sample.className));
  if (classNames.size < 2) {
    throw new Error("Label training samples of at least two classes first.");
  }
  const { csv, fields, imputed } = featureTableCsv(table, options.fields);
  if (!fields.length) throw new Error("Choose at least one measured feature.");
  const tokens = classTokens([...classNames].sort());
  const trainingCsv = [
    `${OBIA_SEGMENT_ID_FIELD},class`,
    ...training.map((sample) => `${sample.segmentId},${tokens.token(sample.className)}`),
  ].join("\n");
  const tool = "classify_objects_random_forest";
  const args = [
    "--features=/work/features.csv",
    "--training=/work/training.csv",
    `--n_trees=${Math.max(10, Math.round(options.trees))}`,
    "--output=/work/predictions.csv",
  ];
  const encoder = new TextEncoder();
  const files = await runTool(
    tool,
    args,
    {
      "features.csv": encoder.encode(csv),
      "training.csv": encoder.encode(`${trainingCsv}\n`),
    },
    run,
  );
  return {
    predictions: readPredictions(files["predictions.csv"], tool, tokens.name),
    fields,
    imputed,
    trainingCount: training.length,
    call: { tool, args },
  };
}

/**
 * Train a random forest on one image's training samples and predict another
 * image's objects (batch processing). Both images' objects go into one table,
 * the target's ids shifted past the source's so they cannot collide; only the
 * source's training samples train the forest, and only target predictions are
 * returned (with their own ids).
 *
 * @param sourceTable Features of the image the samples were labeled on.
 * @param samples Labeled source objects; only training samples are used.
 * @param targetTable Features of the image to classify, measured the same way.
 * @param options Feature columns and number of trees.
 */
export async function classifyRandomForestTransfer(
  sourceTable: ObiaFeatureTable,
  samples: readonly ObiaSample[],
  targetTable: ObiaFeatureTable,
  options: { fields: readonly string[]; trees: number },
  run: ObiaRunOptions = {},
): Promise<ObiaClassification> {
  // The forest must see the same features on both images; a feature missing
  // from either would silently change what it was trained on.
  const missing = options.fields.filter(
    (field) => !sourceTable.fields.includes(field) || !targetTable.fields.includes(field),
  );
  if (missing.length || !options.fields.length) {
    throw new ObiaError(
      "missing-fields",
      `The image lacks ${missing.length} of the classifier's features (${missing.join(", ")}). Measure it with the same feature options.`,
      { count: missing.length },
    );
  }
  const fields = [...options.fields];
  const training = samples.filter((sample) => sample.role === "training");
  const trainingIds = new Set(training.map((sample) => sample.segmentId));
  // A loop, not Math.max(...ids): a large segmentation has more ids than a
  // call can take as arguments.
  let maxId = 0;
  for (const id of sourceTable.rows.keys()) if (id > maxId) maxId = id;
  const offset = maxId + 1;
  const rows = new Map<number, Record<string, number | null>>();
  // Only the labeled source objects are needed to train.
  for (const [id, row] of sourceTable.rows) if (trainingIds.has(id)) rows.set(id, row);
  for (const [id, row] of targetTable.rows) rows.set(id + offset, row);
  const result = await classifyRandomForest(
    { fields, rows },
    training,
    { fields, trees: options.trees },
    run,
  );
  const predictions = new Map<number, string>();
  for (const [id, name] of result.predictions) {
    if (id >= offset) predictions.set(id - offset, name);
  }
  return { ...result, predictions };
}

/**
 * Classify objects with ordered threshold rules (`classify_objects_rules_basic`):
 * each object gets the class of the first rule it satisfies, else the default.
 *
 * @param table Object features.
 * @param rules Rules in evaluation order.
 * @param defaultClass Class for objects no rule matches.
 */
export async function classifyByRules(
  table: ObiaFeatureTable,
  rules: readonly ObiaRule[],
  defaultClass: string,
  run: ObiaRunOptions = {},
): Promise<ObiaClassification> {
  if (!rules.length) throw new Error("Add at least one rule.");
  if (rules.some((rule) => !Number.isFinite(rule.value))) {
    throw new Error("Every rule needs a numeric value.");
  }
  const ruleFields = [...new Set(rules.map((rule) => rule.field))];
  const missing = ruleFields.filter((field) => !table.fields.includes(field));
  if (missing.length) throw new Error(`Not measured: ${missing.join(", ")}.`);
  // No imputation: an object with no value for a rule's feature (e.g. no GLCM
  // row) must not match that rule on the column mean.
  const { csv, fields, imputed } = featureTableCsv(table, ruleFields, { impute: false });
  const empty = ruleFields.filter((field) => !fields.includes(field));
  if (empty.length) throw new Error(`No object has a value for: ${empty.join(", ")}.`);
  const tokens = classTokens([...rules.map((rule) => rule.className), defaultClass]);
  const rulesCsv = [
    "feature,op,value,class",
    ...rules.map(
      (rule) => `${rule.field},${rule.op},${rule.value},${tokens.token(rule.className)}`,
    ),
  ].join("\n");
  const tool = "classify_objects_rules_basic";
  const args = [
    "--features=/work/features.csv",
    "--rules=/work/rules.csv",
    `--default_class=${tokens.token(defaultClass)}`,
    "--output=/work/predictions.csv",
  ];
  const encoder = new TextEncoder();
  const files = await runTool(
    tool,
    args,
    {
      "features.csv": encoder.encode(csv),
      "rules.csv": encoder.encode(`${rulesCsv}\n`),
    },
    run,
  );
  return {
    predictions: readPredictions(files["predictions.csv"], tool, tokens.name),
    fields,
    imputed,
    trainingCount: 0,
    call: { tool, args },
  };
}

/**
 * Write predicted classes onto the objects (`obia_predicted`); objects without
 * a prediction lose any earlier one.
 */
export function applyPredictions(
  objects: FeatureCollection,
  predictions: ReadonlyMap<number, string>,
): FeatureCollection {
  return {
    ...objects,
    features: objects.features.map((feature) => {
      const properties: Record<string, unknown> = { ...(feature.properties ?? {}) };
      const predicted = predictions.get(objectSegmentId(feature));
      if (predicted === undefined) delete properties[OBIA_PREDICTED_FIELD];
      else properties[OBIA_PREDICTED_FIELD] = predicted;
      return { ...feature, properties };
    }),
  };
}

// --- Accuracy assessment ----------------------------------------------------

/** Per-class accuracy figures. */
export interface ObiaClassAccuracy {
  className: string;
  /** Validation samples of this class (row total). */
  support: number;
  /** Producer's accuracy (recall): share of this class's samples predicted as it. */
  producers: number | null;
  /** User's accuracy (precision): share of objects predicted as this class that are it. */
  users: number | null;
  f1: number | null;
}

/** Accuracy of a classification against independent validation samples. */
export interface ObiaAccuracyReport {
  /** Class names, the order of the matrix rows (reference) and columns (predicted). */
  labels: string[];
  /** matrix[reference][predicted] = sample count. */
  matrix: number[][];
  sampleCount: number;
  overallAccuracy: number;
  kappa: number;
  perClass: ObiaClassAccuracy[];
  /** Overall accuracy with each sample weighted by its area, when areas are known. */
  areaWeightedAccuracy: number | null;
  /** Validation samples that had no prediction (not counted). */
  unpredicted: number;
}

const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

/**
 * Score predictions against validation samples: confusion matrix, overall
 * accuracy, Cohen's kappa, per-class producer's/user's accuracy and F1, and an
 * area-weighted overall accuracy.
 *
 * @param samples Labeled objects; only validation samples are scored.
 * @param predictions Predicted class per object.
 * @param areas Optional object areas (e.g. pixel counts) for the area-weighted score.
 * @param classOrder Preferred class order; other classes follow alphabetically.
 */
export function assessAccuracy(
  samples: readonly ObiaSample[],
  predictions: ReadonlyMap<number, string>,
  areas?: ReadonlyMap<number, number>,
  classOrder: readonly string[] = [],
): ObiaAccuracyReport {
  const scored: { reference: string; predicted: string; area: number | null }[] = [];
  let unpredicted = 0;
  for (const sample of samples) {
    if (sample.role !== "validation") continue;
    const predicted = predictions.get(sample.segmentId);
    if (predicted === undefined) {
      unpredicted += 1;
      continue;
    }
    scored.push({
      reference: sample.className,
      predicted,
      area: areas?.get(sample.segmentId) ?? null,
    });
  }
  const seen = new Set(scored.flatMap((s) => [s.reference, s.predicted]));
  const labels = [
    ...classOrder.filter((name) => seen.has(name)),
    ...[...seen].filter((name) => !classOrder.includes(name)).sort(),
  ];
  const index = new Map(labels.map((name, i) => [name, i]));
  const matrix = labels.map(() => labels.map(() => 0));
  for (const s of scored) matrix[index.get(s.reference)!][index.get(s.predicted)!] += 1;

  const n = scored.length;
  const diagonal = labels.reduce((sum, _, i) => sum + matrix[i][i], 0);
  const rowTotals = matrix.map((row) => row.reduce((a, b) => a + b, 0));
  const colTotals = labels.map((_, j) => matrix.reduce((sum, row) => sum + row[j], 0));
  const overallAccuracy = n ? diagonal / n : 0;
  const expected = n ? rowTotals.reduce((sum, r, i) => sum + r * colTotals[i], 0) / (n * n) : 0;
  const kappa = 1 - expected > 1e-12 ? (overallAccuracy - expected) / (1 - expected) : 0;

  const perClass = labels.map((className, i) => {
    const producers = ratio(matrix[i][i], rowTotals[i]);
    const users = ratio(matrix[i][i], colTotals[i]);
    const f1 =
      producers != null && users != null && producers + users > 0
        ? (2 * producers * users) / (producers + users)
        : null;
    return { className, support: rowTotals[i], producers, users, f1 };
  });

  let areaWeightedAccuracy: number | null = null;
  if (n && scored.every((s) => s.area != null)) {
    const total = scored.reduce((sum, s) => sum + (s.area ?? 0), 0);
    const correct = scored
      .filter((s) => s.reference === s.predicted)
      .reduce((sum, s) => sum + (s.area ?? 0), 0);
    areaWeightedAccuracy = total > 0 ? correct / total : null;
  }

  return {
    labels,
    matrix,
    sampleCount: n,
    overallAccuracy,
    kappa,
    perClass,
    areaWeightedAccuracy,
    unpredicted,
  };
}

/**
 * Quote a CSV cell holding user text (a class name). Cells with a quote,
 * comma or line break are quoted, and a leading `=`, `+`, `-`, `@`, tab or CR
 * gets an apostrophe so a spreadsheet opening the report does not run it as a
 * formula.
 */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The confusion matrix and per-class figures as CSV, for a report. */
export function accuracyReportCsv(report: ObiaAccuracyReport): string {
  const quote = csvCell;
  const pct = (value: number | null) => (value == null ? "" : value.toFixed(4));
  const lines = [
    ["reference / predicted", ...report.labels, "total", "producers_accuracy"].map(quote).join(","),
    ...report.labels.map((name, i) =>
      [
        quote(name),
        ...report.matrix[i],
        report.perClass[i].support,
        pct(report.perClass[i].producers),
      ].join(","),
    ),
    ["users_accuracy", ...report.perClass.map((c) => pct(c.users)), "", ""].join(","),
    "",
    `overall_accuracy,${report.overallAccuracy.toFixed(4)}`,
    `kappa,${report.kappa.toFixed(4)}`,
    `samples,${report.sampleCount}`,
  ];
  if (report.areaWeightedAccuracy != null) {
    lines.push(`area_weighted_accuracy,${report.areaWeightedAccuracy.toFixed(4)}`);
  }
  return `${lines.join("\n")}\n`;
}

// --- Export -----------------------------------------------------------------

/** One class of a classified raster. */
export interface ObiaLegendEntry {
  /** Pixel value (1-based; 0 is NoData). */
  code: number;
  className: string;
  color: string;
}

/** A classification burned onto the segmentation's pixel grid. */
export interface ObiaClassifiedRaster {
  /** Single-band uint8 GeoTIFF of class codes, 0 = NoData. */
  codes: Uint8Array;
  /** 3-band uint8 GeoTIFF in the class colors, 0 = NoData, for display. */
  rgb: Uint8Array;
  legend: ObiaLegendEntry[];
}

function hexToRgb(color: string): [number, number, number] {
  // The class color picker writes #rrggbb; accept the #rgb shorthand too.
  const match = color.trim().match(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/i);
  if (!match) return [128, 128, 128];
  const hex =
    match[1].length === 3 ? [...match[1]].map((digit) => digit + digit).join("") : match[1];
  const n = parseInt(hex, 16);
  // Keep every channel above 0 so a class color never reads as NoData.
  return [Math.max(1, (n >> 16) & 255), Math.max(1, (n >> 8) & 255), Math.max(1, n & 255)];
}

/**
 * Burn object predictions onto the label raster's grid: a class-code raster
 * for analysis and an RGB rendering in the class colors for display.
 *
 * @param labels Label raster from {@link segmentImage}.
 * @param predictions Predicted class per object.
 * @param classes Class colors; codes follow this order, then any other
 *   predicted class (e.g. a rules default class) alphabetically, in gray.
 */
export async function classifiedRaster(
  labels: Uint8Array,
  predictions: ReadonlyMap<number, string>,
  classes: readonly ObiaClass[],
): Promise<ObiaClassifiedRaster> {
  const grid = await readRasterData(toArrayBuffer(labels));
  // Codes follow the class list, predicted or not, so a code keeps its
  // meaning from run to run; other predicted names (a rules default) follow.
  const predicted = new Set(predictions.values());
  const names = [
    ...classes.map((cls) => cls.name),
    ...[...predicted].filter((name) => !classes.some((cls) => cls.name === name)).sort(),
  ];
  if (names.length > 255) throw new Error("A classified raster holds at most 255 classes.");
  const legend = names.map((className, i) => ({
    code: i + 1,
    className,
    color: classes.find((cls) => cls.name === className)?.color ?? "#9ca3af",
  }));
  const codeOf = new Map(legend.map((entry) => [entry.className, entry.code]));
  const objectCode = new Map<number, number>();
  for (const [id, name] of predictions) objectCode.set(id, codeOf.get(name) ?? 0);
  const rgbOf = legend.map((entry) => hexToRgb(entry.color));

  const pixels = grid.width * grid.height;
  const codes = new Uint8Array(pixels);
  const r = new Uint8Array(pixels);
  const g = new Uint8Array(pixels);
  const b = new Uint8Array(pixels);
  const band = grid.bands[0];
  for (let p = 0; p < pixels; p += 1) {
    const label = band[p];
    if (!(label > 0) || label === grid.nodata) continue;
    const code = objectCode.get(Math.round(label)) ?? 0;
    if (!code) continue;
    codes[p] = code;
    const [cr, cg, cb] = rgbOf[code - 1];
    r[p] = cr;
    g[p] = cg;
    b[p] = cb;
  }
  return {
    codes: new Uint8Array(writeUint8Bands(grid, [codes], 0)),
    rgb: new Uint8Array(writeUint8Bands(grid, [r, g, b], 0)),
    legend,
  };
}

/** The legend as CSV (`code,class,color`). */
export function legendCsv(legend: readonly ObiaLegendEntry[]): string {
  const rows = legend.map((e) => `${e.code},${csvCell(e.className)},${csvCell(e.color)}`);
  return `${["code,class,color", ...rows].join("\n")}\n`;
}
