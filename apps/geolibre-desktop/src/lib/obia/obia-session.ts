import { DEFAULT_REGION_GROWING_PARAMS, type RegionGrowingParams } from "@geolibre/processing";
import { create } from "zustand";

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

interface ObiaSessionState {
  sourceLayerId: string;
  bandIndexes: number[];
  params: RegionGrowingParams;
  segmentation: ObiaSegmentationRun | null;
  setSourceLayerId: (id: string) => void;
  setBandIndexes: (bands: number[]) => void;
  setParams: (patch: Partial<RegionGrowingParams>) => void;
  setSegmentation: (run: ObiaSegmentationRun | null) => void;
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
  setSourceLayerId: (sourceLayerId) => set({ sourceLayerId, bandIndexes: [] }),
  setBandIndexes: (bandIndexes) => set({ bandIndexes }),
  setParams: (patch) => set((s) => ({ params: { ...s.params, ...patch } })),
  setSegmentation: (segmentation) => set({ segmentation }),
}));
