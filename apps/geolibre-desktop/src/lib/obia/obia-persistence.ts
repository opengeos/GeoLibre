import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import {
  DEFAULT_OBIA_FEATURE_OPTIONS,
  DEFAULT_REGION_GROWING_PARAMS,
  OBIA_MAX_PIXELS,
  OBIA_PREDICTED_FIELD,
  OBIA_RULE_OPS,
  OBIA_SEGMENT_ID_FIELD,
  decodeLabelGrid,
  encodeLabelGrid,
  fingerprintSegmentLabels,
  relabelGrid,
  segmentLabels,
  type ObiaClass,
  type ObiaFeatureOptions,
  type ObiaFeatureTable,
  type ObiaRule,
  type ObiaReadArea,
  type ObiaRunOptions,
  type ObiaRuleOp,
  type ObiaToolCall,
  type RegionGrowingParams,
} from "@geolibre/processing";
import type { FeatureCollection } from "geojson";
import {
  OBIA_MAX_LEVELS,
  emptyObiaSession,
  useObiaSession,
  type ObiaBatchRun,
  type ObiaClassificationRun,
  type ObiaClassifierSettings,
  type ObiaFeatureRun,
  type ObiaRunEnv,
  type ObiaLevelMerge,
  type ObiaLevelRecord,
  type ObiaSegmentationRun,
  type ObiaSessionData,
  type ObiaSplitRecord,
} from "./obia-session";
import { obiaSourceBands } from "./obia-source";
import {
  DEFAULT_OBIA_NATIVE_PARAMS,
  isNativeMethod,
  nativeSegmentation,
  obiaLocalPath,
  runNativeSegmentation,
  type ObiaMethod,
  type ObiaNativeParams,
} from "./obia-native";

/**
 * Saving the Object-Based Analysis workbench with the project (#3053).
 *
 * The project's `obia` field holds the workbench settings and the provenance
 * of its last runs: the tool calls, parameters, seeds and engine versions
 * behind the segmentation, measurement and classification. Bulk results are
 * not duplicated: features and predictions already live on the objects layer
 * (saved with the project), and the label raster is rebuilt on demand by
 * re-running the deterministic segmentation ({@link ensureObiaLabels}).
 */

/** Version of the saved `obia` object. */
export const OBIA_STATE_VERSION = 1;

/** The property on a level's objects naming each one's parent in the level above. */
export const OBIA_PARENT_FIELD = "obia_parent";

/** The engine and app versions a run happens under. */
export function obiaRunEnv(): ObiaRunEnv {
  return {
    engineVersion:
      typeof __GEOLIBRE_WASM_VERSION__ === "string" ? __GEOLIBRE_WASM_VERSION__ : "unknown",
    appVersion: typeof __GEOLIBRE_VERSION__ === "string" ? __GEOLIBRE_VERSION__ : "unknown",
  };
}

/**
 * Where a layer's data comes from (file path or URL), for provenance. Blob
 * URLs are session-only, so they are not recorded.
 */
export function obiaLayerLocation(layer: GeoLibreLayer): string | undefined {
  const url = (layer.source as { url?: unknown }).url;
  const candidates = [layer.sourcePath, typeof url === "string" ? url : undefined];
  return candidates.find((value) => value && !value.startsWith("blob:"));
}

/** Whether the session holds anything worth saving with the project. */
function hasContent(data: ObiaSessionData): boolean {
  return Boolean(data.segmentation || data.classes.length);
}

/**
 * The saved form of a session: settings plus run provenance, without the
 * label raster, feature table or predictions (see the module comment).
 *
 * @param data Session data.
 * @returns The `obia` object, or null when there is nothing to save yet.
 */
