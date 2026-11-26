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
      if (entry !== undefined) out[key] = cloneJson(entry);
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
    if (value[key] === undefined) map.delete(key);
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
      out[key] = readValue(entry);
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
  const { features: nextFeatures, type: _type, ...rest } = value;
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
  if (oldEnd - prefix === newEnd - prefix) {
    // Same count in the changed middle: edits in place, keeping each feature's
    // key so a concurrent edit to a neighbour is not disturbed.
    for (let i = prefix; i < oldEnd; i += 1) {
      if (!deepEqual(current[i], nextFeatures[i])) {
        features.set(keys[i], cloneJson(nextFeatures[i]));
      }
    }
    return;
  }
  for (let i = prefix; i < oldEnd; i += 1) features.delete(keys[i]);
  if (oldEnd > prefix) order.delete(prefix, oldEnd - prefix);
  const inserted: string[] = [];
  for (let i = prefix; i < newEnd; i += 1) {
    const featureKey = newKey();
    features.set(featureKey, cloneJson(nextFeatures[i]));
    inserted.push(featureKey);
  }
  if (inserted.length) order.insert(prefix, inserted);
}

// -- Layers ------------------------------------------------------------------

function layerId(layer: unknown): string | null {
  return isPlainObject(layer) && typeof layer.id === "string" && layer.id ? layer.id : null;
}

function syncLayer(map: Y.Map<unknown>, layer: JsonObject, newKey: () => string): void {
  for (const key of Array.from(map.keys())) {
    if (layer[key] === undefined) map.delete(key);
  }
  for (const key of Object.keys(layer)) {
    const next = layer[key];
    if (next === undefined) continue;
    if (key === "geojson" && isFeatureCollectionValue(next)) {
      writeFeatureCollection(map, key, next, newKey);
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
 */
export class ProjectDoc {
  readonly doc: Y.Doc;
  readonly fields: Y.Map<unknown>;
  readonly layers: Y.Map<Y.Map<unknown>>;
  readonly layerOrder: Y.Array<string>;
  private featureCounter = 0;
  /**
   * Per layer, an object known to equal the document's copy of it: the one a
   * read produced or a write recorded. A write handed that same object again
   * skips the comparison, and a read returns it again. Any change to the
   * layer in the document (local or remote) drops the entry.
   */
  private readonly layerCache = new Map<string, { map: Y.Map<unknown>; value: JsonObject }>();
  /** The same, per top-level field. */
  private readonly fieldCache = new Map<string, unknown>();

  constructor(doc: Y.Doc = new Y.Doc()) {
    this.doc = doc;
    this.fields = doc.getMap<unknown>(ROOT_FIELDS);
    this.layers = doc.getMap<Y.Map<unknown>>(ROOT_LAYERS);
    this.layerOrder = doc.getArray<string>(ROOT_LAYER_ORDER);
    this.layers.observeDeep((events) => invalidate(events, this.layerCache));
    this.fields.observeDeep((events) => invalidate(events, this.fieldCache));
  }

  /** Whether the document holds no project yet. */
  isEmpty(): boolean {
    return this.fields.size === 0 && this.layers.size === 0 && this.layerOrder.length === 0;
  }

  /** A key for a new feature, unique across every client of the document. */
  private newFeatureKey = (): string => {
    this.featureCounter += 1;
    return `${this.doc.clientID.toString(36)}.${this.featureCounter.toString(36)}`;
  };

  /**
   * Record the differences between `project` and the document in one
   * transaction tagged with `origin` (which an undo manager filters on).
   */
  write(project: ProjectRecord, origin: unknown = null, options: ProjectWriteOptions = {}): void {
    const ignore = options.ignore;
    const writtenFields: [string, unknown][] = [];
    const writtenLayers: [string, JsonObject][] = [];
    this.doc.transact(() => {
      for (const key of Array.from(this.fields.keys())) {
        if (key !== "layers" && !ignore?.has(key) && project[key] === undefined) {
          this.fields.delete(key);
        }
      }
      for (const key of Object.keys(project)) {
        if (key === "layers" || ignore?.has(key)) continue;
        const next = project[key];
        if (next === undefined) continue;
        if (this.fieldCache.has(key) && this.fieldCache.get(key) === next) continue;
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
        if (existing instanceof Y.Map && cached?.map === existing && cached.value === layer) {
          continue;
        }
        if (existing instanceof Y.Map) {
          syncLayer(existing, layer, this.newFeatureKey);
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
    // Observers ran (and dropped these entries) as the transaction closed, so
    // record what the document now equals only afterwards.
    for (const [key, value] of writtenFields) this.fieldCache.set(key, value);
    for (const [id, value] of writtenLayers) {
      const map = this.layers.get(id);
      if (map instanceof Y.Map) this.layerCache.set(id, { map, value });
    }
  }

  /** The project the document currently holds, as plain JSON. */
  read(): ProjectRecord {
    const project: JsonObject = {};
    this.fields.forEach((value, key) => {
      if (key === "layers") return;
      if (this.fieldCache.has(key)) {
        project[key] = this.fieldCache.get(key);
        return;
      }
      const read = readValue(value);
      this.fieldCache.set(key, read);
      project[key] = read;
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
    return value;
  }
}

/** Drop the cache entries of every top-level key a batch of events touched. */
function invalidate(
  events: Y.YEvent<Y.AbstractType<unknown>>[],
  cache: Map<string, unknown>,
): void {
  for (const event of events) {
    if (event.path.length === 0) {
      for (const key of event.keys.keys()) cache.delete(key);
    } else {
      cache.delete(String(event.path[0]));
    }
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
  return new Y.UndoManager([project.fields, project.layers, project.layerOrder], {
    trackedOrigins: new Set([localOrigin]),
    captureTimeout,
  });
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
 * Split an update into frames of at most `maxBytes` payload each. A small
 * update is a single frame with no chunk header.
 */
export function splitUpdate(
  update: Uint8Array,
  makeId: () => string,
  maxBytes = MAX_UPDATE_CHUNK_BYTES,
): UpdateFrame[] {
  if (update.length <= maxBytes) return [{ update: encodeBase64(update) }];
  const count = Math.ceil(update.length / maxBytes);
  const id = makeId();
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
    const bytes = decodeBase64(frame.update);
    if (!bytes) {
      this.pending.delete(sender);
      return { status: "error", reason: "malformed" };
    }
    const chunk = frame.chunk as Partial<UpdateChunk> | undefined;
    if (chunk === undefined) {
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
      (index as number) >= (count as number)
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
