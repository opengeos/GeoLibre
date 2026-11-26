// Op-level (CRDT) model of a collaborative project (#3530).
//
// The whole-snapshot protocol sends the entire project on every edit and the
// relay keeps whichever snapshot arrived last, so two people editing at once
// overwrite each other. Here the project lives in a Yjs document instead, and
// every edit becomes a small update that merges with concurrent ones:
//
//   fields      Y.Map  every top-level project key except `layers`
//   layers      Y.Map  layer id -> Y.Map of that layer's properties
//   layerOrder  Y.Array of layer ids, bottom to top as in `project.layers`
//
// Plain objects become nested Y.Maps at any depth, so two people changing
// different properties of one layer's style both keep their change. Arrays
// and scalars are single values (last writer wins on that one value), with one
// exception: a layer's `geojson` FeatureCollection is stored feature by
// feature, so concurrent edits to different features of one layer merge too.
// Each feature is itself one value: two people editing the same feature at
// once (even different attributes of it) resolve to one of the two edits.
//
//   geojson     Y.Map  { meta: Y.Map, features: Y.Map key -> feature, order: Y.Array key }
//
// The model is schema-light on purpose. It knows that a project has `layers`
// with string ids and that a layer's `geojson` may be a FeatureCollection, and
// nothing else, so a new project field syncs without touching this file. Both
// relays and the app share it, which is why it lives in collab-core and keeps
// to plain ES2022 (no DOM).

import * as Y from "yjs";

/** Capability string a client and relay exchange to opt into this protocol. */
export const CRDT_FEATURE = "crdt-v1";

export const ROOT_FIELDS = "fields";
export const ROOT_LAYERS = "layers";
export const ROOT_LAYER_ORDER = "layerOrder";

const FC_META = "meta";
const FC_FEATURES = "features";
const FC_ORDER = "order";

type JsonObject = Record<string, unknown>;

/** A project-shaped value: any object, optionally with a `layers` array. */
export type ProjectRecord = JsonObject;

/** Options for {@link ProjectDoc.write}. */
export interface ProjectWriteOptions {
  /**
   * Top-level keys this writer neither writes nor deletes. A client leaves out
   * participant-local state (its camera, its plugin activation) this way
   * without erasing the copy a peer or a migrated snapshot put in the doc.
   */
  ignore?: ReadonlySet<string>;
}

function isPlainObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Structural equality over JSON-like values. Keys whose value is `undefined`
 * count as absent, matching how the project serializes.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;
  const ao = a as JsonObject;
  const bo = b as JsonObject;
  let aCount = 0;
  for (const key of Object.keys(ao)) {
    if (ao[key] === undefined) continue;
    aCount += 1;
    if (!Object.prototype.hasOwnProperty.call(bo, key) || !deepEqual(ao[key], bo[key])) {
      return false;
    }
  }
  let bCount = 0;
  for (const key of Object.keys(bo)) {
    if (bo[key] !== undefined) bCount += 1;
  }
  return aCount === bCount;
}

/** A key's value when it is an own property of `value`, else undefined. */
function own(value: JsonObject, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

/**
 * Set an own, enumerable property. Plain assignment of a remote-chosen key
 * such as `__proto__` would replace the object's prototype instead.
 */
function setOwn(target: JsonObject, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * Copy a JSON-like value so the document never aliases an object the caller
 * may still hold. Object keys whose value is `undefined` are dropped.
 */
function cloneJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (isPlainObject(value)) {
    const out: JsonObject = {};
    for (const key of Object.keys(value)) {
      const entry = value[key];
      if (entry !== undefined) setOwn(out, key, cloneJson(entry));
    }
    return out;
  }
  return value;
}

/** Build an (unintegrated) Y.Map mirroring a plain object, recursively. */
function objectToYMap(value: JsonObject): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  for (const key of Object.keys(value)) {
    const entry = value[key];
    if (entry === undefined) continue;
    map.set(key, isPlainObject(entry) ? objectToYMap(entry) : cloneJson(entry));
  }
  return map;
}

