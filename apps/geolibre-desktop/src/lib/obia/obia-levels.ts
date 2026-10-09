import { useAppStore } from "@geolibre/core";
import {
  OBIA_MAX_PIXELS,
  OBIA_SEGMENT_ID_FIELD,
  applyObjectFeatures,
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
import { OBIA_PARENT_FIELD, ensureObiaLabels, obiaRunEnv } from "./obia-persistence";
import type { ObiaFeatureRun, ObiaLevelRecord, ObiaSegmentationRun } from "./obia-session";
import { OBIA_MAX_LEVELS, useObiaSession } from "./obia-session";

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
  /** Objects a mapping gave no parent, each now its own parent. */
  unmapped: number;
}

/** Why a coarser level cannot be built. */
export class ObiaLevelError extends Error {
  readonly code: "no-features" | "too-large" | "not-top" | "too-deep" | "bad-scale";

  constructor(code: ObiaLevelError["code"], message: string) {
    super(message);
    this.name = "ObiaLevelError";
    this.code = code;
  }
}

/**
 * Build the level above the current one by merging its objects, best-first by
 * color heterogeneity until the cheapest merge exceeds scale².
 *
 * @param scale The merge scale (ignored with a mapping).
 * @param run Cancellation and progress.
 * @param mapping Instead of merging, each object's parent as given (an
 *   imported level mapping); objects without one become their own parent.
 * @throws ObiaLevelError when the current level is not the top one, has no
 *   spectral statistics, or is too large to polygonize in the browser.
 */
export async function buildCoarserLevel(
  scale: number,
  run: ObiaRunOptions = {},
  mapping?: ReadonlyMap<number, number>,
): Promise<ObiaBuiltLevel> {
  const state = useObiaSession.getState();
  const { segmentation, features, level, levels } = state;
  if (!segmentation || !features) {
    throw new ObiaLevelError("no-features", "Measure the objects first.");
  }
  if (levels.some((record) => record.level > level)) {
    throw new ObiaLevelError("not-top", "Build coarser levels from the coarsest one.");
  }
  // A mapping gives the parents, so it has no scale.
  if (!mapping && !(Number.isFinite(scale) && scale > 0)) {
    throw new ObiaLevelError("bad-scale", "The scale must be a positive number.");
  }
  if (level >= OBIA_MAX_LEVELS) {
    throw new ObiaLevelError("too-deep", `The hierarchy has at most ${OBIA_MAX_LEVELS} levels.`);
  }
  const bands = segmentation.bandIndexes.filter(
    (band) =>
      features.table.fields.includes(`mean_b${band}`) &&
      features.table.fields.includes(`std_b${band}`),
  );
  if (!mapping && (!bands.length || !features.table.fields.includes("area_px"))) {
    throw new ObiaLevelError("no-features", "Measure spectral statistics first.");
  }
  if (segmentation.width * segmentation.height > OBIA_MAX_PIXELS) {
    throw new ObiaLevelError("too-large", "The objects are too large to merge in the browser.");
  }
  run.onStep?.("merge");
  const labels = await ensureObiaLabels(run);
  const grid = await decodeLabelGrid(labels);
  // The mapping's parents, or the merge's; objects the merge could not weigh
  // (no size, or no feature row) or the mapping left out still get a parent
  // of their own, so the coarser grid has no holes.
  const given = mapping ?? mergeObjects(features.table, objectAdjacency(grid), { scale, bands });
  const parentOf = new Map<number, number>();
  let nextParent = 1;
  for (const parent of given.values()) if (parent >= nextParent) nextParent = parent + 1;
  let unmapped = 0;
  for (const id of grid.ids) {
    if (!id || parentOf.has(id)) continue;
    const parent = given.get(id);
    if (parent && parent > 0) parentOf.set(id, parent);
    else {
      parentOf.set(id, nextParent++);
      unmapped += 1;
    }
  }
  const parentIds = relabelGrid(grid, parentOf);
  const parentLabels = encodeLabelGrid(grid, parentIds);
  const objects = await polygonizeLabels(parentLabels, run);
  const options = features.options;
  // Only the bands with statistics: a band without them would pool to zeros.
  const table = levelFeatures(features.table, parentOf, parentIds, grid, bands, {
    spectral: options.spectral && bands.length > 0,
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
  const merge = mapping
    ? { fromLevel: level, scale: 0, bands, mapped: true }
    : { fromLevel: level, scale, bands };
  const next: ObiaSegmentationRun = {
    ...segmentation,
    labels: parentLabels,
    objectsLayerId: "",
    objectCount,
    labelsHash: hash,
    meanObjectArea: objectCount ? (grid.width * grid.height) / objectCount : 0,
    tool: mapping ? "obia/import-mapping" : "obia/merge",
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
    unmapped: mapping ? unmapped : 0,
    record: {
      level: level + 1,
      segmentation: next,
      features: featureRun,
      classification: null,
      splits: [],
    },
  };
}

/** Outline colors by level, so nested levels read apart on the map. */
const LEVEL_COLORS = ["#facc15", "#22d3ee", "#f472b6", "#a3e635", "#fb923c"];

/**
 * Put a built level on the map and make it the one the steps work on: its
 * objects layer (with its features), and each child's parent recorded on the
 * level below's objects in `obia_parent`.
 *
 * @param built The level from {@link buildCoarserLevel}.
 * @param name The new objects layer's name.
 * @throws When the level below's objects layer is gone.
 */
export function addBuiltLevel(built: ObiaBuiltLevel, name: string): void {
  const { addGeoJsonLayer, updateLayer } = useAppStore.getState();
  const segmentation = useObiaSession.getState().segmentation;
  const childLayer = useAppStore
    .getState()
    .layers.find((layer) => layer.id === segmentation?.objectsLayerId);
  if (!segmentation || !childLayer?.geojson) throw new Error("The objects layer was removed.");
  // Link each child to its parent before adding the new layer, so a failure
  // cannot leave a layer the session does not know about; the links also
  // rebuild this level after a reload.
  updateLayer(childLayer.id, {
    geojson: {
      ...childLayer.geojson,
      features: childLayer.geojson.features.map((feature) => {
        const id = Number(feature.properties?.[OBIA_SEGMENT_ID_FIELD] ?? feature.id);
        return {
          ...feature,
          properties: {
            ...feature.properties,
            [OBIA_PARENT_FIELD]: built.parentOf.get(id) ?? null,
          },
        };
      }),
    },
  });
  const next = built.record.level;
  const objectsLayerId = addGeoJsonLayer(name, applyObjectFeatures(built.objects, built.table));
  const added = useAppStore.getState().layers.find((layer) => layer.id === objectsLayerId);
  if (added) {
    updateLayer(objectsLayerId, {
      style: {
        ...added.style,
        fillOpacity: 0,
        strokeColor: LEVEL_COLORS[(next - 1) % LEVEL_COLORS.length],
        strokeWidth: 2,
      },
      metadata: { ...added.metadata, obiaRole: "objects", obiaLevel: next },
    });
  }
  useObiaSession.getState().addLevel({
    ...built.record,
    segmentation: { ...built.record.segmentation, objectsLayerId },
  });
}
