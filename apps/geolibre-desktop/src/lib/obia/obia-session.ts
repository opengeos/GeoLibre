import {
  DEFAULT_OBIA_FEATURE_OPTIONS,
  DEFAULT_REGION_GROWING_PARAMS,
  type ObiaFeatureOptions,
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

interface ObiaSessionState {
  sourceLayerId: string;
  bandIndexes: number[];
  params: RegionGrowingParams;
  segmentation: ObiaSegmentationRun | null;
  featureOptions: ObiaFeatureOptions;
  features: ObiaFeatureRun | null;
  setSourceLayerId: (id: string) => void;
  setBandIndexes: (bands: number[]) => void;
  setParams: (patch: Partial<RegionGrowingParams>) => void;
  /** A new segmentation invalidates the features measured on the old one. */
  setSegmentation: (run: ObiaSegmentationRun | null) => void;
  setFeatureOptions: (patch: Partial<ObiaFeatureOptions>) => void;
  setFeatures: (run: ObiaFeatureRun | null) => void;
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
  setSourceLayerId: (sourceLayerId) => set({ sourceLayerId, bandIndexes: [] }),
  setBandIndexes: (bandIndexes) => set({ bandIndexes }),
  setParams: (patch) => set((s) => ({ params: { ...s.params, ...patch } })),
  setSegmentation: (segmentation) => set({ segmentation, features: null }),
  setFeatureOptions: (patch) => set((s) => ({ featureOptions: { ...s.featureOptions, ...patch } })),
  setFeatures: (features) => set({ features }),
}));
