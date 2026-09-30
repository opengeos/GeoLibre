// Persistent point labels. Buffer indices change whenever streaming reloads or
// compacts a cloud, so an edit is stored against the point's stable identity:
// the source node key (COPC/EPT octree key, or "file") and the point's index
// within that node, from maplibre-gl-lidar's `nodeRanges`.

import { Inflate, deflateSync } from "fflate";

/** A run of buffer indices holding one source node's points, in file order. */
export interface NodeRange {
  key: string;
  start: number;
  count: number;
}

/** The point data a label store reads and writes. */
export interface LabelledCloud {
  classifications?: Uint8Array;
  nodeRanges?: readonly NodeRange[];
}

/** Node ranges alone, enough to key per-point values other than the class. */
export interface RangedCloud {
  nodeRanges?: readonly NodeRange[];
}

/** Serialised labels for one source: node key -> base64(deflate(edits)). */
export type EncodedSourceLabels = Record<string, string>;

/**
 * Project state: each source's encoded labels. The URL is a value, not an
 * object key, so project credential redaction scrubs a signed URL.
 */
export interface EncodedLabelStore {
  version: 1;
  sources: { url: string; nodes: EncodedSourceLabels }[];
  /** Per-point object (instance) ids, same layout with varint values. */
  instances?: { url: string; nodes: EncodedSourceLabels }[];
}

/**
 * Finds the node range holding a buffer index.
 *
 * @param ranges - Ranges ascending by `start`.
 * @param index - Buffer index.
 * @returns The range, or undefined when the index is in no loaded node.
 */
export function rangeForIndex(ranges: readonly NodeRange[], index: number): NodeRange | undefined {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const range = ranges[mid];
    if (index < range.start) hi = mid - 1;
    else if (index >= range.start + range.count) lo = mid + 1;
    else return range;
  }
  return undefined;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function pushVarint(out: number[], value: number): void {
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  out.push(rest);
}

/**
 * Encodes a node's edits as (delta-varint index, value) pairs, ascending by
 * index, then deflates them. The value is a class byte, or a varint for
 * `wide` values such as object ids.
 *
 * @param edits - Index within the node -> class code (or object id).
 * @param wide - Encode values as varints (up to 32 bits) instead of bytes.
 * @returns base64 text.
 */
export function encodeNodeEdits(edits: ReadonlyMap<number, number>, wide = false): string {
  const indices = [...edits.keys()].sort((a, b) => a - b);
  const out: number[] = [];
  let previous = -1;
  for (const index of indices) {
    let delta = index - previous - 1;
    previous = index;
    while (delta >= 0x80) {
      out.push((delta & 0x7f) | 0x80);
      delta >>>= 7;
    }
    out.push(delta);
    if (wide) pushVarint(out, edits.get(index)! >>> 0);
    else out.push(edits.get(index)! & 0xff);
  }
  return toBase64(deflateSync(Uint8Array.from(out), { level: 9 }));
}

/**
 * Largest inflated size of one node's edits. A node holds at most a few
 * hundred thousand points at up to 6 bytes each, so this is generous; it
 * stops a crafted project file from inflating a tiny string into gigabytes.
 */
export const MAX_NODE_EDIT_BYTES = 16 * 1024 * 1024;

/** Largest total inflated size of all labels in one project. */
export const MAX_LABEL_BYTES = 256 * 1024 * 1024;

/** A shared allowance of inflated bytes, drawn down across many records. */
export interface InflateBudget {
  remaining: number;
}

/**
 * Compressed bytes fed to the inflater per push. Deflate expands at most
 * ~1032:1, so one push can produce at most about 1 MB before the caps below
 * are checked again.
 */
const INFLATE_SLICE = 1024;

/**
 * Inflates with a size cap, feeding the input in small slices so a
 * decompression bomb is stopped before it allocates much past the cap.
 *
 * @param data - Deflated bytes.
 * @param limit - Maximum inflated size of this record.
 * @param budget - Shared allowance, charged for every inflated byte (also
 *   when the record is later rejected).
 * @returns The inflated bytes.
 * @throws RangeError when the output would exceed `limit` or the budget.
 */