export function snapshotObiaSession(data: ObiaSessionData): Record<string, unknown> | null {
  if (!hasContent(data)) return null;
  return JSON.parse(
    JSON.stringify({
      version: OBIA_STATE_VERSION,
      settings: {
        sourceLayerId: data.sourceLayerId,
        bandIndexes: data.bandIndexes,
        areaMode: data.areaMode,
        method: data.method,
        params: data.params,
        nativeParams: data.nativeParams,
        featureOptions: data.featureOptions,
        classes: data.classes,
        labelRole: data.labelRole,
        classifier: data.classifier,
      },
      runs: { ...levelRuns(data), batches: data.batches },
      // The hierarchy: the level the steps work on, and the other levels.
      level: data.level,
      levels: data.levels.map((record) => ({ level: record.level, runs: levelRuns(record) })),
    }),
  ) as Record<string, unknown>;
}

/** One level's runs as saved: provenance, not labels, tables or predictions. */
function levelRuns(
  data: Pick<ObiaSessionData, "segmentation" | "features" | "classification" | "splits">,
) {
  const segmentation = data.segmentation
    ? (() => {
        const { labels: _labels, nativeJobId: _job, ...rest } = data.segmentation;
        return rest;
      })()
    : null;
  const features = data.features
    ? {
        segmentationAt: data.features.segmentationAt,
        fields: data.features.table.fields,
        options: data.features.options,
        calls: data.features.calls,
        env: data.features.env,
        finishedAt: data.features.finishedAt,
      }
    : null;
  const classification = data.classification
    ? {
        settings: data.classification.settings,
        fields: data.classification.fields,
        imputed: data.classification.imputed,
        trainingCount: data.classification.trainingCount,
        call: data.classification.call,
        featuresAt: data.classification.featuresAt,
        env: data.classification.env,
        finishedAt: data.classification.finishedAt,
      }
    : null;
  return { segmentation, features, classification, splits: data.splits };
}

// --- Restore: every field is checked, since a project file is untrusted ------

type Json = Record<string, unknown>;

const asObject = (value: unknown): Json | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
const asString = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;
const asNumber = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const asBands = (value: unknown): number[] =>
  Array.isArray(value)
    ? value.filter((item): item is number => Number.isInteger(item) && item >= 1)
    : [];

/**
 * A saved number within the range the workbench's inputs allow: the file is
 * untrusted, and these values go straight to the engine's tools.
 */
function inRange(value: unknown, fallback: number, min: number, max: number, integer = false) {
  const n = asNumber(value, fallback);
  const clamped = Math.min(max, Math.max(min, integer ? Math.round(n) : n));
  return Number.isFinite(clamped) ? clamped : fallback;
}

/** A saved 1-based band index, if it is one. */
const asBandIndex = (value: unknown) =>
  Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 4096
    ? (value as number)
    : undefined;

/**
 * A saved read area: a non-negative level and an integer pixel window with
 * positive size, or undefined (the whole image at full resolution).
 */
function restoreArea(value: unknown): ObiaReadArea | undefined {
  const json = asObject(value);
  const window = Array.isArray(json?.window) ? json.window : [];
  if (
    !json ||
    !Number.isInteger(json.level) ||
    (json.level as number) < 0 ||
    (json.level as number) > 32 ||
    window.length !== 4 ||
    !window.every((n) => Number.isInteger(n) && n >= 0)
  ) {
    return undefined;
  }
  const [x0, y0, x1, y1] = window as number[];
  if (x1 <= x0 || y1 <= y0) return undefined;
  return { level: json.level as number, window: [x0, y0, x1, y1] };
}

const restoreMethod = (value: unknown): ObiaMethod | undefined =>
  value === "region-growing" || value === "slic" || value === "felzenszwalb" ? value : undefined;

function restoreNativeParams(value: unknown): ObiaNativeParams {
  const json = asObject(value) ?? {};
  const slic = asObject(json.slic) ?? {};
  const felz = asObject(json.felzenszwalb) ?? {};
  const base = DEFAULT_OBIA_NATIVE_PARAMS;
  // The sidecar's accepted ranges.
  return {
    slic: {
      size: inRange(slic.size, base.slic.size, 4, 1_000_000, true),
      compactness: inRange(slic.compactness, base.slic.compactness, 0.001, 1000),
    },
    felzenszwalb: {
      scale: inRange(felz.scale, base.felzenszwalb.scale, 0.001, 100_000),
      sigma: inRange(felz.sigma, base.felzenszwalb.sigma, 0, 20),
      minSize: inRange(felz.minSize, base.felzenszwalb.minSize, 1, 1_000_000, true),
    },
  };
}

