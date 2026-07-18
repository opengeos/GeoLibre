import type { Feature, FeatureCollection, GeoJsonProperties } from "geojson";
import type { GeoLibreLayer, LayerJoin } from "./types";

/**
 * Persistent attribute joins (QGIS Layer Properties → Joins), issue #1315.
 *
 * A layer's `joins` are live left joins that materialize columns from another
 * layer's attribute table into this layer's feature properties. Materializing
 * (rather than resolving lazily) means every consumer of attributes — the
 * attribute table, Expression Builder, data-driven styling, labels, diagrams,
 * export — sees the joined columns with no further wiring.
 *
 * Idempotency without a duplicate base copy: each applied join records the
 * output column names it added (`addedFields`), and applying joins always
 * strips those first. Base columns win every name collision (a joined column
 * whose output name already exists is skipped entirely), so stripping the
 * added columns exactly restores the pre-join properties.
 *
 * The data is already in memory as JS feature objects, so the join is a plain
 * hash join here rather than the DuckDB-WASM SQL statement sketched in the
 * issue — the result is identical for equality keys and the engine stays
 * synchronous and dependency-free. Key semantics deliberately mirror the
 * Processing → Vector attribute join (and the sidecar's `_attribute_join_key`):
 * empty values never match, and non-empty values compare stringified.
 */

/** Canonical JSON for object values (sorted keys), matching the processing engine. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function valueToString(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value !== null && typeof value === "object") return stableStringify(value);
  return String(value);
}

/**
 * Match key for a persistent join: empty values (null/undefined/NaN/empty
 * string) never match a row, mirroring a SQL/pandas NaN join key. Non-empty
 * values are keyed by their string form, so a numeric `5` and the string `"5"`
 * join while a zero-padded code like `"01001"` only matches another `"01001"`.
 * Kept in sync with the Processing attribute join's `attributeJoinKey`.
 */
export function layerJoinKey(value: unknown): string | null {
  const isEmpty =
    value === null ||
    value === undefined ||
    (typeof value === "number" && Number.isNaN(value)) ||
    valueToString(value) === "";
  return isEmpty ? null : valueToString(value);
}

/**
 * Remove every column previously added by `joins` (per their `addedFields`
 * bookkeeping) from a copy of `features`, restoring the pre-join properties.
 * Features without any tracked column are returned unchanged (same reference).
 */
export function stripJoinFields(
  features: Feature[],
  joins: LayerJoin[] | undefined,
): Feature[] {
  const tracked = new Set<string>();
  for (const join of joins ?? []) {
    for (const field of join.addedFields ?? []) tracked.add(field);
  }
  if (tracked.size === 0) return features;
  return features.map((feature) => {
    const props = feature.properties;
    if (!props) return feature;
    let hasTracked = false;
    for (const key of tracked) {
      if (key in props) {
        hasTracked = true;
        break;
      }
    }
    if (!hasTracked) return feature;
    const next: GeoJsonProperties = {};
    for (const [key, value] of Object.entries(props)) {
      if (!tracked.has(key)) next[key] = value;
    }
    return { ...feature, properties: next };
  });
}

/** Result of {@link applyLayerJoins}: joined features plus refreshed join records. */
export interface ApplyLayerJoinsResult {
  features: Feature[];
  /** Input joins with `addedFields` and `stats` recomputed for this run. */
  joins: LayerJoin[];
}

/**
 * Apply `joins` in order to base (already-stripped) `features`, returning new
 * feature objects with the joined columns merged into their properties.
 *
 * Semantics per join: left join, first matching join row wins, joined columns
 * are null-filled on unmatched features so the schema stays consistent, and an
 * output name (prefix + field) that collides with an existing column — from
 * the base data or an earlier join — is skipped for the whole join. A disabled
 * join, or one whose source cannot be resolved, contributes nothing and gets
 * empty `addedFields` and no stats.
 *
 * @param features - The layer's base features (strip previous joins first).
 * @param joins - Join definitions in application order.
 * @param resolveSource - Maps a join's `joinLayerId` to that layer's current
 *   feature collection, or `undefined` when the layer is gone (or is the
 *   target itself; self-joins are refused by the caller).
 */
