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
 * @param mapping Instead of merging, each object's parent as given (an
 *   imported level mapping); objects without one are left out.
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
  const parentOf = mapping
    ? new Map(
        [...mapping].filter(([child, parent]) => features.table.rows.has(child) && parent > 0),
      )
    : mergeObjects(features.table, objectAdjacency(grid), { scale, bands });
  const parentIds = relabelGrid(grid, parentOf);
  const parentLabels = encodeLabelGrid(grid, parentIds);
  const objects = await polygonizeLabels(parentLabels, run);
  const options = features.options;
  const table = levelFeatures(features.table, parentOf, parentIds, grid, bands, {
    // Pooling needs the children's band statistics.
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
  useObiaSession.getState().addLevel({
    ...built.record,
    segmentation: { ...built.record.segmentation, objectsLayerId },
  });
}