/**
 * How a saved coarser level was built: only from a level below it, so a
 * crafted file cannot make the label rebuild loop.
 */
function restoreMerge(value: unknown, level: number): ObiaLevelMerge | undefined {
  const json = asObject(value);
  if (
    !json ||
    !Number.isInteger(json.fromLevel) ||
    (json.fromLevel as number) < 1 ||
    (json.fromLevel as number) >= level
  ) {
    return undefined;
  }
  return {
    fromLevel: json.fromLevel as number,
    scale: inRange(json.scale, 1, 0, 1_000_000),
    bands: asBands(json.bands),
  };
}

/** A saved run's `area` and `pixelSize`, each only when valid. */
function restoreAreaFields(json: Json): { area?: ObiaReadArea; pixelSize?: number } {
  const area = restoreArea(json.area);
  const pixelSize = json.pixelSize;
  return {
    ...(area ? { area } : {}),
    ...(typeof pixelSize === "number" && pixelSize > 0 ? { pixelSize } : {}),
  };
}

function restoreParams(value: unknown): RegionGrowingParams {
  const json = asObject(value) ?? {};
  const base = DEFAULT_REGION_GROWING_PARAMS;
  // The Segment step's input ranges.
  return {
    threshold: inRange(json.threshold, base.threshold, 0.05, 5),
    minArea: inRange(json.minArea, base.minArea, 1, OBIA_MAX_PIXELS, true),
    steps: inRange(json.steps, base.steps, 1, 50, true),
  };
}

function restoreFeatureOptions(value: unknown): ObiaFeatureOptions {
  const json = asObject(value) ?? {};
  const base = DEFAULT_OBIA_FEATURE_OPTIONS;
  const indices = asObject(json.indices);
  const band = (key: string) => (indices ? asBandIndex(indices[key]) : undefined);
  const textureBand = asBandIndex(json.textureBand);
  return {
    spectral: typeof json.spectral === "boolean" ? json.spectral : base.spectral,
    shape: typeof json.shape === "boolean" ? json.shape : base.shape,
    context: typeof json.context === "boolean" ? json.context : base.context,
    ...(textureBand ? { textureBand } : {}),
    ...(indices ? { indices: { red: band("red"), green: band("green"), nir: band("nir") } } : {}),
  };
}

function restoreClasses(value: unknown): ObiaClass[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const classes: ObiaClass[] = [];
  for (const item of value) {
    const json = asObject(item);
    const name = asString(json?.name).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    classes.push({ name, color: asString(json?.color, "#64748b") });
  }
  return classes;
}

function restoreRules(value: unknown): ObiaRule[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const json = asObject(item);
    const op = asString(json?.op) as ObiaRuleOp;
    if (!json || !OBIA_RULE_OPS.includes(op)) return [];
    return [
      {
        field: asString(json.field),
        op,
        value: asNumber(json.value, 0),
        className: asString(json.className),
      },
    ];
  });
}

function restoreClassifier(value: unknown): ObiaClassifierSettings {
  const json = asObject(value) ?? {};
  const base = emptyObiaSession().classifier;
  return {
    method: json.method === "rules" || json.method === "inherit" ? json.method : base.method,
    // The Classify step's input range.
    trees: inRange(json.trees, base.trees, 10, 1000, true),
    fields: Array.isArray(json.fields) ? asStrings(json.fields) : null,
    rules: restoreRules(json.rules),
    defaultClass: asString(json.defaultClass, base.defaultClass),
  };
}

function restoreCalls(value: unknown): ObiaToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const json = asObject(item);
    return json && typeof json.tool === "string"
      ? [{ tool: json.tool, args: asStrings(json.args) }]
      : [];
  });
}