/** Bring `map` in line with `value`, touching only the keys that differ. */
function syncMap(map: Y.Map<unknown>, value: JsonObject): void {
  for (const key of Array.from(map.keys())) {
    if (own(value, key) === undefined) map.delete(key);
  }
  for (const key of Object.keys(value)) {
    if (value[key] !== undefined) syncField(map, key, value[key]);
  }
}

/** Read any stored value back into plain JSON. */
function readValue(value: unknown): unknown {
  if (value instanceof Y.Map) {
    if (isFeatureCollectionMap(value)) return readFeatureCollection(value);
    const out: JsonObject = {};
    value.forEach((entry, key) => {
      setOwn(out, key, readValue(entry));
    });
    return out;
  }
  return value;
}

/** Bring one key of `map` in line with `next`. */
function syncField(map: Y.Map<unknown>, key: string, next: unknown): void {
  const current = map.get(key);
  if (isPlainObject(next)) {
    if (current instanceof Y.Map && !isFeatureCollectionMap(current)) syncMap(current, next);
    else map.set(key, objectToYMap(next));
  } else if (current instanceof Y.AbstractType || !deepEqual(current, next)) {
    map.set(key, cloneJson(next));
  }
}

// -- FeatureCollections -------------------------------------------------------

function isFeatureCollectionValue(value: unknown): value is JsonObject & { features: unknown[] } {
  return (
    isPlainObject(value) && value.type === "FeatureCollection" && Array.isArray(value.features)
  );
}

function isFeatureCollectionMap(map: Y.Map<unknown>): boolean {
  // The generic writer never creates a Y.Array, so an `order` array is an
  // unambiguous marker of the feature-by-feature encoding.
  return map.get(FC_ORDER) instanceof Y.Array && map.get(FC_FEATURES) instanceof Y.Map;
}

interface FeatureCollectionParts {
  meta: Y.Map<unknown>;
  features: Y.Map<unknown>;
  order: Y.Array<string>;
}

function featureCollectionParts(map: Y.Map<unknown>): FeatureCollectionParts {
  return {
    meta: map.get(FC_META) as Y.Map<unknown>,
    features: map.get(FC_FEATURES) as Y.Map<unknown>,
    order: map.get(FC_ORDER) as Y.Array<string>,
  };
}

function readFeatureCollection(map: Y.Map<unknown>): JsonObject {
  const { meta, features, order } = featureCollectionParts(map);
  const out: JsonObject = meta instanceof Y.Map ? (readValue(meta) as JsonObject) : {};
  out.type = "FeatureCollection";
  out.features = liveKeys(order, features).map((key) => features.get(key));
  return out;
}

/**
 * The keys of `order` that still name a live entry, first occurrence only.
 * Concurrent edits can leave a key whose value was deleted, or (for layer
 * moves) the same key twice; readers skip both.
 */
