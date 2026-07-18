import type { Feature, FeatureCollection, GeoJsonProperties } from "geojson";
import type { GeoLibreLayer, LayerJoin, LayerVirtualField } from "./types";
import { applyLayerVirtualFields, stripVirtualFieldColumns } from "./virtual-fields";

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
 * Known trade-off of that bookkeeping: when a layer's data is replaced
 * wholesale (file reload), the replacement is stripped with the *previous*
 * `addedFields`. That is required because a replacement can also be a
 * write-back of the joined output (the attribute table round-trips
 * `layer.geojson`), which must not freeze stale joined values into base data —
 * but it means a reloaded base column whose name collides with a
 * previously-joined output column is replaced by the join's value for that
 * column. A field-name prefix (the QGIS convention the UI suggests) keeps
 * such collisions from arising.
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
export function stripJoinFields(features: Feature[], joins: LayerJoin[] | undefined): Feature[] {
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
 * Semantics per join: left join, first matching join row wins, and joined
 * columns are null-filled on unmatched features so the schema stays
 * consistent. An output name (prefix + field) that collides with an existing
 * column — from the base data or an earlier join — drops that one column;
 * the join's other columns still apply. A disabled join, or one whose source
 * cannot be resolved, contributes nothing and gets empty `addedFields` and no
 * stats.
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
  // Resolve each source once, shared between the early-exit check and the
  // per-join application below.
  const resolved = new Map<string, FeatureCollection | undefined>();
  const resolveOnce = (joinLayerId: string): FeatureCollection | undefined => {
    if (!resolved.has(joinLayerId)) {
      resolved.set(joinLayerId, resolveSource(joinLayerId));
    }
    return resolved.get(joinLayerId);
  };
  const active = joinList.filter((join) => join.enabled !== false && resolveOnce(join.joinLayerId));
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
    const source = join.enabled === false ? undefined : resolveOnce(join.joinLayerId);
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

    // An explicit `fields` array is honored verbatim (an empty subset joins no
    // columns); only an absent array means "every field except the key".
    const requested =
      join.fields !== undefined
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

    // Counts rows, not unique keys: duplicate unmatched rows each count, as
    // the stat (and the UI copy) promise.
    let unmatchedJoin = 0;
    for (const jf of joinFeatures) {
      const key = layerJoinKey(jf.properties?.[join.joinField]);
      if (key !== null && !targetKeys.has(key)) unmatchedJoin += 1;
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
 * Strip-and-reapply this layer's derived columns — persistent joins, then
 * virtual fields (so an expression can read joined columns) — resolving join
 * sources from `allLayers`. Pass `nextJoins`/`nextVirtualFields` to replace
 * the definitions (the layer's current bookkeeping still drives the strip, so
 * removed definitions clean up after themselves); omit them to refresh the
 * existing definitions against current data. Layers without a feature
 * collection are returned unchanged.
 */
export function applyJoinsToLayer(
  layer: GeoLibreLayer,
  allLayers: GeoLibreLayer[],
  nextJoins?: LayerJoin[],
  nextVirtualFields?: LayerVirtualField[],
): GeoLibreLayer {
  const geojson = layer.geojson;
  const joins = nextJoins ?? layer.joins ?? [];
  const virtualFields = nextVirtualFields ?? layer.virtualFields ?? [];
  if (!geojson) {
    return {
      ...layer,
      joins: joins.length > 0 ? joins : undefined,
      virtualFields: virtualFields.length > 0 ? virtualFields : undefined,
    };
  }
  // Virtual columns strip before join columns so a join output name held by a
  // stale virtual column frees up; the reverse order would also work today
  // (both strips are pure column removals), but this matches apply order.
  const base = stripJoinFields(
    stripVirtualFieldColumns(geojson.features ?? [], layer.virtualFields),
    layer.joins,
  );
  const applied = applyLayerJoins(base, joins, (joinLayerId) => {
    if (joinLayerId === layer.id) return undefined;
    return allLayers.find((candidate) => candidate.id === joinLayerId)?.geojson;
  });
  const withVirtual = applyLayerVirtualFields(applied.features, virtualFields);
  return {
    ...layer,
    geojson: { ...geojson, features: withVirtual.features },
    joins: applied.joins.length > 0 ? applied.joins : undefined,
    virtualFields: withVirtual.fields.length > 0 ? withVirtual.fields : undefined,
  };
}

/**
 * Ids of every layer whose data (directly or transitively) feeds `layerId`'s
 * joins, following `joinLayerId` edges through each source's own joins.
 * Disabled joins count too: re-enabling one must not spring a cycle. The Joins
 * UI uses this to keep a layer that already consumes the target — however
 * indirectly — out of the join-source picker, so circular joins cannot be
 * authored (the refresh cascade still breaks them defensively for hand-edited
 * projects).
 */
export function collectTransitiveJoinSourceIds(
  layers: GeoLibreLayer[],
  layerId: string,
): Set<string> {
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  const visited = new Set<string>();
  const queue = [layerId];
  while (queue.length > 0) {
    const current = byId.get(queue.shift() as string);
    for (const join of current?.joins ?? []) {
      if (visited.has(join.joinLayerId)) continue;
      visited.add(join.joinLayerId);
      queue.push(join.joinLayerId);
    }
  }
  return visited;
}

/**
 * Order `candidates` (layers with joins) so every layer comes after the
 * candidates its joins consume — Kahn's algorithm over "join source → join
 * target" edges within the candidate set. When a cycle blocks progress
 * (possible only in hand-edited projects; the UI refuses circular joins), an
 * actual cycle member is forced through — found by walking unmet-source edges
 * until a node repeats — so consumers *downstream* of the cycle still order
 * after it rather than falling back ahead of it.
 */
function topologicalJoinOrder(candidates: GeoLibreLayer[]): string[] {
  const candidateIds = new Set(candidates.map((layer) => layer.id));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  const sourcesOf = new Map<string, string[]>();
  for (const layer of candidates) indegree.set(layer.id, 0);
  for (const layer of candidates) {
    for (const join of layer.joins ?? []) {
      if (
        join.enabled === false ||
        join.joinLayerId === layer.id ||
        !candidateIds.has(join.joinLayerId)
      ) {
        continue;
      }
      indegree.set(layer.id, (indegree.get(layer.id) ?? 0) + 1);
      const list = dependents.get(join.joinLayerId) ?? [];
      list.push(layer.id);
      dependents.set(join.joinLayerId, list);
      const sources = sourcesOf.get(layer.id) ?? [];
      sources.push(join.joinLayerId);
      sourcesOf.set(layer.id, sources);
    }
  }
  const order: string[] = [];
  const orderedSet = new Set<string>();
  const queue = candidates.filter((layer) => indegree.get(layer.id) === 0).map((layer) => layer.id);
  while (order.length < candidates.length) {
    if (queue.length === 0) {
      // Every unordered layer has at least one unordered source, so walking
      // unmet-source edges from any unordered layer must revisit a node, and
      // that node sits on a cycle.
      const start = candidates.find((layer) => !orderedSet.has(layer.id));
      if (!start) break;
      let cursor = start.id;
      const walked = new Set<string>();
      while (!walked.has(cursor)) {
        walked.add(cursor);
        const next = (sourcesOf.get(cursor) ?? []).find((source) => !orderedSet.has(source));
        if (next === undefined) break;
        cursor = next;
      }
      queue.push(cursor);
    }
    const id = queue.shift() as string;
    if (orderedSet.has(id)) continue;
    orderedSet.add(id);
    order.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      const remaining = (indegree.get(dependent) ?? 1) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0 && !orderedSet.has(dependent)) queue.push(dependent);
    }
  }
  return order;
}