function restoreEnv(value: unknown): ObiaRunEnv {
  const json = asObject(value) ?? {};
  return {
    engineVersion: asString(json.engineVersion, "unknown"),
    appVersion: asString(json.appVersion, "unknown"),
  };
}

function restoreBatches(value: unknown, layers: readonly GeoLibreLayer[]): ObiaBatchRun[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const json = asObject(item);
    // Keep a batch run only while its objects layer is still in the project.
    if (!json || !layers.some((layer) => layer.id === json.objectsLayerId)) return [];
    const source = asObject(json.source);
    const classCounts: Record<string, number> = {};
    for (const [name, count] of Object.entries(asObject(json.classCounts) ?? {})) {
      if (typeof count === "number") classCounts[name] = count;
    }
    return [
      {
        targetLayerId: asString(json.targetLayerId),
        source: {
          name: asString(source?.name),
          ...(typeof source?.location === "string" ? { location: source.location } : {}),
        },
        ...restoreAreaFields(json),
        objectsLayerId: asString(json.objectsLayerId),
        objectCount: asNumber(json.objectCount, 0),
        classCounts,
        calls: restoreCalls(json.calls),
        env: restoreEnv(json.env),
        finishedAt: asString(json.finishedAt),
      },
    ];
  });
}

function restoreSplits(value: unknown): ObiaSplitRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const json = asObject(item);
    return json
      ? [
          {
            fraction: asNumber(json.fraction, 0),
            seed: asNumber(json.seed, 0),
            moved: asNumber(json.moved, 0),
            at: asString(json.at),
          },
        ]
      : [];
  });
}

const segmentIdOf = (feature: FeatureCollection["features"][number]) =>
  Number(feature.properties?.[OBIA_SEGMENT_ID_FIELD] ?? feature.id);

/** Rebuild a feature table from the values the Measure step wrote on the objects. */
export function featureTableFromObjects(
  objects: FeatureCollection,
  fields: readonly string[],
): ObiaFeatureTable {
  const rows = new Map<number, Record<string, number | null>>();
  for (const feature of objects.features) {
    const id = segmentIdOf(feature);
    if (!Number.isFinite(id)) continue;
    const record: Record<string, number | null> = {};
    for (const field of fields) {
      const value = feature.properties?.[field];
      record[field] = typeof value === "number" && Number.isFinite(value) ? value : null;
    }
    rows.set(id, record);
  }
  return { fields: [...fields], rows };
}

/** Rebuild predictions from the classes the Classify step wrote on the objects. */
export function predictionsFromObjects(objects: FeatureCollection): Map<number, string> {
  const predictions = new Map<number, string>();
  for (const feature of objects.features) {
    const id = segmentIdOf(feature);
    const predicted = feature.properties?.[OBIA_PREDICTED_FIELD];
    if (Number.isFinite(id) && typeof predicted === "string" && predicted) {
      predictions.set(id, predicted);
    }
  }
  return predictions;
}

/**
 * Turn a saved `obia` object back into session data. Runs are restored only
 * while what they describe still exists: a segmentation needs its objects
 * layer, features need that segmentation, a classification needs those
 * features. Anything unrecognised falls back to defaults.
 *
 * @param saved The project's `obia` value (or null for a fresh session).
 * @param layers The project's layers.
 */