function liveKeys(order: Y.Array<string>, values: { has(key: string): boolean }): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const key of order.toArray()) {
    if (typeof key !== "string" || seen.has(key) || !values.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/**
 * Delete dead and duplicate keys from `order` (and, when `values` is a Y.Map,
 * values no key references) so that the array matches what readers see. Run
 * inside the write transaction before diffing, so indexes line up.
 */
function compactOrder(order: Y.Array<string>, values: Y.Map<unknown>, pruneValues: boolean): void {
  const raw = order.toArray();
  const keep = new Set<string>();
  const drop: number[] = [];
  raw.forEach((key, index) => {
    if (typeof key !== "string" || keep.has(key) || !values.has(key)) drop.push(index);
    else keep.add(key);
  });
  for (let i = drop.length - 1; i >= 0; i -= 1) {
    // Merge runs so a large cleanup stays a handful of operations.
    let start = drop[i];
    let count = 1;
    while (i > 0 && drop[i - 1] === start - 1) {
      start -= 1;
      count += 1;
      i -= 1;
    }
    order.delete(start, count);
  }
  if (pruneValues) {
    for (const key of Array.from(values.keys())) {
      if (!keep.has(key)) values.delete(key);
    }
  }
}

/** Length of the common prefix and suffix of two lists under `same`. */
function commonEnds<A, B>(
  a: readonly A[],
  b: readonly B[],
  same: (x: A, y: B) => boolean,
): { prefix: number; suffix: number } {
  const max = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < max && same(a[prefix], b[prefix])) prefix += 1;
  let suffix = 0;
  while (suffix < max - prefix && same(a[a.length - 1 - suffix], b[b.length - 1 - suffix])) {
    suffix += 1;
  }
  return { prefix, suffix };
}

function writeFeatureCollection(
  parent: Y.Map<unknown>,
  key: string,
  value: JsonObject & { features: unknown[] },
  newKey: () => string,
): void {
  let map = parent.get(key);
  if (!(map instanceof Y.Map) || !isFeatureCollectionMap(map)) {
    map = new Y.Map<unknown>();
    parent.set(key, map);
    const fresh = map as Y.Map<unknown>;
    fresh.set(FC_META, new Y.Map<unknown>());
    fresh.set(FC_FEATURES, new Y.Map<unknown>());
    fresh.set(FC_ORDER, new Y.Array<string>());
  }
  const { meta, features, order } = featureCollectionParts(map as Y.Map<unknown>);
  const { features: nextFeatures, ...rest } = value;
  delete rest.type;
  syncMap(meta, rest);

  compactOrder(order, features, true);
  const keys = order.toArray();
  const current = keys.map((k) => features.get(k));
  const { prefix, suffix } = commonEnds(
    current,
    nextFeatures,
    (a, b) => a === b || deepEqual(a, b),
  );
  const oldEnd = current.length - suffix;
  const newEnd = nextFeatures.length - suffix;
  const segments = matchMiddle(current, nextFeatures, prefix, oldEnd, newEnd);
  // Walk the segments last to first so the indexes of earlier ones stay valid.
  for (let s = segments.length - 1; s >= 0; s -= 1) {
    const { oldStart, oldStop, newStart, newStop, anchor } = segments[s];
    // An anchor matched by GeoJSON id may still have been edited.
    if (anchor && !deepEqual(current[anchor[0]], nextFeatures[anchor[1]])) {
      features.set(keys[anchor[0]], cloneJson(nextFeatures[anchor[1]]));
    }
    const paired = pairable(current, nextFeatures, oldStart, oldStop, newStart, newStop);
    // Pair old and new features position by position: an edit in place keeps
    // the feature's key, so a concurrent edit to the same feature resolves on
    // one value and an edit to a neighbour is not disturbed.
    for (let i = 0; i < paired; i += 1) {
      if (!deepEqual(current[oldStart + i], nextFeatures[newStart + i])) {
        features.set(keys[oldStart + i], cloneJson(nextFeatures[newStart + i]));
      }
    }
    const removed = oldStop - oldStart - paired;
    if (removed > 0) {
      for (let i = oldStart + paired; i < oldStop; i += 1) features.delete(keys[i]);
      order.delete(oldStart + paired, removed);
    }
    if (newStop - newStart > paired) {
      const inserted: string[] = [];
      for (let i = newStart + paired; i < newStop; i += 1) {
        const featureKey = newKey();
        features.set(featureKey, cloneJson(nextFeatures[i]));
        inserted.push(featureKey);
      }
      order.insert(oldStart + paired, inserted);
    }
  }
}

/** A feature's GeoJSON `id`, when it has a usable one. */
function featureId(feature: unknown): string | null {
  if (!isPlainObject(feature)) return null;
  const id = feature.id;
  if (typeof id === "string" && id) return `s:${id}`;
  if (typeof id === "number" && Number.isFinite(id)) return `n:${id}`;
  return null;
}

/**
 * How many leading positions of a changed run pair up as edits in place.
 * Two features that both carry (different) GeoJSON ids are different
 * features, so pairing stops there and the rest are removed and inserted.
 */
function pairable(
  current: readonly unknown[],
  next: readonly unknown[],
  oldStart: number,
  oldStop: number,
  newStart: number,
  newStop: number,
): number {
  const max = Math.min(oldStop - oldStart, newStop - newStart);
  let paired = 0;
  while (paired < max) {
    const a = featureId(current[oldStart + paired]);
    const b = featureId(next[newStart + paired]);
    if (a !== null && b !== null && a !== b) break;
    paired += 1;
  }
  return paired;
}

interface Segment {
  oldStart: number;
  oldStop: number;
  newStart: number;
  newStop: number;
  /** The matched old/new pair that ends this run (absent for the last run). */
  anchor?: [number, number];
}

/**
 * Split the changed middle of a feature list into the runs between features
 * that survive unchanged, so those keep their keys. Unchanged features are
 * matched greedily, in order, by their JSON; the cost is linear in the size of
 * the middle (each candidate list is walked once, by a cursor), which is
 * small for an ordinary edit.
 */
function matchMiddle(
  current: readonly unknown[],
  next: readonly unknown[],
  start: number,
  oldEnd: number,
  newEnd: number,
): Segment[] {
  const segments: Segment[] = [];
  if (oldEnd - start > 0 && newEnd - start > 0) {
    const byJson = new Map<string, { indexes: number[]; at: number }>();
    // A feature with a GeoJSON id matches by id (an edited feature keeps its
    // key even if it moved); one without matches by its whole JSON.
    const fingerprint = (feature: unknown) => featureId(feature) ?? `j:${JSON.stringify(feature)}`;
    for (let i = start; i < oldEnd; i += 1) {
      const json = fingerprint(current[i]);
      const bucket = byJson.get(json);
      if (bucket) bucket.indexes.push(i);
      else byJson.set(json, { indexes: [i], at: 0 });
    }
    let oldCursor = start;
    let newCursor = start;
    for (let j = start; j < newEnd; j += 1) {
      const bucket = byJson.get(fingerprint(next[j]));
      if (!bucket) continue;
      while (bucket.at < bucket.indexes.length && bucket.indexes[bucket.at] < oldCursor) {
        bucket.at += 1;
      }
      if (bucket.at >= bucket.indexes.length) continue;
      const i = bucket.indexes[bucket.at];
      bucket.at += 1;
      segments.push({
        oldStart: oldCursor,
        oldStop: i,
        newStart: newCursor,
        newStop: j,
        anchor: [i, j],
      });
      oldCursor = i + 1;
      newCursor = j + 1;
    }
    segments.push({ oldStart: oldCursor, oldStop: oldEnd, newStart: newCursor, newStop: newEnd });
  } else {
    segments.push({ oldStart: start, oldStop: oldEnd, newStart: start, newStop: newEnd });
  }
  return segments;
}

// -- Layers ------------------------------------------------------------------

function layerId(layer: unknown): string | null {
  return isPlainObject(layer) && typeof layer.id === "string" && layer.id ? layer.id : null;
}

function syncLayer(
  map: Y.Map<unknown>,
  layer: JsonObject,
  newKey: () => string,
  skipGeojson = false,
): void {
  for (const key of Array.from(map.keys())) {
    if (own(layer, key) === undefined) map.delete(key);
  }
  for (const key of Object.keys(layer)) {
    const next = layer[key];
    if (next === undefined) continue;
    if (key === "geojson" && isFeatureCollectionValue(next)) {
      // The same collection object the document last wrote or read for this
      // layer: skip the per-feature comparison (a style edit on a big layer).
      if (!skipGeojson) writeFeatureCollection(map, key, next, newKey);
    } else {
      syncField(map, key, next);
    }
  }
}

/**
 * A project mirrored into a Yjs document, with diff-based writes and cached
 * reads.
 *
 * {@link write} compares the given project with the document and records only
 * the differences, so calling it with the full project after every store
 * change produces small updates. {@link read} rebuilds the project, reusing the
 * previous object for every layer no update touched, so a consumer comparing
 * layers by reference (the map's layer sync) only redraws what changed.
 *
 * Immutability contract: values passed to `write` and returned by `read` are
 * treated as immutable, like Zustand store state. Both remember objects by
 * identity to skip unchanged layers and fields, so mutating one in place and
 * writing it again records nothing. Replace an object to change it.
 */
export class ProjectDoc {
  readonly doc: Y.Doc;
  readonly fields: Y.Map<unknown>;
  readonly layers: Y.Map<Y.Map<unknown>>;
  readonly layerOrder: Y.Array<string>;
  private featureCounter = 0;
  /**
   * Random per-instance prefix for feature keys, so two wrappers over one
   * document (a reconnect, a hot reload) never mint the same key.
   */
  private readonly keyNonce = Math.floor(Math.random() * 2 ** 32).toString(36);
  /**
   * Per layer, an object known to equal the document's copy of it: the one a
   * read produced or a write recorded. A write handed that same object again
   * skips the comparison, and a read returns it again. Any change to the
   * layer in the document (local or remote) drops the entry.
   */
  private readonly layerCache = new Map<string, { map: Y.Map<unknown>; value: JsonObject }>();
  /** The same, per top-level field. */
  private readonly fieldCache = new Map<string, unknown>();
  /** Per layer, the FeatureCollection object known to equal the document's. */
  private readonly geojsonCache = new Map<string, unknown>();
  private readonly onLayers: (
    events: Y.YEvent<Y.AbstractType<unknown>>[],
    t: Y.Transaction,
  ) => void;
  private readonly onFields: (
    events: Y.YEvent<Y.AbstractType<unknown>>[],
    t: Y.Transaction,
  ) => void;

  /** The transaction `write` is running, while it runs. */
  private activeWrite: Y.Transaction | null = null;
  /** Keys another transaction changed while `write` was still running. */
  private readonly foreignChanges = { fields: new Set<string>(), layers: new Set<string>() };

  constructor(doc: Y.Doc = new Y.Doc()) {
    this.doc = doc;
    this.fields = doc.getMap<unknown>(ROOT_FIELDS);
    this.layers = doc.getMap<Y.Map<unknown>>(ROOT_LAYERS);
    this.layerOrder = doc.getArray<string>(ROOT_LAYER_ORDER);
    this.onLayers = (events, transaction) =>
      this.invalidate(
        events,
        transaction,
        [this.layerCache, this.geojsonCache],
        this.foreignChanges.layers,
      );
    this.onFields = (events, transaction) =>
      this.invalidate(events, transaction, [this.fieldCache], this.foreignChanges.fields);
    this.layers.observeDeep(this.onLayers);
    this.fields.observeDeep(this.onFields);
  }

  /** Stop observing the document and drop the caches (the doc lives on). */
  destroy(): void {
    this.layers.unobserveDeep(this.onLayers);
    this.fields.unobserveDeep(this.onFields);
    this.layerCache.clear();
    this.fieldCache.clear();
    this.geojsonCache.clear();
  }

  /**
   * Drop the cache entries of every top-level key a batch of events touched,
   * noting the keys changed by anything but the running `write`.
   */
  private invalidate(
    events: Y.YEvent<Y.AbstractType<unknown>>[],
    transaction: Y.Transaction,
    caches: Map<string, unknown>[],
    foreign: Set<string>,
  ): void {
    const record = (key: string) => {
      for (const cache of caches) cache.delete(key);
      if (this.activeWrite && transaction !== this.activeWrite) foreign.add(key);
    };
    for (const event of events) {
      if (event.path.length === 0) {
        for (const key of event.keys.keys()) record(key);
      } else {
        record(String(event.path[0]));
      }
    }
  }

  /** Whether the document holds no project yet. */
  isEmpty(): boolean {
    return this.fields.size === 0 && this.layers.size === 0 && this.layerOrder.length === 0;
  }

  /** A key for a new feature, unique across every client of the document. */
  private newFeatureKey = (): string => {
    this.featureCounter += 1;
    return `${this.doc.clientID.toString(36)}.${this.keyNonce}.${this.featureCounter.toString(36)}`;
  };

  /**
   * Record the differences between `project` and the document in one
   * transaction tagged with `origin` (which an undo manager filters on).
   *
   * The diff is against the document, not against what the writer last saw,
   * so a key or layer missing from `project` is deleted. A client must
   * therefore write only once it holds the session's state (after its first
   * sync), or into an empty document; writing a stale or empty project
   * otherwise deletes what it lacks.
   *
   * Called inside a transaction the caller opened, the write joins it and
   * takes that transaction's origin (Yjs keeps the outermost one), and the
   * identity shortcuts are skipped, since the caller may have changed the
   * document in the same transaction.
   */
  write(project: ProjectRecord, origin: unknown = null, options: ProjectWriteOptions = {}): void {
    const ignore = options.ignore;
    const writtenFields: [string, unknown][] = [];
    const writtenLayers: [string, JsonObject][] = [];
    const nested = this.doc._transaction !== null;
    this.foreignChanges.fields.clear();
    this.foreignChanges.layers.clear();
    try {
      this.doc.transact((transaction) => {
        this.activeWrite = transaction;
        for (const key of Array.from(this.fields.keys())) {
          if (key !== "layers" && !ignore?.has(key) && own(project, key) === undefined) {
            this.fields.delete(key);
          }
        }
        for (const key of Object.keys(project)) {
          if (key === "layers" || ignore?.has(key)) continue;
          const next = project[key];
          if (next === undefined) continue;
          if (!nested && this.fieldCache.has(key) && this.fieldCache.get(key) === next) continue;
          syncField(this.fields, key, next);
          writtenFields.push([key, next]);
        }
        if (ignore?.has("layers")) return;
        const nextLayers = Array.isArray(project.layers) ? project.layers : [];
        const byId = new Map<string, JsonObject>();
        for (const layer of nextLayers) {
          const id = layerId(layer);
          if (id && !byId.has(id)) byId.set(id, layer as JsonObject);
        }
        for (const id of Array.from(this.layers.keys())) {
          if (!byId.has(id)) this.layers.delete(id);
        }
        for (const [id, layer] of byId) {
          const existing = this.layers.get(id);
          const cached = this.layerCache.get(id);
          if (
            !nested &&
            existing instanceof Y.Map &&
            cached?.map === existing &&
            cached.value === layer
          ) {
            continue;
          }
          const sameGeojson =
            !nested &&
            layer.geojson !== undefined &&
            this.geojsonCache.get(id) === layer.geojson &&
            existing instanceof Y.Map;
          if (existing instanceof Y.Map) {
            syncLayer(existing, layer, this.newFeatureKey, sameGeojson);
          } else {
            const map = new Y.Map<unknown>();
            this.layers.set(id, map);
            syncLayer(map, layer, this.newFeatureKey);
          }
          writtenLayers.push([id, layer]);
        }
        compactOrder(this.layerOrder, this.layers as Y.Map<unknown>, false);
        const order = this.layerOrder.toArray();
        const desired = Array.from(byId.keys());
        const { prefix, suffix } = commonEnds(order, desired, (a, b) => a === b);
        const oldEnd = order.length - suffix;
        const newEnd = desired.length - suffix;
        if (oldEnd > prefix) this.layerOrder.delete(prefix, oldEnd - prefix);
        if (newEnd > prefix) this.layerOrder.insert(prefix, desired.slice(prefix, newEnd));
      }, origin);
    } finally {
      this.activeWrite = null;
    }
    // Observers ran (and dropped these entries) as the transaction closed, so
    // record what the document now equals only afterwards, and not for a key
    // an update handler changed again in the meantime.
    if (nested) return;
    for (const [key, value] of writtenFields) {
      if (!this.foreignChanges.fields.has(key)) this.fieldCache.set(key, value);
    }
    if (nested) return;
    for (const [id, value] of writtenLayers) {
      const map = this.layers.get(id);
      if (map instanceof Y.Map && !this.foreignChanges.layers.has(id)) {
        this.layerCache.set(id, { map, value });
        if (isFeatureCollectionValue(value.geojson)) this.geojsonCache.set(id, value.geojson);
      }
    }
  }

  /** The project the document currently holds, as plain JSON. */
  read(): ProjectRecord {
    const project: JsonObject = {};
    this.fields.forEach((value, key) => {
      if (key === "layers") return;
      if (this.fieldCache.has(key)) {
        setOwn(project, key, this.fieldCache.get(key));
        return;
      }
      const read = readValue(value);
      this.fieldCache.set(key, read);
      setOwn(project, key, read);
    });
    const ids = liveKeys(this.layerOrder, this.layers);
    // A layer whose id never reached the order array (it should not happen,
    // but a hand-built doc could) still renders, on top, in a stable order.
    const listed = new Set(ids);
    const strays = Array.from(this.layers.keys())
      .filter((id) => !listed.has(id))
      .sort();
    project.layers = [...ids, ...strays].map((id) => this.readLayer(id));
    return project;
  }

  private readLayer(id: string): JsonObject {
    const map = this.layers.get(id) as Y.Map<unknown>;
    const cached = this.layerCache.get(id);
    if (cached && cached.map === map) return cached.value;
    const value = readValue(map) as JsonObject;
    value.id = id;
    this.layerCache.set(id, { map, value });
    if (isFeatureCollectionValue(value.geojson)) this.geojsonCache.set(id, value.geojson);
    return value;
  }
}

/**
 * A per-user undo history over a {@link ProjectDoc}: it records only
 * transactions whose origin is `localOrigin`, so undoing never reverts a
 * collaborator's edit (#3530).
 */
export function createLocalUndoManager(
  project: ProjectDoc,
  localOrigin: unknown,
  captureTimeout = 400,
): Y.UndoManager {
  // Yjs gives an update applied without an origin the origin `null`, so a
  // null (or undefined) local origin would record collaborators' edits too.
  if (localOrigin === null || localOrigin === undefined) {
    throw new TypeError("createLocalUndoManager needs a non-null local origin.");
  }
  // Match the origin by identity: Yjs also tracks an origin whose
  // *constructor* is in trackedOrigins, which a constructor-valued origin
  // would turn into "every plain-object origin".
  const manager: Y.UndoManager = new Y.UndoManager(
    [project.fields, project.layers, project.layerOrder],
    {
      trackedOrigins: new Set([localOrigin]),
      captureTimeout,
      captureTransaction: (transaction) =>
        transaction.origin === localOrigin || transaction.origin === manager,
    },
  );
  return manager;
}

// -- Update framing -------------------------------------------------------------

/**
 * Largest update payload (bytes, before base64) carried by one frame. A large
 * update (a whole layer of features) is split into numbered chunks so no
 * WebSocket message gets near a platform limit (Cloudflare refuses received
 * messages over 32 MiB), and the receiver reassembles it before applying.
 */
export const MAX_UPDATE_CHUNK_BYTES = 512 * 1024;

/** Chunk header of an update that spans several frames. */
export interface UpdateChunk {
  id: string;
  index: number;
  count: number;
}

/** One frame's worth of a document update. */
export interface UpdateFrame {
  update: string;
  chunk?: UpdateChunk;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i += 1) table[B64.charCodeAt(i)] = i;
  return table;
})();

