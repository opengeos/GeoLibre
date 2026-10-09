import {
  DEFAULT_OBIA_FEATURE_OPTIONS,
  DEFAULT_REGION_GROWING_PARAMS,
  type ObiaClass,
  type ObiaClassification,
  type ObiaRule,
  type ObiaFeatureOptions,
  type ObiaSampleRole,
  type ObiaFeatureTable,
  type ObiaReadArea,
  type ObiaToolCall,
  type RegionGrowingParams,
} from "@geolibre/processing";
import { create } from "zustand";
import { DEFAULT_OBIA_NATIVE_PARAMS, type ObiaMethod, type ObiaNativeParams } from "./obia-native";

/**
 * Add GeoTIFF bytes to the map as a raster layer, optionally with an initial
 * renderer state (e.g. a fixed 0-255 rescale so class colors show unstretched).
 */
export type ObiaAddRaster = (
  bytes: Uint8Array,
  name: string,
  fileName?: string,
  state?: { mode?: "rgb"; bands?: number[]; rescale?: [number, number][] },
) => Promise<void>;

/** Software that produced a run, for provenance. */
export interface ObiaRunEnv {
  /** `geolibre-wasm` tool engine version. */
  engineVersion: string;
  /** GeoLibre app version. */
  appVersion: string;
}

/** Where a segmentation's image came from, for provenance. */
export interface ObiaSourceIdentity {
  name: string;
  /** Local file path or URL of the image, when the layer has one. */
  location?: string;
}

/** A finished segmentation the later workbench steps build on. */
export interface ObiaSegmentationRun {
  /** Raster layer the image came from. */
  sourceLayerId: string;
  sourceName: string;
  source: ObiaSourceIdentity;
  /** 1-based source bands, in the order the tools received them. */
  bandIndexes: number[];
  width: number;
  height: number;
  /**
   * The part of the image segmented: a full-resolution pixel window and the
   * resolution level it was read at. Absent in projects saved before areas
   * were recorded, which segmented the whole image at full resolution.
   */
  area?: ObiaReadArea;
  /** Pixel size of the segmented grid, in the image CRS's units. */
  pixelSize?: number;
  /** How it was segmented; absent in older projects (region growing). */
  method?: ObiaMethod;
  /** A native method's parameters (`params` holds region growing's). */
  nativeParams?: ObiaNativeParams;
  /**
   * For a coarser level: how it was built by merging the level below's
   * objects. Absent for level 1, the segmentation itself.
   */
  merge?: ObiaLevelMerge;
  /**
   * The objects were imported (polygons burned onto the image grid), not
   * segmented; their labels are rebuilt by burning the objects layer again.
   */
  imported?: boolean;
  /**
   * The sidecar job that segmented natively, whose labels the sidecar reuses
   * to measure while it keeps them. Not saved: it does not outlive the
   * sidecar.
   */
  nativeJobId?: string;
  /**
   * Label raster (GeoTIFF), one `segment_id` per pixel. Not saved with the
   * project: null after a reload until rebuilt (ensureObiaLabels).
   */
  labels: Uint8Array | null;
  /** The objects layer added to the map. */
  objectsLayerId: string;
  objectCount: number;
  /**
   * Fingerprint of the label raster (fingerprintSegmentLabels), so a rebuilt
   * label raster can be checked against the saved objects. Absent in
   * projects saved before it was recorded.
   */
  labelsHash?: string;
  meanObjectArea: number;
  /** Tool invocation, for provenance. */
  tool: string;
  args: string[];
  params: RegionGrowingParams;
  env: ObiaRunEnv;
  finishedAt: string;
}

/** How a coarser level was built from the level below. */
export interface ObiaLevelMerge {
  /** The level whose objects were merged. */
  fromLevel: number;
  scale: number;
  /** Bands whose statistics drove the merge. */
  bands: number[];
  /** Built from an imported level mapping instead of by merging. */
  mapped?: boolean;
}