export function restoreObiaSession(
  saved: Record<string, unknown> | null,
  layers: readonly GeoLibreLayer[],
): ObiaSessionData {
  const empty = emptyObiaSession();
  if (!saved || saved.version !== OBIA_STATE_VERSION) return empty;
  const settings = asObject(saved.settings) ?? {};
  const runs = asObject(saved.runs) ?? {};
  const data: ObiaSessionData = {
    ...empty,
    sourceLayerId: asString(settings.sourceLayerId),
    bandIndexes: asBands(settings.bandIndexes),
    areaMode: settings.areaMode === "view" ? "view" : "image",
    method: restoreMethod(settings.method) ?? "region-growing",
    params: restoreParams(settings.params),
    nativeParams: restoreNativeParams(settings.nativeParams),
    featureOptions: restoreFeatureOptions(settings.featureOptions),
    classes: restoreClasses(settings.classes),
    labelRole: settings.labelRole === "validation" ? "validation" : "training",
    classifier: restoreClassifier(settings.classifier),
  };

  const activeLevel =
    Number.isInteger(saved.level) &&
    (saved.level as number) >= 1 &&
    (saved.level as number) <= OBIA_MAX_LEVELS
      ? (saved.level as number)
      : 1;
  const active = restoreLevel(runs, layers, activeLevel);
  if (!active) return data;
  // The hierarchy: each saved level whose objects layer is still there.
  const levels: ObiaLevelRecord[] = [];
  if (Array.isArray(saved.levels)) {
    for (const item of saved.levels) {
      const json = asObject(item);
      const level = json && Number.isInteger(json.level) ? (json.level as number) : 0;
      if (level < 1 || level > OBIA_MAX_LEVELS) continue;
      const record = restoreLevel(asObject(json!.runs) ?? {}, layers, level);
      if (record && !levels.some((other) => other.level === level)) levels.push(record);
    }
  }
  return {
    ...data,
    segmentation: active.segmentation,
    features: active.features,
    classification: active.classification,
    splits: active.splits,
    batches: restoreBatches(runs.batches, layers),
    level: active.level,
    levels: levels
      .filter((record) => record.level !== active.level)
      .sort((a, b) => a.level - b.level),
  };
}

/**
 * One saved level's runs, kept while what they describe still exists: a
 * segmentation needs its objects layer, features need that segmentation, a
 * classification needs those features.
 */
function restoreLevel(
  runs: Json,
  layers: readonly GeoLibreLayer[],
  level: number,
): ObiaLevelRecord | null {
  const seg = asObject(runs.segmentation);
  const objectsLayer = seg
    ? layers.find((layer) => layer.id === seg.objectsLayerId && layer.geojson)
    : undefined;
  if (!seg || !objectsLayer?.geojson) return null;
  const source = asObject(seg.source);
  const segmentation: ObiaSegmentationRun = {
    sourceLayerId: asString(seg.sourceLayerId),
    sourceName: asString(seg.sourceName),
    source: {
      name: asString(source?.name, asString(seg.sourceName)),
      ...(typeof source?.location === "string" ? { location: source.location } : {}),
    },
    bandIndexes: asBands(seg.bandIndexes),
    width: asNumber(seg.width, 0),
    height: asNumber(seg.height, 0),
    ...restoreAreaFields(seg),
    ...(restoreMethod(seg.method) ? { method: restoreMethod(seg.method) } : {}),
    ...(seg.nativeParams ? { nativeParams: restoreNativeParams(seg.nativeParams) } : {}),
    labels: null,
    objectsLayerId: objectsLayer.id,
    objectCount: asNumber(seg.objectCount, 0),
    ...(typeof seg.labelsHash === "string" ? { labelsHash: seg.labelsHash } : {}),
    meanObjectArea: asNumber(seg.meanObjectArea, 0),
    tool: asString(seg.tool),
    args: asStrings(seg.args),
    params: restoreParams(seg.params),
    env: restoreEnv(seg.env),
    finishedAt: asString(seg.finishedAt),
    ...(restoreMerge(seg.merge, level) ? { merge: restoreMerge(seg.merge, level) } : {}),
  };
  const record: ObiaLevelRecord = {
    level,
    segmentation,
    features: null,
    classification: null,
    splits: restoreSplits(runs.splits),
  };

  const feat = asObject(runs.features);
  if (!feat || feat.segmentationAt !== segmentation.finishedAt) return record;
  const features: ObiaFeatureRun = {
    segmentationAt: segmentation.finishedAt,
    table: featureTableFromObjects(objectsLayer.geojson, asStrings(feat.fields)),
    options: restoreFeatureOptions(feat.options),
    calls: restoreCalls(feat.calls),
    env: restoreEnv(feat.env),
    finishedAt: asString(feat.finishedAt),
  };
  record.features = features;

  const cls = asObject(runs.classification);
  if (!cls || cls.featuresAt !== features.finishedAt) return record;
  const imputed: Record<string, number> = {};
  for (const [field, count] of Object.entries(asObject(cls.imputed) ?? {})) {
    if (typeof count === "number") imputed[field] = count;
  }
  const call = restoreCalls([cls.call])[0] ?? { tool: "", args: [] };
  const classification: ObiaClassificationRun = {
    predictions: predictionsFromObjects(objectsLayer.geojson),
    fields: asStrings(cls.fields),
    imputed,
    trainingCount: asNumber(cls.trainingCount, 0),
    call,
    settings: restoreClassifier(cls.settings),
    featuresAt: features.finishedAt,
    env: restoreEnv(cls.env),
    finishedAt: asString(cls.finishedAt),
  };
  record.classification = classification;
  return record;
}

