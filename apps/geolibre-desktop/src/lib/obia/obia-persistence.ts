import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import {
  DEFAULT_OBIA_FEATURE_OPTIONS,
  DEFAULT_REGION_GROWING_PARAMS,
  OBIA_PREDICTED_FIELD,
  OBIA_RULE_OPS,
  OBIA_SEGMENT_ID_FIELD,
  countSegmentLabels,
  segmentLabels,
  type ObiaClass,
  type ObiaFeatureOptions,
  type ObiaFeatureTable,
  type ObiaRule,
  type ObiaRuleOp,
  type ObiaToolCall,
  type RegionGrowingParams,
} from "@geolibre/processing";
import type { FeatureCollection } from "geojson";
import {
  emptyObiaSession,
  useObiaSession,
  type ObiaClassificationRun,
  type ObiaClassifierSettings,
  type ObiaFeatureRun,
  type ObiaRunEnv,
  type ObiaSegmentationRun,
  type ObiaSessionData,
  type ObiaSplitRecord,
} from "./obia-session";
import { obiaSourceBands } from "./obia-source";

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
  const segmentation = data.segmentation
    ? (() => {
        const { labels: _labels, ...rest } = data.segmentation;
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
  return JSON.parse(
    JSON.stringify({
      version: OBIA_STATE_VERSION,
      settings: {
        sourceLayerId: data.sourceLayerId,
        bandIndexes: data.bandIndexes,
        params: data.params,
        featureOptions: data.featureOptions,
        classes: data.classes,
        labelRole: data.labelRole,
        classifier: data.classifier,
      },
      runs: {
        segmentation,
        features,
        classification,
        splits: data.splits,
      },
    }),
  ) as Record<string, unknown>;
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

function restoreParams(value: unknown): RegionGrowingParams {
  const json = asObject(value) ?? {};
  const base = DEFAULT_REGION_GROWING_PARAMS;
  return {
    threshold: asNumber(json.threshold, base.threshold),
    minArea: asNumber(json.minArea, base.minArea),
    steps: asNumber(json.steps, base.steps),
  };
}

function restoreFeatureOptions(value: unknown): ObiaFeatureOptions {
  const json = asObject(value) ?? {};
  const base = DEFAULT_OBIA_FEATURE_OPTIONS;
  const indices = asObject(json.indices);
  const band = (key: string) =>
    indices && Number.isInteger(indices[key]) ? (indices[key] as number) : undefined;
  return {
    spectral: typeof json.spectral === "boolean" ? json.spectral : base.spectral,
    shape: typeof json.shape === "boolean" ? json.shape : base.shape,
    context: typeof json.context === "boolean" ? json.context : base.context,
    ...(Number.isInteger(json.textureBand) ? { textureBand: json.textureBand as number } : {}),
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
    method: json.method === "rules" ? "rules" : base.method,
    trees: asNumber(json.trees, base.trees),
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
    params: restoreParams(settings.params),
    featureOptions: restoreFeatureOptions(settings.featureOptions),
    classes: restoreClasses(settings.classes),
    labelRole: settings.labelRole === "validation" ? "validation" : "training",
    classifier: restoreClassifier(settings.classifier),
  };

  const seg = asObject(runs.segmentation);
  const objectsLayer = seg
    ? layers.find((layer) => layer.id === seg.objectsLayerId && layer.geojson)
    : undefined;
  if (!seg || !objectsLayer?.geojson) return data;
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
    labels: null,
    objectsLayerId: objectsLayer.id,
    objectCount: asNumber(seg.objectCount, 0),
    meanObjectArea: asNumber(seg.meanObjectArea, 0),
    tool: asString(seg.tool),
    args: asStrings(seg.args),
    params: restoreParams(seg.params),
    env: restoreEnv(seg.env),
    finishedAt: asString(seg.finishedAt),
  };
  data.segmentation = segmentation;
  data.splits = restoreSplits(runs.splits);

  const feat = asObject(runs.features);
  if (!feat || feat.segmentationAt !== segmentation.finishedAt) return data;
  const features: ObiaFeatureRun = {
    segmentationAt: segmentation.finishedAt,
    table: featureTableFromObjects(objectsLayer.geojson, asStrings(feat.fields)),
    options: restoreFeatureOptions(feat.options),
    calls: restoreCalls(feat.calls),
    env: restoreEnv(feat.env),
    finishedAt: asString(feat.finishedAt),
  };
  data.features = features;

  const cls = asObject(runs.classification);
  if (!cls || cls.featuresAt !== features.finishedAt) return data;
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
  data.classification = classification;
  return data;
}

/**
 * The label raster of the current segmentation. After a project reload it is
 * rebuilt by re-running the recorded segmentation on the source image, and
 * checked against the recorded object count so a changed image is caught.
 *
 * @throws When the source image is gone or no longer gives the same objects.
 */
export async function ensureObiaLabels(): Promise<Uint8Array> {
  const segmentation = useObiaSession.getState().segmentation;
  if (!segmentation) throw new Error("Segment an image first.");
  if (segmentation.labels) return segmentation.labels;
  const source = useAppStore
    .getState()
    .layers.find((layer) => layer.id === segmentation.sourceLayerId);
  if (!source) throw new ObiaRestoreError("source-missing");
  const image = await obiaSourceBands(source, segmentation.bandIndexes);
  if (!image) throw new ObiaRestoreError("source-missing");
  const { labels } = await segmentLabels(image, segmentation.params);
  if ((await countSegmentLabels(labels)) !== segmentation.objectCount) {
    throw new ObiaRestoreError("source-changed");
  }
  useObiaSession.getState().setSegmentationLabels(segmentation.finishedAt, labels);
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