/**
 * One level of the object hierarchy, while another level is the one the
 * workbench steps work on. Level 1 is the segmentation; each level above
 * merges the objects of the level below, so its objects contain them.
 */
export interface ObiaLevelRecord {
  level: number;
  segmentation: ObiaSegmentationRun;
  features: ObiaFeatureRun | null;
  classification: ObiaClassificationRun | null;
  splits: ObiaSplitRecord[];
}

/** Object measurements written onto the objects layer. */
export interface ObiaFeatureRun {
  /** The segmentation these features describe (its `finishedAt`). */
  segmentationAt: string;
  table: ObiaFeatureTable;
  options: ObiaFeatureOptions;
  /** Tool invocations, for provenance. */
  calls: ObiaToolCall[];
  env: ObiaRunEnv;
  finishedAt: string;
}

/** A hold-out split of training samples into validation, for provenance. */
export interface ObiaSplitRecord {
  /** Share of each class held out, 0 to 1. */
  fraction: number;
  seed: number;
  moved: number;
  at: string;
}

/** The current workflow applied to another image (batch), for provenance. */
export interface ObiaBatchRun {
  targetLayerId: string;
  source: ObiaSourceIdentity;
  /** The part of that image read (its whole extent, at a level that fits). */
  area?: ObiaReadArea;
  /** Pixel size of the grid read, in that image CRS's units. */
  pixelSize?: number;
  /** The objects layer added for that image. */
  objectsLayerId: string;
  objectCount: number;
  /** Objects per predicted class. */
  classCounts: Record<string, number>;
  /** Tool invocations, for provenance. */
  calls: ObiaToolCall[];
  env: ObiaRunEnv;
  finishedAt: string;
}

/**
 * Random forest, threshold rules, each object's parent's class (inheritance),
 * or a ruleset (fuzzy classes and a process tree).
 */
export type ObiaClassifierMethod = "random-forest" | "rules" | "inherit" | "ruleset";

/** Classifier settings the Classify step edits. */
export interface ObiaClassifierSettings {
  method: ObiaClassifierMethod;
  trees: number;
  /** Feature columns for the random forest; null = every measured feature. */
  fields: string[] | null;
  rules: ObiaRule[];
  defaultClass: string;
  /** The ruleset method's ruleset, as JSON text (validated when run). */
  ruleset: string;
  /** Whether the ruleset starts from the current classification. */
  rulesetFromCurrent: boolean;
}

/** A finished classification. */
export interface ObiaClassificationRun extends ObiaClassification {
  settings: ObiaClassifierSettings;
  /** The feature run it used (its `finishedAt`). */
  featuresAt: string;
  env: ObiaRunEnv;
  finishedAt: string;
}

/** The data part of the session, as saved, restored and reset. */
export type ObiaSessionData = Pick<
  ObiaSessionState,
  | "sourceLayerId"
  | "bandIndexes"
  | "areaMode"
  | "method"
  | "params"
  | "nativeParams"
  | "segmentation"
  | "featureOptions"
  | "features"
  | "classes"
  | "labelRole"
  | "classifier"
  | "classification"
  | "splits"
  | "batches"
  | "level"
  | "levels"
>;

/** The deepest object hierarchy the workbench builds and restores. */
export const OBIA_MAX_LEVELS = 32;

/** Which part of the image to segment. */
export type ObiaAreaMode = "image" | "view";