/**
 * The label raster of the current segmentation. After a project reload it is
 * rebuilt by re-running the recorded segmentation on the source image, and
 * checked against the recorded object count so a changed image is caught.
 *
 * @throws When the source image is gone or no longer gives the same objects.
 */
export async function ensureObiaLabels(run: ObiaRunOptions = {}): Promise<Uint8Array> {
  const segmentation = useObiaSession.getState().segmentation;
  if (!segmentation) throw new Error("Segment an image first.");
  if (segmentation.labels) return segmentation.labels;
  // A cancellable rebuild runs on its own, so one step's Cancel cannot stop
  // another's; rebuilds without a signal share one.
  if (run.signal) return rebuildLabels(segmentation, run);
  if (rebuilding?.finishedAt === segmentation.finishedAt) return rebuilding.promise;
  const promise = rebuildLabels(segmentation, run);
  rebuilding = { finishedAt: segmentation.finishedAt, promise };
  try {
    return await promise;
  } finally {
    if (rebuilding?.promise === promise) rebuilding = null;
  }
}

let rebuilding: { finishedAt: string; promise: Promise<Uint8Array> } | null = null;

async function rebuildLabels(
  segmentation: ObiaSegmentationRun,
  run: ObiaRunOptions,
): Promise<Uint8Array> {
  const labels = await verifiedLabels(segmentation, run);
  useObiaSession.getState().setSegmentationLabels(segmentation.finishedAt, labels);
  return labels;
}

/**
 * A level's labels rebuilt (segmented again, or merged from the level below)
 * and checked against the fingerprint saved with it.
 *
 * @throws ObiaRestoreError("source-changed") when they no longer match.
 */
async function verifiedLabels(
  segmentation: ObiaSegmentationRun,
  run: ObiaRunOptions,
): Promise<Uint8Array> {
  const labels = segmentation.merge
    ? await mergedLabels(segmentation.merge, run)
    : await segmentedLabels(segmentation, run);
  const { objectCount, hash } = await fingerprintSegmentLabels(labels);
  if (
    objectCount !== segmentation.objectCount ||
    (segmentation.labelsHash !== undefined && hash !== segmentation.labelsHash)
  ) {
    throw new ObiaRestoreError("source-changed");
  }
  return labels;
}

/**
 * A coarser level's labels: the level below's, relabeled with each object's
 * parent, which the level below's objects layer records in `obia_parent`.
 */
