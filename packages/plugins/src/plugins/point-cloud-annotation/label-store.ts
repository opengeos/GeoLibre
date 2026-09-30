// Persistent point labels. Buffer indices change whenever streaming reloads or
// compacts a cloud, so an edit is stored against the point's stable identity:
// the source node key (COPC/EPT octree key, or "file") and the point's index
// within that node, from maplibre-gl-lidar's `nodeRanges`.

import { deflateSync, inflateSync } from "fflate";

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

/** Serialised labels for one source: node key -> base64(deflate(edits)). */
export type EncodedSourceLabels = Record<string, string>;

/**
 * Project state: each source's encoded labels. The URL is a value, not an
 * object key, so project credential redaction scrubs a signed URL.
 */
export interface EncodedLabelStore {
  version: 1;
  sources: { url: string; nodes: EncodedSourceLabels }[];
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

/**
 * Encodes a node's edits as (delta-varint index, class byte) pairs, ascending
 * by index, then deflates them.
 *
 * @param edits - Index within the node -> class code.
 * @returns base64 text.
 */
export function encodeNodeEdits(edits: ReadonlyMap<number, number>): string {
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
    out.push(edits.get(index)! & 0xff);
  }
  return toBase64(deflateSync(Uint8Array.from(out), { level: 9 }));
}

/**
 * Decodes {@link encodeNodeEdits} output.
 *
 * @param text - base64 text.
 * @returns Index within the node -> class code.
 */
export function decodeNodeEdits(text: string): Map<number, number> {
  const bytes = inflateSync(fromBase64(text));
  const edits = new Map<number, number>();
  let previous = -1;
  let at = 0;
  while (at < bytes.length) {
    let delta = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = bytes[at++];
      delta += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80 && at < bytes.length);
    const index = previous + 1 + delta;
    previous = index;
    if (at >= bytes.length) break;
    edits.set(index, bytes[at++]);
  }
  return edits;
}

/** Point class edits for every labelled source, keyed by stable point identity. */
export class PointLabelStore {
  private readonly sources = new Map<string, Map<string, Map<number, number>>>();

  /** Whether any source has edits. */
  get isEmpty(): boolean {
    return this.sources.size === 0;
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

  /** Drops every stored edit. */
  clear(): void {
    this.sources.clear();
  }

  /**
   * Serialises the store for the project file.
   *
   * @returns The encoded store, or undefined when empty.
   */
  encode(): EncodedLabelStore | undefined {
    if (this.isEmpty) return undefined;
    const sources: EncodedLabelStore["sources"] = [];
    for (const [url, nodes] of this.sources) {
      const encoded: EncodedSourceLabels = {};
      for (const [key, edits] of nodes) {
        if (edits.size > 0) encoded[key] = encodeNodeEdits(edits);
      }
      sources.push({ url, nodes: encoded });
    }
    return { version: 1, sources };
  }

  /**
   * Replaces the store's contents with a serialised one.
   *
   * @param state - Project state from {@link encode}, or anything else to clear.
   */
  load(state: unknown): void {
    this.sources.clear();
    if (!state || typeof state !== "object") return;
    const { version, sources } = state as Partial<EncodedLabelStore>;
    if (version !== 1 || !Array.isArray(sources)) return;
    for (const entry of sources) {
      const source = entry?.url;
      const encoded = entry?.nodes;
      if (typeof source !== "string" || !encoded || typeof encoded !== "object") continue;
      const nodes = new Map<string, Map<number, number>>();
      for (const [key, text] of Object.entries(encoded)) {
        if (typeof text !== "string") continue;
        try {
          nodes.set(key, decodeNodeEdits(text));
        } catch {
          // Skip a corrupt node rather than the whole project.
        }
      }
      if (nodes.size > 0) this.sources.set(source, nodes);
    }
  }
}
