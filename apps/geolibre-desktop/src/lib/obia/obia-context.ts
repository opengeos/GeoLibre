import { useAppStore } from "@geolibre/core";
import {
  OBIA_SEGMENT_ID_FIELD,
  contextFeatures,
  decodeLabelGrid,
  isContextField,
  objectAdjacency,
  type ObiaClassification,
  type ObiaFeatureTable,
  type ObiaRunOptions,
  type ObiaToolCall,
} from "@geolibre/processing";
import { OBIA_PARENT_FIELD, ensureObiaLabels } from "./obia-persistence";
import { useObiaSession } from "./obia-session";

/** Each object's parent, as a level's objects layer records it. */
function parentLinks(layerId: string): Map<number, number> {
  const links = new Map<number, number>();
  const layer = useAppStore.getState().layers.find((item) => item.id === layerId);
  for (const feature of layer?.geojson?.features ?? []) {
    const id = Number(feature.properties?.[OBIA_SEGMENT_ID_FIELD] ?? feature.id);
    const parent = Number(feature.properties?.[OBIA_PARENT_FIELD]);
    if (Number.isFinite(id) && parent > 0) links.set(id, parent);
  }
  return links;
}

/**
 * The current level's features with its context features (re)computed from
 * its neighbors and from the levels above and below.
 *
 * @param run Cancellation and progress.
 * @returns The full table (earlier context fields replaced), the context
 *   fields, and the call to record.
 * @throws When the current level has no features yet.
 */
export async function computeContextFeatures(
  run: ObiaRunOptions = {},
): Promise<{ table: ObiaFeatureTable; added: string[]; call: ObiaToolCall }> {
  const state = useObiaSession.getState();
  const { segmentation, features, level, levels, classes } = state;
  if (!segmentation || !features) throw new Error("Measure the objects first.");
  run.onStep?.("context");
  const grid = await decodeLabelGrid(await ensureObiaLabels(run));
  const above = levels.find((record) => record.level === level + 1);
  const below = levels.find((record) => record.level === level - 1);
  const context = contextFeatures({
    table: features.table,
    adjacency: objectAdjacency(grid),
    bands: segmentation.bandIndexes,
    classes: classes.map((item) => item.name),
    ...(above?.features
      ? {
          parent: {
            parentOf: parentLinks(segmentation.objectsLayerId),
            table: above.features.table,
            predictions: above.classification?.predictions,
          },
        }
      : {}),
    ...(below?.features
      ? {
          children: {
            parentOf: parentLinks(below.segmentation.objectsLayerId),
            areas: new Map(
              [...below.features.table.rows].map(([id, row]) => [id, row.area_px ?? 0]),
            ),
            predictions: below.classification?.predictions,
          },
        }
      : {}),
  });
  // Replace earlier context fields; keep the measured ones.
  const kept = features.table.fields.filter((field) => !isContextField(field));
  const table: ObiaFeatureTable = { fields: [...kept, ...context.fields], rows: new Map() };
  for (const [id, row] of features.table.rows) {
    const next: Record<string, number | null> = {};
    for (const field of kept) next[field] = row[field] ?? null;
    Object.assign(next, context.rows.get(id) ?? {});
    table.rows.set(id, next);
  }
  return {
    table,
    added: context.fields,
    call: {
      tool: "obia/context",
      args: [JSON.stringify({ level, above: above?.level ?? null, below: below?.level ?? null })],
    },
  };
}

/** The classified level above the current one, if there is one. */
export function classifiedLevelAbove(): number | null {
  const { level, levels } = useObiaSession.getState();
  const above = levels.find((record) => record.level === level + 1);
  return above?.classification ? above.level : null;
}

/**
 * Class inheritance: give each object of the current level its parent's class
 * from the classified level above (objects without a classified parent get
 * the default class).
 *
 * @param defaultClass Class for objects whose parent has none.
 * @throws When the level above is missing or unclassified.
 */
export function inheritClasses(defaultClass: string): ObiaClassification {
  const { segmentation, level, levels } = useObiaSession.getState();
  const above = levels.find((record) => record.level === level + 1);
  if (!segmentation || !above?.classification) {
    throw new Error("Classify the level above first.");
  }
  const parents = parentLinks(segmentation.objectsLayerId);
  const layer = useAppStore.getState().layers.find((item) => item.id === segmentation.objectsLayerId);
  const predictions = new Map<number, string>();
  for (const feature of layer?.geojson?.features ?? []) {
    const id = Number(feature.properties?.[OBIA_SEGMENT_ID_FIELD] ?? feature.id);
    if (!Number.isFinite(id)) continue;
    const parent = parents.get(id);
    predictions.set(
      id,
      (parent != null ? above.classification.predictions.get(parent) : undefined) ?? defaultClass,
    );
  }
  return {
    predictions,
    fields: [],
    imputed: {},
    trainingCount: 0,
    call: { tool: "obia/inherit", args: [JSON.stringify({ fromLevel: above.level })] },
  };
}