/** Standard (padded) base64 of `bytes`, without depending on `btoa`. */
export function encodeBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let line = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    line +=
      B64[(n >> 18) & 63] +
      B64[(n >> 12) & 63] +
      (i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=") +
      (i + 2 < bytes.length ? B64[n & 63] : "=");
    if (line.length >= 8192) {
      parts.push(line);
      line = "";
    }
  }
  parts.push(line);
  return parts.join("");
}

/** Decode standard base64; returns null for malformed input. */
export function decodeBase64(text: unknown): Uint8Array | null {
  if (typeof text !== "string" || text.length % 4 !== 0) return null;
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - padding);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    let n = 0;
    for (let j = 0; j < 4; j += 1) {
      const code = text.charCodeAt(i + j);
      const isPad = code === 61 && i + j >= text.length - padding;
      const v = isPad ? 0 : code < 128 ? B64_LOOKUP[code] : -1;
      if (v < 0) return null;
      n = (n << 6) | v;
    }
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

/**
 * Split an update into frames of at most `MAX_UPDATE_CHUNK_BYTES` payload
 * each. A small update is a single frame with no chunk header.
 */
export function splitUpdate(update: Uint8Array, makeId: () => string): UpdateFrame[] {
  const maxBytes = MAX_UPDATE_CHUNK_BYTES;
  if (update.length <= maxBytes) return [{ update: encodeBase64(update) }];
  const count = Math.ceil(update.length / maxBytes);
  const id = makeId();
  if (typeof id !== "string" || !id || id.length > 64) {
    throw new RangeError("splitUpdate needs a chunk id of 1 to 64 characters.");
  }
  const frames: UpdateFrame[] = [];
  for (let index = 0; index < count; index += 1) {
    frames.push({
      update: encodeBase64(update.subarray(index * maxBytes, (index + 1) * maxBytes)),
      chunk: { id, index, count },
    });
  }
  return frames;
}