/**
 * Refresh every layer whose joins (directly or transitively) consume the
 * layer identified by `seedId`, after that layer's data changed — or after it
 * was removed (a gone source resolves to nothing, so its frozen columns strip
 * away). The affected layers re-derive in topological dependency order, so a
 * layer joining two other affected layers sees both of them fresh regardless
 * of their positions in the layer panel. The seed itself is not touched.
 */
export function cascadeLayerJoinRefresh(layers: GeoLibreLayer[], seedId: string): GeoLibreLayer[] {
  // Collect the transitive dependents of the seed.
  const affected = new Set<string>();
  const queue = [seedId];
  while (queue.length > 0) {
    const sourceId = queue.shift() as string;
    for (const layer of layers) {
      if (layer.id === seedId || affected.has(layer.id)) continue;
      if (layer.joins?.some((join) => join.enabled !== false && join.joinLayerId === sourceId)) {
        affected.add(layer.id);
        queue.push(layer.id);
      }
    }
  }
  if (affected.size === 0) return layers;

  let current = layers;
  const order = topologicalJoinOrder(layers.filter((layer) => affected.has(layer.id)));
  for (const id of order) {
    current = current.map((layer) => (layer.id === id ? applyJoinsToLayer(layer, current) : layer));
  }
  return current;
}

/**
 * Re-resolve every layer's persistent joins against the freshly loaded layer
 * set (project open). Layers re-derive in topological order of their join
 * dependencies, so a chain (`C joins A, A joins B`) resolves A before C; a
 * hand-edited cycle is broken by forcing one of its members through first
 * (see {@link topologicalJoinOrder}), so consumers downstream of the cycle
 * still re-derive after it. Layers with virtual fields but no joins re-derive
 * too (their expressions run against the freshly loaded features). Layer sets
 * without joins or virtual fields pass through by reference.
 */
export function reapplyLayerJoins(layers: GeoLibreLayer[]): GeoLibreLayer[] {
  const joined = layers.filter((layer) => layer.joins?.length || layer.virtualFields?.length);
  if (joined.length === 0) return layers;

  let current = layers;
  for (const id of topologicalJoinOrder(joined)) {
    current = current.map((layer) => (layer.id === id ? applyJoinsToLayer(layer, current) : layer));
  }
  return current;
}
