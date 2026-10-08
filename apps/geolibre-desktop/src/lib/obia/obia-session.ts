import {
  DEFAULT_OBIA_FEATURE_OPTIONS,
  DEFAULT_REGION_GROWING_PARAMS,
  type ObiaClass,
  type ObiaClassification,
  type ObiaRule,
  type ObiaFeatureOptions,
  type ObiaSampleRole,
  type ObiaFeatureTable,
  type ObiaToolCall,
  type RegionGrowingParams,
} from "@geolibre/processing";
import { create } from "zustand";

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

/** A finished segmentation the later workbench steps build on. */
export interface ObiaSegmentationRun {
  /** Raster layer the image came from. */
  sourceLayerId: string;
  sourceName: string;
  /** 1-based source bands, in the order the tools received them. */
  bandIndexes: number[];
  width: number;
  height: number;
  /** Label raster (GeoTIFF), one `segment_id` per pixel. */
  labels: Uint8Array;
  /** The objects layer added to the map. */
  objectsLayerId: string;
  objectCount: number;
  meanObjectArea: number;
  /** Tool invocation, for provenance. */
  tool: string;
  args: string[];
  params: RegionGrowingParams;
  finishedAt: string;
}

/** Object measurements written onto the objects layer. */
export interface ObiaFeatureRun {
  /** The segmentation these features describe (its `finishedAt`). */
  segmentationAt: string;
  table: ObiaFeatureTable;
  options: ObiaFeatureOptions;
  /** Tool invocations, for provenance. */
  calls: ObiaToolCall[];
  finishedAt: string;
}

export type ObiaClassifierMethod = "random-forest" | "rules";

/** Classifier settings the Classify step edits. */
export interface ObiaClassifierSettings {
  method: ObiaClassifierMethod;
  trees: number;
  /** Feature columns for the random forest; null = every measured feature. */
  fields: string[] | null;
  rules: ObiaRule[];
  defaultClass: string;
}

/** A finished classification. */
export interface ObiaClassificationRun extends ObiaClassification {
  settings: ObiaClassifierSettings;
  /** The feature run it used (its `finishedAt`). */
  featuresAt: string;
  finishedAt: string;
}

interface ObiaSessionState {
  sourceLayerId: string;
  bandIndexes: number[];
  params: RegionGrowingParams;
  segmentation: ObiaSegmentationRun | null;
  featureOptions: ObiaFeatureOptions;
  features: ObiaFeatureRun | null;
  /** Land-cover classes, in legend order. */
  classes: ObiaClass[];
  /** Role new labels get: training or validation samples. */
  labelRole: ObiaSampleRole;
  classifier: ObiaClassifierSettings;
  classification: ObiaClassificationRun | null;
  setSourceLayerId: (id: string) => void;
  setBandIndexes: (bands: number[]) => void;
  setParams: (patch: Partial<RegionGrowingParams>) => void;
  /** A new segmentation invalidates the features measured on the old one. */
  setSegmentation: (run: ObiaSegmentationRun | null) => void;
  setFeatureOptions: (patch: Partial<ObiaFeatureOptions>) => void;
  /** New features clear the classification built on the previous ones. */
  setFeatures: (run: ObiaFeatureRun | null) => void;
  setClasses: (classes: ObiaClass[]) => void;
  setLabelRole: (role: ObiaSampleRole) => void;
  setClassifier: (patch: Partial<ObiaClassifierSettings>) => void;
  setClassification: (run: ObiaClassificationRun | null) => void;
}

/**
 * Session state of the Object-Based Analysis workbench. Kept outside the panel
 * so closing and reopening it keeps the segmentation the later steps (features,
 * training, classification) build on.
 */
export const useObiaSession = create<ObiaSessionState>((set) => ({
  sourceLayerId: "",
  bandIndexes: [],
  params: { ...DEFAULT_REGION_GROWING_PARAMS },
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
  },
  classification: null,
  setSourceLayerId: (sourceLayerId) => set({ sourceLayerId, bandIndexes: [] }),
  setBandIndexes: (bandIndexes) => set({ bandIndexes }),
  setParams: (patch) => set((s) => ({ params: { ...s.params, ...patch } })),
  setSegmentation: (segmentation) => set({ segmentation, features: null, classification: null }),
  setFeatureOptions: (patch) => set((s) => ({ featureOptions: { ...s.featureOptions, ...patch } })),
  // New features make the classification built on the old ones stale.
  setFeatures: (features) => set({ features, classification: null }),
  setClasses: (classes) => set({ classes }),
  setLabelRole: (labelRole) => set({ labelRole }),
  setClassifier: (patch) => set((s) => ({ classifier: { ...s.classifier, ...patch } })),
  setClassification: (classification) => set({ classification }),
}));