interface ObiaSessionState {
  sourceLayerId: string;
  bandIndexes: number[];
  /** Segment the whole image, or the part in the current map view. */
  areaMode: ObiaAreaMode;
  /** Segmentation method: in the browser, or native in the sidecar. */
  method: ObiaMethod;
  params: RegionGrowingParams;
  nativeParams: ObiaNativeParams;
  segmentation: ObiaSegmentationRun | null;
  featureOptions: ObiaFeatureOptions;
  features: ObiaFeatureRun | null;
  /** Land-cover classes, in legend order. */
  classes: ObiaClass[];
  /** Role new labels get: training or validation samples. */
  labelRole: ObiaSampleRole;
  classifier: ObiaClassifierSettings;
  classification: ObiaClassificationRun | null;
  /** Hold-out splits applied to the current samples, oldest first. */
  splits: ObiaSplitRecord[];
  /** The workflow applied to other images, oldest first. */
  batches: ObiaBatchRun[];
  /** The hierarchy level the steps work on (1 = the segmentation). */
  level: number;
  /** The other levels, by level number. */
  levels: ObiaLevelRecord[];
  setSourceLayerId: (id: string) => void;
  setBandIndexes: (bands: number[]) => void;
  setAreaMode: (mode: ObiaAreaMode) => void;
  setMethod: (method: ObiaMethod) => void;
  setNativeParams: (patch: {
    slic?: Partial<ObiaNativeParams["slic"]>;
    felzenszwalb?: Partial<ObiaNativeParams["felzenszwalb"]>;
  }) => void;
  setParams: (patch: Partial<RegionGrowingParams>) => void;
  /** A new segmentation invalidates the features measured on the old one. */
  setSegmentation: (run: ObiaSegmentationRun | null) => void;
  setFeatureOptions: (patch: Partial<ObiaFeatureOptions>) => void;
  /** New features clear the classification built on the previous ones. */
  setFeatures: (run: ObiaFeatureRun | null) => void;
  /**
   * Add columns to the current features (context features), recording the
   * call; the classification is kept, since it is still what it was.
   */
  extendFeatures: (table: ObiaFeatureTable, call: ObiaToolCall) => void;
  setClasses: (classes: ObiaClass[]) => void;
  setLabelRole: (role: ObiaSampleRole) => void;
  setClassifier: (patch: Partial<ObiaClassifierSettings>) => void;
  setClassification: (run: ObiaClassificationRun | null) => void;
  /** Attach rebuilt label bytes to a stashed level, keeping its runs. */
  setLevelLabels: (level: number, finishedAt: string, labels: Uint8Array) => void;
  /** Attach rebuilt label bytes to the current segmentation, keeping its runs. */
  setSegmentationLabels: (finishedAt: string, labels: Uint8Array) => void;
  addSplit: (split: ObiaSplitRecord) => void;
  addBatch: (run: ObiaBatchRun) => void;
  /** Make a newly built level the one the steps work on. */
  addLevel: (record: ObiaLevelRecord) => void;
  /** Work on another level, keeping the current one's results. */
  switchLevel: (level: number) => void;
  /** Replace the whole session, e.g. with state restored from a project. */
  restore: (data: ObiaSessionData) => void;
}

/** A fresh, empty session. */
export function emptyObiaSession(): ObiaSessionData {
  return {
    sourceLayerId: "",
    bandIndexes: [],
    areaMode: "image",
    method: "region-growing",
    params: { ...DEFAULT_REGION_GROWING_PARAMS },
    nativeParams: {
      slic: { ...DEFAULT_OBIA_NATIVE_PARAMS.slic },
      felzenszwalb: { ...DEFAULT_OBIA_NATIVE_PARAMS.felzenszwalb },
    },
    segmentation: null,
    featureOptions: { ...DEFAULT_OBIA_FEATURE_OPTIONS },
    features: null,
    classes: [],
    labelRole: "training",
    classifier: {
      method: "random-forest",
      trees: 200,
      fields: null,
      rules: [],
      defaultClass: "unclassified",
      ruleset: "",
      rulesetFromCurrent: false,
    },
    classification: null,
    splits: [],
    batches: [],
    level: 1,
    levels: [],
  };
}

