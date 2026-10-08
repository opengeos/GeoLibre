import type { Feature, FeatureCollection, MultiPolygon, Polygon, Position } from "geojson";
import { fromArrayBuffer } from "geotiff";
import { readRasterData, writeRasterBands } from "./raster-client";
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
export type ObiaErrorCode = "image-too-large" | "no-such-band" | "no-bands";

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
      `This image has ${width} x ${height} pixels, more than the ${OBIA_MAX_PIXELS.toLocaleString("en-US")} the in-browser workbench handles. Clip it to a smaller area first.`,
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

async function runTool(
  tool: string,
  args: string[],
  input: Record<string, Uint8Array>,
): Promise<Record<string, Uint8Array>> {
  const result = await runWasmToolInBackground({ tool, args, input });
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
 * Segment an image into objects with seeded region growing and polygonize the
 * labels. Runs entirely in the browser.
 *
 * @param image Bands from {@link splitImageBands}.
 * @param params Region-growing parameters.
 */
export async function segmentImage(
  image: ObiaImage,
  params: RegionGrowingParams,
): Promise<ObiaSegmentation> {
  if (!image.bands.length) {
    throw new ObiaError("no-bands", "Choose at least one band to segment.");
  }
  const { paths, input } = stageBands(image.bands);
  const tool = "image_segmentation";
  const args = regionGrowingArgs(paths, params);
  const files = await runTool(tool, args, input);
  const labels = files["segments.tif"];
  if (!labels) throw new Error(`${tool} did not write a segment raster.`);

  const polygonFiles = await runTool(
    "segments_to_polygons",
    ["--segments=/work/segments.tif", "--output=/work/segments.geojson"],
    { "segments.tif": labels },
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
    const out = await runTool(tool, args, files);
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
  const files = await runTool(tool, args, {
    "features.csv": encoder.encode(csv),
    "training.csv": encoder.encode(`${trainingCsv}\n`),
  });
  return {
    predictions: readPredictions(files["predictions.csv"], tool, tokens.name),
    fields,
    imputed,
    trainingCount: training.length,
    call: { tool, args },
  };
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
): Promise<ObiaClassification> {
  if (!rules.length) throw new Error("Add at least one rule.");
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
  const files = await runTool(tool, args, {
    "features.csv": encoder.encode(csv),
    "rules.csv": encoder.encode(`${rulesCsv}\n`),
  });
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