function inflateCapped(data: Uint8Array, limit: number, budget?: InflateBudget): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const inflater = new Inflate((chunk) => {
    total += chunk.length;
    if (budget) budget.remaining -= chunk.length;
    if (total > limit || (budget && budget.remaining < 0)) {
      throw new RangeError("point label record is too large");
    }
    chunks.push(chunk);
  });
  if (data.length === 0) inflater.push(data, true);
  for (let at = 0; at < data.length; at += INFLATE_SLICE) {
    const end = Math.min(at + INFLATE_SLICE, data.length);
    inflater.push(data.subarray(at, end), end === data.length);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * Decodes {@link encodeNodeEdits} output.
 *
 * @param text - base64 text.
 * @param limit - Maximum inflated size of this record.
 * @param budget - Shared inflate allowance across records.
 * @param wide - Values are varints (object ids) rather than class bytes.
 * @returns Index within the node -> class code (or object id).
 */
export function decodeNodeEdits(
  text: string,
  limit = MAX_NODE_EDIT_BYTES,
  budget?: InflateBudget,
  wide = false,
): Map<number, number> {
  const bytes = inflateCapped(fromBase64(text), limit, budget);
  const edits = new Map<number, number>();
  let previous = -1;
  let at = 0;
  while (at < bytes.length) {
    let delta = 0;
    let shift = 0;
    let byte: number;
    do {
      // A truncated record throws, so load() drops the node instead of
      // relabelling the wrong point.
      if (at >= bytes.length) throw new RangeError("truncated point label record");
      byte = bytes[at++];
      delta += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    const index = previous + 1 + delta;
    previous = index;
    if (at >= bytes.length) throw new RangeError("truncated point label record");
    if (!wide) {
      edits.set(index, bytes[at++]);
      continue;
    }
    let value = 0;
    shift = 0;
    do {
      if (at >= bytes.length) throw new RangeError("truncated point label record");
      // An object id is a uint32: at most five varint bytes.
      if (shift > 28) throw new RangeError("invalid point label record");
      byte = bytes[at++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    if (value > 0xffffffff) throw new RangeError("invalid point label record");
    edits.set(index, value);
  }
  return edits;
}

type NodeEdits = Map<string, Map<number, number>>;

/** Encodes one kind of per-source edits for the project file. */
function encodeSources(
  sources: Map<string, NodeEdits>,
  wide: boolean,
): { url: string; nodes: EncodedSourceLabels }[] {
  const out: { url: string; nodes: EncodedSourceLabels }[] = [];
  for (const [url, nodes] of sources) {
    const encoded: EncodedSourceLabels = {};
    for (const [key, edits] of nodes) {
      if (edits.size > 0) encoded[key] = encodeNodeEdits(edits, wide);
    }
    out.push({ url, nodes: encoded });
  }
  return out;
}

/** Decodes {@link encodeSources} output, skipping malformed entries. */
function decodeSources(
  entries: unknown,
  budget: InflateBudget,
  wide: boolean,
): Map<string, NodeEdits> {
  const out = new Map<string, NodeEdits>();
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    const source = (entry as { url?: unknown } | null)?.url;
    const encoded = (entry as { nodes?: unknown } | null)?.nodes;
    if (typeof source !== "string" || !encoded || typeof encoded !== "object") continue;
    const nodes: NodeEdits = out.get(source) ?? new Map();
    for (const [key, text] of Object.entries(encoded)) {
      if (typeof text !== "string") continue;
      if (budget.remaining <= 0) break;
      try {
        nodes.set(key, decodeNodeEdits(text, MAX_NODE_EDIT_BYTES, budget, wide));
      } catch {
        // Skip a corrupt node rather than the whole project.
      }
    }
    if (nodes.size > 0) out.set(source, nodes);
  }
  return out;
}

/** Point class edits for every labelled source, keyed by stable point identity. */
export class PointLabelStore {
  private sources = new Map<string, NodeEdits>();
  /** Object ids by source; 0 (no object) is not stored. */
  private instanceSources = new Map<string, NodeEdits>();

  /** Whether any source has edits. */
  get isEmpty(): boolean {
    return this.sources.size === 0 && this.instanceSources.size === 0;
  }

  /** Source URLs with edits. */
  get sourceUrls(): string[] {
    return [...this.sources.keys()];
  }

  /**
   * Records the current class of edited points.
   *
   * @param source - The cloud's source URL.
   * @param cloud - Its live data (classifications + node ranges).
   * @param indices - Buffer indices whose class changed.
   * @returns How many points were recorded (those inside a loaded node).
   */
  record(source: string, cloud: LabelledCloud, indices: ArrayLike<number>): number {
    const ranges = cloud.nodeRanges;
    const classes = cloud.classifications;
    if (!ranges || !classes) return 0;
    let nodes = this.sources.get(source);
    if (!nodes) {
      nodes = new Map();
      this.sources.set(source, nodes);
    }
    let recorded = 0;
    for (let i = 0; i < indices.length; i++) {
      const index = indices[i];
      const range = rangeForIndex(ranges, index);
      if (!range) continue;
      let edits = nodes.get(range.key);
      if (!edits) {
        edits = new Map();
        nodes.set(range.key, edits);
      }
      edits.set(index - range.start, classes[index]);
      recorded++;
    }
    if (nodes.size === 0) this.sources.delete(source);
    return recorded;
  }

  /**
   * Writes a source's stored classes into the loaded points.
   *
   * @param source - The cloud's source URL.
   * @param cloud - Its live data.
   * @returns How many points changed class.
   */
  apply(source: string, cloud: LabelledCloud): number {
    const nodes = this.sources.get(source);
    const ranges = cloud.nodeRanges;
    const classes = cloud.classifications;
    if (!nodes || !ranges || !classes) return 0;
    let changed = 0;
    for (const range of ranges) {
      const edits: Map<number, number> | undefined = nodes.get(range.key);
      if (!edits) continue;
      for (const [offset, code] of edits.entries() as Iterable<[number, number]>) {
        if (offset >= range.count) continue;
        const index = range.start + offset;
        if (classes[index] !== code) {
          classes[index] = code;
          changed++;
        }
      }
    }
    return changed;
  }

  /**
   * Records the object ids of edited points (0 removes a point from its object).
   *
   * @param source - The cloud's source URL.
   * @param cloud - Its node ranges.
   * @param instances - Per-point object ids, parallel to the cloud's buffers.
   * @param indices - Buffer indices whose object changed.
   * @returns How many points were recorded (those inside a loaded node).
   */
  recordInstances(
    source: string,
    cloud: RangedCloud,
    instances: Uint32Array,
    indices: ArrayLike<number>,
  ): number {
    const ranges = cloud.nodeRanges;
    if (!ranges) return 0;
    const nodes: NodeEdits = this.instanceSources.get(source) ?? new Map();
    let recorded = 0;
    for (let i = 0; i < indices.length; i++) {
      const index = indices[i];
      const range = rangeForIndex(ranges, index);
      if (!range || index >= instances.length) continue;
      let edits = nodes.get(range.key);
      if (!edits) {
        edits = new Map();
        nodes.set(range.key, edits);
      }
      const id = instances[index];
      if (id === 0) edits.delete(index - range.start);
      else edits.set(index - range.start, id);
      if (edits.size === 0) nodes.delete(range.key);
      recorded++;
    }
    if (nodes.size > 0) this.instanceSources.set(source, nodes);
    else this.instanceSources.delete(source);
    return recorded;
  }

  /**
   * Writes a source's stored object ids into a per-point array.
   *
   * @param source - The cloud's source URL.
   * @param cloud - Its node ranges.
   * @param instances - Per-point object ids to fill (points without a stored
   *   id are left as they are).
   * @returns How many points were given a stored id.
   */
  applyInstances(source: string, cloud: RangedCloud, instances: Uint32Array): number {
    const nodes = this.instanceSources.get(source);
    const ranges = cloud.nodeRanges;
    if (!nodes || !ranges) return 0;
    let applied = 0;
    for (const range of ranges) {
      const edits = nodes.get(range.key);
      if (!edits) continue;
      for (const [offset, id] of edits) {
        const index = range.start + offset;
        if (offset >= range.count || index >= instances.length) continue;
        instances[index] = id;
        applied++;
      }
    }
    return applied;
  }

  /**
   * The largest object id stored for any source, so new objects get unique ids.
   *
   * @returns The id, or 0 when there are none.
   */
  maxInstanceId(): number {
    let max = 0;
    for (const nodes of this.instanceSources.values()) {
      for (const edits of nodes.values()) {
        for (const id of edits.values()) if (id > max) max = id;
      }
    }
    return max;
  }

  /** Drops every stored edit. */
  clear(): void {
    this.sources.clear();
    this.instanceSources.clear();
  }

  /**
   * Serialises the store for the project file.
   *
   * @returns The encoded store, or undefined when empty.
   */
  encode(): EncodedLabelStore | undefined {
    if (this.isEmpty) return undefined;
    const encoded: EncodedLabelStore = { version: 1, sources: encodeSources(this.sources, false) };
    if (this.instanceSources.size > 0) {
      encoded.instances = encodeSources(this.instanceSources, true);
    }
    return encoded;
  }

  /**
   * Replaces the store's contents with a serialised one.
   *
   * @param state - Project state from {@link encode}, or anything else to clear.
   */
  load(state: unknown): void {
    this.sources.clear();
    this.instanceSources.clear();
    if (!state || typeof state !== "object") return;
    const { version, sources, instances } = state as Partial<EncodedLabelStore>;
    if (version !== 1 || !Array.isArray(sources)) return;
    // Charged with the real inflated size of every record, failed ones too.
    const budget: InflateBudget = { remaining: MAX_LABEL_BYTES };
    this.sources = decodeSources(sources, budget, false);
    this.instanceSources = decodeSources(instances, budget, true);
  }
}