/** The active level's results, as a record to stash. */
function activeRecord(s: ObiaSessionData): ObiaLevelRecord | null {
  return s.segmentation
    ? {
        level: s.level,
        segmentation: s.segmentation,
        features: s.features,
        classification: s.classification,
        splits: s.splits,
      }
    : null;
}

/**
 * Session state of the Object-Based Analysis workbench. Kept outside the panel
 * so closing and reopening it keeps the segmentation the later steps (features,
 * training, classification) build on.
 */
export const useObiaSession = create<ObiaSessionState>((set) => ({
  ...emptyObiaSession(),
  setSourceLayerId: (sourceLayerId) => set({ sourceLayerId, bandIndexes: [] }),
  setBandIndexes: (bandIndexes) => set({ bandIndexes }),
  setAreaMode: (areaMode) => set({ areaMode }),
  setMethod: (method) => set({ method }),
  setNativeParams: (patch) =>
    set((s) => ({
      nativeParams: {
        slic: { ...s.nativeParams.slic, ...patch.slic },
        felzenszwalb: { ...s.nativeParams.felzenszwalb, ...patch.felzenszwalb },
      },
    })),
  setParams: (patch) => set((s) => ({ params: { ...s.params, ...patch } })),
  // A new segmentation also starts a new set of samples, so earlier splits go.
  // A new segmentation is a new level 1: the levels built on the old one go.
  setSegmentation: (segmentation) =>
    set({
      segmentation,
      features: null,
      classification: null,
      splits: [],
      batches: [],
      level: 1,
      levels: [],
    }),
  setFeatureOptions: (patch) => set((s) => ({ featureOptions: { ...s.featureOptions, ...patch } })),
  // New features make the classification built on the old ones stale, and
  // the levels built from them (their features came from these): those are
  // dropped from the hierarchy.
  setFeatures: (features) =>
    set((s) => ({
      features,
      classification: null,
      levels: s.levels.filter((record) => record.level < s.level),
    })),
  extendFeatures: (table, call) =>
    set((s) =>
      s.features ? { features: { ...s.features, table, calls: [...s.features.calls, call] } } : {},
    ),
  setClasses: (classes) => set({ classes }),
  setLabelRole: (labelRole) => set({ labelRole }),
  setClassifier: (patch) => set((s) => ({ classifier: { ...s.classifier, ...patch } })),
  setClassification: (classification) => set({ classification }),
  setLevelLabels: (level, finishedAt, labels) =>
    set((s) => ({
      levels: s.levels.map((record) =>
        record.level === level && record.segmentation.finishedAt === finishedAt
          ? { ...record, segmentation: { ...record.segmentation, labels } }
          : record,
      ),
    })),
  setSegmentationLabels: (finishedAt, labels) =>
    set((s) =>
      s.segmentation?.finishedAt === finishedAt
        ? { segmentation: { ...s.segmentation, labels } }
        : {},
    ),
  addSplit: (split) => set((s) => ({ splits: [...s.splits, split] })),
  addBatch: (run) => set((s) => ({ batches: [...s.batches, run] })),
  addLevel: (record) =>
    set((s) => {
      const current = activeRecord(s);
      return {
        levels: [...s.levels, ...(current ? [current] : [])]
          .filter((item) => item.level !== record.level)
          .sort((a, b) => a.level - b.level),
        level: record.level,
        segmentation: record.segmentation,
        features: record.features,
        classification: record.classification,
        splits: record.splits,
      };
    }),
  switchLevel: (level) =>
    set((s) => {
      const target = s.levels.find((item) => item.level === level);
      if (!target || level === s.level) return {};
      const current = activeRecord(s);
      return {
        levels: [
          ...s.levels.filter((item) => item.level !== level),
          ...(current ? [current] : []),
        ].sort((a, b) => a.level - b.level),
        level,
        segmentation: target.segmentation,
        features: target.features,
        classification: target.classification,
        splits: target.splits,
      };
    }),
  restore: (data) => set({ ...data }),
}));