export type AssembleResult =
  | { status: "complete"; update: Uint8Array }
  | { status: "pending" }
  | { status: "error"; reason: "malformed" | "too-large" | "out-of-order" };

interface PendingAssembly {
  id: string;
  count: number;
  next: number;
  parts: Uint8Array[];
  bytes: number;
}

/**
 * Reassembles chunked update frames, one stream per sender. Chunks of one
 * update must arrive in order (a WebSocket preserves order), and a sender has
 * at most one update in flight; anything else is reported so the caller can
 * ask the sender to resynchronize instead of applying a corrupt update.
 */
export class UpdateAssembler {
  private readonly pending = new Map<string, PendingAssembly>();

  /** @param maxBytes - Ceiling on one reassembled update. */
  constructor(private readonly maxBytes: number) {}

  push(sender: string, frame: { update?: unknown; chunk?: unknown }): AssembleResult {
    // Refuse an oversized frame by its text length, before decoding allocates it.
    if (
      typeof frame.update === "string" &&
      frame.update.length > Math.ceil(this.maxBytes / 3) * 4
    ) {
      this.pending.delete(sender);
      return { status: "error", reason: "too-large" };
    }
    const bytes = decodeBase64(frame.update);
    if (!bytes) {
      this.pending.delete(sender);
      return { status: "error", reason: "malformed" };
    }
    const chunk = frame.chunk as Partial<UpdateChunk> | undefined;
    const inFlight = this.pending.get(sender);
    // One update at a time per sender: a new update (unchunked, or a first
    // chunk) while another is half received means frames went missing.
    if (inFlight && (chunk === undefined || chunk?.index === 0)) {
      this.pending.delete(sender);
      return { status: "error", reason: "out-of-order" };
    }
    if (chunk === undefined) {
      if (bytes.length === 0) return { status: "error", reason: "malformed" };
      if (bytes.length > this.maxBytes) return { status: "error", reason: "too-large" };
      return { status: "complete", update: bytes };
    }
    const { id, index, count } = chunk ?? {};
    if (
      typeof id !== "string" ||
      !id ||
      id.length > 64 ||
      !Number.isSafeInteger(index) ||
      !Number.isSafeInteger(count) ||
      (count as number) < 1 ||
      (index as number) < 0 ||
      (index as number) >= (count as number) ||
      // `splitUpdate` fills every chunk but the last, so a chunk of any other
      // size (an empty one in particular) is not ours. This also bounds `count`
      // and the parts a sender can make us hold.
      (count as number) > Math.ceil(this.maxBytes / MAX_UPDATE_CHUNK_BYTES) ||
      ((index as number) < (count as number) - 1
        ? bytes.length !== MAX_UPDATE_CHUNK_BYTES
        : bytes.length === 0 || bytes.length > MAX_UPDATE_CHUNK_BYTES)
    ) {
      this.pending.delete(sender);
      return { status: "error", reason: "malformed" };
    }
    let entry = this.pending.get(sender);
    if (index === 0) {
      entry = { id, count: count as number, next: 0, parts: [], bytes: 0 };
      this.pending.set(sender, entry);
    }
    if (!entry || entry.id !== id || entry.count !== count || entry.next !== index) {
      this.pending.delete(sender);
      return { status: "error", reason: "out-of-order" };
    }
    entry.bytes += bytes.length;
    if (entry.bytes > this.maxBytes) {
      this.pending.delete(sender);
      return { status: "error", reason: "too-large" };
    }
    entry.parts.push(bytes);
    entry.next += 1;
    if (entry.next < entry.count) return { status: "pending" };
    this.pending.delete(sender);
    const update = new Uint8Array(entry.bytes);
    let offset = 0;
    for (const part of entry.parts) {
      update.set(part, offset);
      offset += part.length;
    }
    return { status: "complete", update };
  }

  /** Drop a sender's partial update (it disconnected or resynchronized). */
  forget(sender: string): void {
    this.pending.delete(sender);
  }
}

export { Y };