async function mergedLabels(merge: ObiaLevelMerge, run: ObiaRunOptions): Promise<Uint8Array> {
  const state = useObiaSession.getState();
  // The level below is stashed while a coarser one is active, and active
  // when this rebuilds a stashed coarser level.
  const child =
    state.levels.find((record) => record.level === merge.fromLevel) ??
    (state.level === merge.fromLevel && state.segmentation
      ? { level: state.level, segmentation: state.segmentation }
      : undefined);
  const childLayer = child
    ? useAppStore.getState().layers.find((layer) => layer.id === child.segmentation.objectsLayerId)
    : undefined;
  if (!child || !childLayer?.geojson) throw new ObiaRestoreError("source-missing");
  let childLabels = child.segmentation.labels;
  if (!childLabels) {
    childLabels = await verifiedLabels(child.segmentation, run);
    // Keep them, so the next rebuild above does not redo the chain below.
    useObiaSession
      .getState()
      .setLevelLabels(child.level, child.segmentation.finishedAt, childLabels);
  }
  const parentOf = new Map<number, number>();
  for (const feature of childLayer.geojson.features) {
    const id = Number(feature.properties?.[OBIA_SEGMENT_ID_FIELD] ?? feature.id);
    const parent = Number(feature.properties?.[OBIA_PARENT_FIELD]);
    if (Number.isFinite(id) && parent > 0) parentOf.set(id, parent);
  }
  const grid = await decodeLabelGrid(childLabels);
  return encodeLabelGrid(grid, relabelGrid(grid, parentOf));
}

/** Level 1's labels: the recorded segmentation run again on the source image. */
async function segmentedLabels(
  segmentation: ObiaSegmentationRun,
  run: ObiaRunOptions,
): Promise<Uint8Array> {
  const source = useAppStore
    .getState()
    .layers.find((layer) => layer.id === segmentation.sourceLayerId);
  if (!source) throw new ObiaRestoreError("source-missing");
  let labels: Uint8Array;
  if (isNativeMethod(segmentation.method)) {
    // Natively segmented: the sidecar runs the same deterministic method.
    const path = obiaLocalPath(source);
    if (!path) throw new ObiaRestoreError("source-missing");
    const request = nativeSegmentation(
      path,
      segmentation.bandIndexes,
      segmentation.area,
      segmentation.method,
      segmentation.nativeParams ?? DEFAULT_OBIA_NATIVE_PARAMS,
    );
    ({ labels } = await runNativeSegmentation(request, run));
  } else {
    const image = await obiaSourceBands(source, segmentation.bandIndexes, segmentation.area);
    if (!image) throw new ObiaRestoreError("source-missing");
    ({ labels } = await segmentLabels(image, segmentation.params, run));
  }
  return labels;
}

/** Why saved objects could not be matched to their image again. */
export class ObiaRestoreError extends Error {
  readonly code: "source-missing" | "source-changed";

  constructor(code: "source-missing" | "source-changed") {
    super(
      code === "source-missing"
        ? "The image these objects were segmented from is no longer in the project. Segment again."
        : "The image no longer segments into the same objects (it changed since). Segment again.",
    );
    this.name = "ObiaRestoreError";
    this.code = code;
  }
}

let installed = false;
// The last value this module wrote to (or read from) the project, so a store
// change it caused itself is not mistaken for a project being opened.
let lastSynced: Record<string, unknown> | null = null;
let lastSyncedJson = "null";

function hydrateFromProject(): void {
  const { obiaWorkbench, layers } = useAppStore.getState();
  const data = restoreObiaSession(obiaWorkbench, layers);
  lastSynced = obiaWorkbench;
  lastSyncedJson = JSON.stringify(snapshotObiaSession(data));
  useObiaSession.getState().restore(data);
}

/**
 * Keep the workbench session and the project's `obia` field in step: restore
 * the session from the project now and whenever another project is opened,
 * and write the session back (marking the project dirty) when the user
 * changes it. Idempotent; installed when the workbench first loads.
 */
export function installObiaPersistence(): void {
  if (installed) return;
  installed = true;
  hydrateFromProject();
  useObiaSession.subscribe((state) => {
    const snapshot = snapshotObiaSession(state);
    const json = JSON.stringify(snapshot);
    if (json === lastSyncedJson) return;
    lastSyncedJson = json;
    lastSynced = snapshot;
    useAppStore.getState().setObiaWorkbench(snapshot, true);
  });
  useAppStore.subscribe((state, previous) => {
    const projectChanged = state.projectGeneration !== previous.projectGeneration;
    if (state.obiaWorkbench === lastSynced && !projectChanged) return;
    if (state.obiaWorkbench === previous.obiaWorkbench && !projectChanged) return;
    hydrateFromProject();
  });
}
