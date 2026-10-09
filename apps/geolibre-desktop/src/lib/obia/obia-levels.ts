import {
  OBIA_MAX_PIXELS,
  childrenOf,
  decodeLabelGrid,
  encodeLabelGrid,
  fingerprintSegmentLabels,
  levelFeatures,
  mergeObjects,
  objectAdjacency,
  polygonizeLabels,
  relabelGrid,
  type ObiaFeatureTable,
  type ObiaRunOptions,
} from "@geolibre/processing";
import type { FeatureCollection } from "geojson";
import { ensureObiaLabels, obiaRunEnv } from "./obia-persistence";
import type { ObiaFeatureRun, ObiaLevelRecord, ObiaSegmentationRun } from "./obia-session";
import { useObiaSession } from "./obia-session";

/** A coarser level, built but not yet on the map. */
export interface ObiaBuiltLevel {
  /** The new level's objects, one polygon per parent. */
  objects: FeatureCollection;
  /** Its features, including `child_count`. */
  table: ObiaFeatureTable;
  /** Each object of the level below's parent. */
  parentOf: Map<number, number>;
  /** The record to add once its objects layer exists (`objectsLayerId` empty). */
  record: ObiaLevelRecord;
}

/** Why a coarser level cannot be built. */
export class ObiaLevelError extends Error {
  readonly code: "no-features" | "too-large" | "not-top";

  constructor(code: "no-features" | "too-large" | "not-top", message: string) {
    super(message);
    this.name = "ObiaLevelError";
    this.code = code;
  }
}

/**
 * Build the level above the current one by merging its objects, best-first by
 * color heterogeneity until the cheapest merge exceeds scale².
 *
 * @param scale The merge scale.
 * @param run Cancellation and progress.
 * @throws ObiaLevelError when the current level is not the top one, has no
 *   spectral statistics, or is too large to polygonize in the browser.
 */
export async function buildCoarserLevel(
  scale: number,
  run: ObiaRunOptions = {},
): Promise<ObiaBuiltLevel> {
  const state = useObiaSession.getState();
  const { segmentation, features, level, levels } = state;
  if (!segmentation || !features) {
    throw new ObiaLevelError("no-features", "Measure the objects first.");
  }
  if (levels.some((record) => record.level > level)) {
    throw new ObiaLevelError("not-top", "Build coarser levels from the coarsest one.");
  }
  const bands = segmentation.bandIndexes.filter(
    (band) =>
      features.table.fields.includes(`mean_b${band}`) &&
      features.table.fields.includes(`std_b${band}`),
  );
  if (!bands.length || !features.table.fields.includes("area_px")) {
    throw new ObiaLevelError("no-features", "Measure spectral statistics first.");
  }
  if (segmentation.width * segmentation.height > OBIA_MAX_PIXELS) {
    throw new ObiaLevelError("too-large", "The objects are too large to merge in the browser.");
  }
  run.onStep?.("merge");
  const labels = await ensureObiaLabels(run);
  const grid = await decodeLabelGrid(labels);
  const parentOf = mergeObjects(features.table, objectAdjacency(grid), { scale, bands });
  const parentIds = relabelGrid(grid, parentOf);
  const parentLabels = encodeLabelGrid(grid, parentIds);
  const objects = await polygonizeLabels(parentLabels, run);
  const options = features.options;
  const table = levelFeatures(features.table, parentOf, parentIds, grid, segmentation.bandIndexes, {
    spectral: options.spectral,
    shape: options.shape,
    context: options.context,
    indices: options.spectral ? options.indices : undefined,
  });
  // How many objects of the level below each object contains.
  table.fields.push("child_count");
  for (const [parent, children] of childrenOf(parentOf)) {
    const row = table.rows.get(parent);
    if (row) row.child_count = children.length;
  }
  const { objectCount, hash } = await fingerprintSegmentLabels(parentLabels);
  const finishedAt = new Date().toISOString();
  const env = obiaRunEnv();
  const merge = { fromLevel: level, scale, bands };
  const next: ObiaSegmentationRun = {
    ...segmentation,
    labels: parentLabels,
    objectsLayerId: "",
    objectCount,
    labelsHash: hash,
    meanObjectArea: objectCount ? (grid.width * grid.height) / objectCount : 0,
    tool: "obia/merge",
    args: [JSON.stringify(merge)],
    merge,
    nativeJobId: undefined,
    env,
    finishedAt,
  };
  const featureRun: ObiaFeatureRun = {
    segmentationAt: finishedAt,
    table,
    // Texture is not carried up from the level below.
    options: { ...options, textureBand: undefined },
    calls: [{ tool: "obia/level-features", args: [JSON.stringify({ fromLevel: level })] }],
    env,
    finishedAt,
  };
  return {
    objects,
    table,
    parentOf,
    record: {
      level: level + 1,
      segmentation: next,
      features: featureRun,
      classification: null,
      splits: [],
    },
  };
}