export function applyLayerJoins(
  features: Feature[],
  joins: LayerJoin[] | undefined,
  resolveSource: (joinLayerId: string) => FeatureCollection | undefined,
): ApplyLayerJoinsResult {
  const joinList = joins ?? [];
  const active = joinList.filter(
    (join) => join.enabled !== false && resolveSource(join.joinLayerId),
  );
  if (active.length === 0) {
    return {
      features,
      joins: joinList.map((join) => ({
        ...join,
        addedFields: [],
        stats: undefined,
      })),
    };
  }

  // One clone up front; per-join application then mutates our own copies.
  const out = features.map((feature) => ({
    ...feature,
    properties: { ...(feature.properties ?? {}) },
  }));

  // Schema-level collision tracking: a joined column never shadows a base
  // column (or an earlier join's column) on any feature.
  const usedNames = new Set<string>();
  for (const feature of features) {
    for (const key of Object.keys(feature.properties ?? {})) usedNames.add(key);
  }

  const outJoins = joinList.map((join): LayerJoin => {
    const source =
      join.enabled === false ? undefined : resolveSource(join.joinLayerId);
    if (!source) return { ...join, addedFields: [], stats: undefined };

    const joinFeatures = (source.features ?? []).filter(Boolean);

    // Collect join-table columns in first-seen order for a deterministic schema.
    const joinKeysOrder: string[] = [];
    const joinKeySet = new Set<string>();
    for (const jf of joinFeatures) {
      for (const key of Object.keys(jf.properties ?? {})) {
        if (!joinKeySet.has(key)) {
          joinKeySet.add(key);
          joinKeysOrder.push(key);
        }
      }
    }

    const requested = join.fields?.length
      ? join.fields.filter((field) => joinKeySet.has(field))
      : joinKeysOrder.filter((key) => key !== join.joinField);
    const prefix = join.prefix ?? "";
    const fieldPairs: Array<[source: string, output: string]> = [];
    for (const field of requested) {
      const outputName = prefix + field;
      if (usedNames.has(outputName)) continue;
      usedNames.add(outputName);
      fieldPairs.push([field, outputName]);
    }

    // First-match lookup: when several join rows share a key, the first wins.
    const lookup = new Map<string, GeoJsonProperties>();
    for (const jf of joinFeatures) {
      const key = layerJoinKey(jf.properties?.[join.joinField]);
      if (key === null || lookup.has(key)) continue;
      lookup.set(key, jf.properties ?? {});
    }

    let matched = 0;
    const targetKeys = new Set<string>();
    for (const feature of out) {
      const props = feature.properties;
      const key = layerJoinKey(props[join.targetField]);
      if (key !== null) targetKeys.add(key);
      const row = key === null ? undefined : lookup.get(key);
      if (row) {
        matched += 1;
        for (const [field, outputName] of fieldPairs) {
          props[outputName] = row[field] !== undefined ? row[field] : null;
        }
      } else {
        for (const [, outputName] of fieldPairs) props[outputName] = null;
      }
    }

    let unmatchedJoin = 0;
    const countedKeys = new Set<string>();
    for (const jf of joinFeatures) {
      const key = layerJoinKey(jf.properties?.[join.joinField]);
      if (key === null || countedKeys.has(key)) continue;
      countedKeys.add(key);
      if (!targetKeys.has(key)) unmatchedJoin += 1;
    }

    return {
      ...join,
      addedFields: fieldPairs.map(([, outputName]) => outputName),
      stats: {
        matchedCount: matched,
        unmatchedTargetCount: out.length - matched,
        unmatchedJoinCount: unmatchedJoin,
      },
    };
  });

  return { features: out, joins: outJoins };
}

/**
 * Strip-and-reapply joins on one layer, resolving join sources from
 * `allLayers`. Pass `nextJoins` to replace the definitions (the layer's
 * current `addedFields` still drive the strip, so removed joins clean up after
 * themselves); omit it to refresh the existing joins against current data.
 * Layers without a feature collection are returned unchanged.
 */
export function applyJoinsToLayer(
  layer: GeoLibreLayer,
  allLayers: GeoLibreLayer[],
  nextJoins?: LayerJoin[],
): GeoLibreLayer {
  const geojson = layer.geojson;
  const joins = nextJoins ?? layer.joins ?? [];
  if (!geojson) {
    return { ...layer, joins: joins.length > 0 ? joins : undefined };
  }
  const base = stripJoinFields(geojson.features ?? [], layer.joins);
  const applied = applyLayerJoins(base, joins, (joinLayerId) => {
    if (joinLayerId === layer.id) return undefined;
    return allLayers.find((candidate) => candidate.id === joinLayerId)?.geojson;
  });
  return {
    ...layer,
    geojson: { ...geojson, features: applied.features },
    joins: applied.joins.length > 0 ? applied.joins : undefined,
  };
}

/**
 * Re-resolve every layer's persistent joins against the freshly loaded layer
 * set (project open). Join sources resolve against the layers as loaded, so a
 * join table whose saved data changed on disk refreshes its targets once the
 * table itself reloads (the store's `updateLayer` cascades that change).
 * Layers without joins pass through by reference.
 */
export function reapplyLayerJoins(layers: GeoLibreLayer[]): GeoLibreLayer[] {
  if (!layers.some((layer) => layer.joins?.length)) return layers;
  return layers.map((layer) =>
    layer.joins?.length ? applyJoinsToLayer(layer, layers) : layer,
  );
}
