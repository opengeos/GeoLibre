/**
 * Reading Tessera v1.1 embeddings for on-map visualization.
 *
 * The AWS Open Data release (`s3://tessera-embeddings/v1.1/dclimate.icechunk`)
 * is an Icechunk repository whose `scales` array is PCodec-encoded, which no
 * browser Zarr reader decodes. The publishers mirror the same snapshot as a
 * plain Zarr v3 store on Source Coop (Blosc/Zstd throughout, open CORS), so the
 * panel reads that one with zarrita.
 *
 * Layout: one group per UTM zone (`utm01`…`utm60`), each spanning both
 * hemispheres in its EPSG:326xx grid (negative northings in the south).
 * `embeddings` is int8 `(time, band, y, x)` and `scales` float32
 * `(time, y, x)`; `embeddings × scales` recovers the values, and a NaN scale
 * marks an unembedded pixel. Inner chunks are 32 × 32 pixels with all 128
 * bands, about 100 KB each, so the cost of a read grows with its area, not
 * with how many bands it keeps.
 */

import { type LonLatBbox, utmProjection } from "./satellite-embeddings-grids";
import proj4 from "proj4";

/** Root of the Source Coop Zarr v3 mirror of the Tessera v1.1 store. */
export const TESSERA_ZARR_URL = "https://data.source.coop/tessera/tessera/zarr/v1.1-dclimate";
/** Year of the store's first time step. */
export const TESSERA_FIRST_YEAR = 2017;
export const TESSERA_BAND_COUNT = 128;
/** Bands shown by default; the store's own preview stretch uses these. */
export const TESSERA_DEFAULT_RGB_BANDS: [number, number, number] = [0, 1, 2];
/** Side of an inner chunk, in pixels. */
export const TESSERA_CHUNK_SIZE = 32;
/** Approximate compressed size of one inner chunk (all 128 bands). */
export const TESSERA_CHUNK_BYTES = 104 * 1024;
/**
 * Most inner chunks one visualization reads (~130 MB). Enough for a whole
 * 0.1° grid tile anywhere: at most 1,113 pixels, so 36 chunks, per side.
 */
export const TESSERA_MAX_READ_CHUNKS = 1300;
/** Lower and upper percentiles of the per-band display stretch. */
const STRETCH_PERCENTILES: [number, number] = [0.02, 0.98];
/** Most values sampled per band when computing the stretch. */
const STRETCH_SAMPLES = 100_000;

/** The nominal 6° UTM zone (1–60) of a longitude; the store ignores UTM's exceptions. */
export function tesseraZone(lon: number): number {
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  return Math.min(60, Math.max(1, Math.floor((wrapped + 180) / 6) + 1));
}

/** Name of the zone group, e.g. `utm07`. */
export function tesseraZoneGroup(zone: number): string {
  return `utm${String(zone).padStart(2, "0")}`;
}

/** A pixel window chosen by {@link planTesseraWindow}. */
export interface TesseraWindowPlan {
  /** `[col0, row0, col1, row1)` in the zone's pixels. */
  window: [number, number, number, number];
  width: number;
  height: number;
  /** UTM bounds the window covers: `[minX, minY, maxX, maxY]`. */
  bounds: [number, number, number, number];
  /** Inner chunks the window touches. */
  chunkCount: number;
}

/**
 * Chooses the pixel window of a zone covering a UTM box. `transform` is the
 * group's `spatial:transform` (`[a, b, c, d, e, f]`: `x = a·col + c`,
 * `y = e·row + f`) and `shape` its `spatial:shape` (`[rows, cols]`). Returns
 * null when the box misses the zone.
 */
export function planTesseraWindow(
  transform: number[],
  [rows, cols]: number[],
  [minX, minY, maxX, maxY]: [number, number, number, number],
): TesseraWindowPlan | null {
  const [a, b, c, d, e, f] = transform;
  if (b !== 0 || d !== 0) throw new Error("Rotated grids are not supported");
  const colA = (minX - c) / a;
  const colB = (maxX - c) / a;
  const rowA = (minY - f) / e;
  const rowB = (maxY - f) / e;
  const col0 = Math.max(0, Math.floor(Math.min(colA, colB)));
  const col1 = Math.min(cols, Math.ceil(Math.max(colA, colB)));
  const row0 = Math.max(0, Math.floor(Math.min(rowA, rowB)));
  const row1 = Math.min(rows, Math.ceil(Math.max(rowA, rowB)));
  if (col1 <= col0 || row1 <= row0) return null;
  const xs = [c + col0 * a, c + col1 * a];
  const ys = [f + row0 * e, f + row1 * e];
  const chunkSpan = (start: number, end: number): number =>
    Math.floor((end - 1) / TESSERA_CHUNK_SIZE) - Math.floor(start / TESSERA_CHUNK_SIZE) + 1;
  return {
    window: [col0, row0, col1, row1],
    width: col1 - col0,
    height: row1 - row0,
    bounds: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
    chunkCount: chunkSpan(col0, col1) * chunkSpan(row0, row1),
  };
}

/**
 * Projects a lon/lat box into a zone's grid (always the northern EPSG:326xx
 * form, as the store uses it south of the equator too), sampling its edges so
 * the result contains the whole box.
 */
export function lonLatBboxToTesseraUtm(
  [west, south, east, north]: LonLatBbox,
  zone: number,
): [number, number, number, number] {
  const toUtm = proj4("EPSG:4326", utmProjection(zone, false));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const steps = 8;
  for (let i = 0; i <= steps; i += 1) {
    for (let j = 0; j <= steps; j += 1) {
      if (i !== 0 && i !== steps && j !== 0 && j !== steps) continue; // edges only
      const [x, y] = toUtm.forward([
        west + ((east - west) * i) / steps,
        south + ((north - south) * j) / steps,
      ]);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return [minX, minY, maxX, maxY];
}

/**
 * The `[low, high]` display range of a band: the 2nd and 98th percentiles of
 * its finite values, from an even sample. Null when the band has none.
 */
export function percentileRange(values: Float32Array): [number, number] | null {
  const step = Math.max(1, Math.floor(values.length / STRETCH_SAMPLES));
  const sample: number[] = [];
  for (let index = 0; index < values.length; index += step) {
    const value = values[index];
    if (Number.isFinite(value)) sample.push(value);
  }
  if (sample.length === 0) return null;
  sample.sort((x, y) => x - y);
  const at = (fraction: number): number =>
    sample[Math.min(sample.length - 1, Math.floor(fraction * (sample.length - 1)))];
  const low = at(STRETCH_PERCENTILES[0]);
  const high = at(STRETCH_PERCENTILES[1]);
  return high > low ? [low, high] : [low - 1, low + 1];
}

/** Georeferencing and coverage of one zone group. */
export interface TesseraZoneInfo {
  zone: number;
  transform: number[];
  shape: number[];
  /** Years complete in each hemisphere (`N`/`S`), from the group's provenance. */
  yearsComplete: { N?: number[]; S?: number[] };
}

/** Reads a zone group's georeferencing from its attributes. */
export function tesseraZoneInfo(zone: number, attrs: Record<string, unknown>): TesseraZoneInfo {
  const transform = attrs["spatial:transform"];
  const shape = attrs["spatial:shape"];
  if (!Array.isArray(transform) || transform.length < 6 || !Array.isArray(shape)) {
    throw new Error(`Tessera zone ${zone} has no spatial:transform`);
  }
  const groups = (attrs["geotessera:source_groups"] ?? {}) as Record<
    string,
    { years_complete?: unknown }
  >;
  const years = (key: string): number[] | undefined => {
    const value = groups[`${String(zone).padStart(2, "0")}${key}`]?.years_complete;
    return Array.isArray(value) ? value.map(Number) : undefined;
  };
  return {
    zone,
    transform: transform.map(Number),
    shape: shape.map(Number),
    yearsComplete: { N: years("N"), S: years("S") },
  };
}

/** Three bands of a window, de-quantized, with NaN where nothing was embedded. */
export interface TesseraWindowBands {
  plan: TesseraWindowPlan;
  bands: [Float32Array, Float32Array, Float32Array];
}

type ZarrArray = import("zarrita").Array<import("zarrita").DataType>;
type ZarrKey = `/${string}`;
type ZarrRange = { offset: number; length: number } | { suffixLength: number };

/** Side of a shard, in pixels: one object holds 128 × 128 inner chunks. */
export const TESSERA_SHARD_SIZE = 4096;
const CHUNKS_PER_SHARD_SIDE = TESSERA_SHARD_SIZE / TESSERA_CHUNK_SIZE;
/** Bytes of a shard index: an (offset, length) uint64 pair per inner chunk, then a CRC32C. */
const SHARD_INDEX_BYTES = CHUNKS_PER_SHARD_SIDE * CHUNKS_PER_SHARD_SIDE * 16 + 4;
/**
 * Largest run of unwanted bytes a merged request may carry. A request costs
 * ~0.7 s of latency on Source Cooperative against ~20 MB/s of transfer, so
 * fetching a few unneeded chunks is cheaper than a second request.
 */
const MAX_RANGE_GAP = 512 * 1024;
/** Largest merged request, so a big read still streams in parallel and reports progress. */
const MAX_RANGE_BYTES = 8 * 1024 * 1024;
/** Merged requests in flight at once. */
const RANGE_CONCURRENCY = 6;

/** One byte range of a shard and what it holds. */
export interface ShardRange<T> {
  offset: number;
  length: number;
  item: T;
}

/** Contiguous-enough ranges merged into one request. */
export interface MergedRange<T> {
  offset: number;
  length: number;
  items: ShardRange<T>[];
}

/**
 * Merges byte ranges into as few requests as possible: ranges are sorted by
 * offset and joined while the gap between them is at most `maxGap` and the
 * merged request stays within `maxBytes`. The store writes a shard's inner
 * chunks in Z-order, so the chunks of a window fall into a few long runs.
 */
export function mergeRanges<T>(
  ranges: ShardRange<T>[],
  maxGap = MAX_RANGE_GAP,
  maxBytes = MAX_RANGE_BYTES,
): MergedRange<T>[] {
  const sorted = [...ranges].sort((a, b) => a.offset - b.offset);
  const merged: MergedRange<T>[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    const end = range.offset + range.length;
    if (
      last &&
      range.offset - (last.offset + last.length) <= maxGap &&
      end - last.offset <= maxBytes
    ) {
      last.length = Math.max(last.length, end - last.offset);
      last.items.push(range);
    } else {
      merged.push({ offset: range.offset, length: range.length, items: [range] });
    }
  }
  return merged;
}

/**
 * Parses a shard index into `(offset, length)` per inner chunk, row-major over
 * the shard's chunk grid, with null for a chunk the shard does not hold.
 */
export function parseShardIndex(bytes: Uint8Array): ({ offset: number; length: number } | null)[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = Math.floor((bytes.byteLength - 4) / 16);
  const missing = 0xffff_ffff_ffff_ffffn;
  const entries: ({ offset: number; length: number } | null)[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = view.getBigUint64(index * 16, true);
    const length = view.getBigUint64(index * 16 + 8, true);
    entries.push(
      offset === missing && length === missing
        ? null
        : { offset: Number(offset), length: Number(length) },
    );
  }
  return entries;
}

/**
 * A store that answers zarrita's shard reads from bytes fetched in bulk.
 * zarrita requests every inner chunk separately (two round trips per chunk
 * once `scales` is counted); the reader instead fetches merged ranges, parks
 * them here, and lets zarrita decode from memory. Anything not parked falls
 * through to the network.
 */
class BulkRangeStore {
  /** Fetched ranges by key, removed once their chunks are decoded. */
  readonly ranges = new Map<string, { offset: number; bytes: Uint8Array }[]>();
  /** Shard indexes by key, as zarrita asks for them (a suffix read). */
  readonly suffixes = new Map<string, Uint8Array>();

  constructor(readonly inner: import("zarrita").FetchStore) {}

  get(key: ZarrKey, options?: RequestInit): Promise<Uint8Array | undefined> {
    return this.inner.get(key, options);
  }

  async getRange(
    key: ZarrKey,
    range: ZarrRange,
    options?: RequestInit,
  ): Promise<Uint8Array | undefined> {
    if ("suffixLength" in range) {
      const cached = this.suffixes.get(key);
      if (cached && cached.byteLength === range.suffixLength) return cached;
    } else {
      for (const parked of this.ranges.get(key) ?? []) {
        const start = range.offset - parked.offset;
        if (start >= 0 && start + range.length <= parked.bytes.byteLength) {
          return parked.bytes.subarray(start, start + range.length);
        }
      }
    }
    return this.inner.getRange(key, range, options);
  }

  /** Fetches (once) and parses a shard's index, or null when the shard does not exist. */
  shardIndex(key: ZarrKey, signal?: AbortSignal) {
    let index = this.indexes.get(key);
    if (!index) {
      index = this.inner
        .getRange(key, { suffixLength: SHARD_INDEX_BYTES }, signal ? { signal } : undefined)
        .then((bytes) => {
          if (!bytes) return null;
          this.suffixes.set(key, bytes);
          return parseShardIndex(bytes);
        })
        .catch((error: unknown) => {
          this.indexes.delete(key);
          throw error;
        });
      this.indexes.set(key, index);
    }
    return index;
  }

  private readonly indexes = new Map<
    string,
    Promise<({ offset: number; length: number } | null)[] | null>
  >();
}

interface OpenedZone {
  info: TesseraZoneInfo;
  group: string;
  store: BulkRangeStore;
  embeddings: ZarrArray;
  scales: ZarrArray;
}

/** Opened zones, kept for the page's life (their shard indexes stay cached). */
const openZones = new Map<number, Promise<OpenedZone>>();

async function openZone(zone: number): Promise<OpenedZone> {
  let opened = openZones.get(zone);
  if (!opened) {
    opened = (async () => {
      const zarr = await import("zarrita");
      const store = new BulkRangeStore(new zarr.FetchStore(TESSERA_ZARR_URL));
      const groupName = tesseraZoneGroup(zone);
      const group = await zarr.open.v3(zarr.root(store).resolve(groupName), { kind: "group" });
      const [embeddings, scales] = await Promise.all([
        zarr.open.v3(group.resolve("embeddings"), { kind: "array" }),
        zarr.open.v3(group.resolve("scales"), { kind: "array" }),
      ]);
      return {
        info: tesseraZoneInfo(zone, group.attrs as Record<string, unknown>),
        group: groupName,
        store,
        embeddings,
        scales,
      };
    })().catch((error: unknown) => {
      openZones.delete(zone);
      throw error;
    });
    openZones.set(zone, opened);
  }
  return opened;
}

/**
 * Visits inner chunks of one array, fetching them shard by shard in merged
 * ranges and handing each to `visit` while its bytes are parked in the store.
 * Chunks a shard does not hold are visited too (zarrita fills them without a
 * request).
 */
async function visitChunks(
  store: BulkRangeStore,
  shardKey: (shardY: number, shardX: number) => ZarrKey,
  chunks: [number, number][],
  visit: (chunk: [number, number]) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const byShard = new Map<ZarrKey, [number, number][]>();
  for (const chunk of chunks) {
    const key = shardKey(
      Math.floor(chunk[0] / CHUNKS_PER_SHARD_SIDE),
      Math.floor(chunk[1] / CHUNKS_PER_SHARD_SIDE),
    );
    const list = byShard.get(key);
    if (list) list.push(chunk);
    else byShard.set(key, [chunk]);
  }
  const requests: { key: ZarrKey; merged: MergedRange<[number, number]> }[] = [];
  const unfetched: [number, number][] = [];
  await Promise.all(
    [...byShard].map(async ([key, shardChunks]) => {
      const index = await store.shardIndex(key, signal);
      const ranges: ShardRange<[number, number]>[] = [];
      for (const chunk of shardChunks) {
        const entry =
          index?.[
            (chunk[0] % CHUNKS_PER_SHARD_SIDE) * CHUNKS_PER_SHARD_SIDE +
              (chunk[1] % CHUNKS_PER_SHARD_SIDE)
          ];
        if (entry) ranges.push({ ...entry, item: chunk });
        else unfetched.push(chunk);
      }
      for (const merged of mergeRanges(ranges)) requests.push({ key, merged });
    }),
  );
  for (const chunk of unfetched) await visit(chunk);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < requests.length) {
      const { key, merged } = requests[next];
      next += 1;
      signal?.throwIfAborted();
      const bytes = await store.inner.getRange(
        key,
        { offset: merged.offset, length: merged.length },
        signal ? { signal } : undefined,
      );
      if (!bytes) throw new Error(`Missing shard ${key}`);
      const parked = { offset: merged.offset, bytes };
      const list = store.ranges.get(key) ?? [];
      list.push(parked);
      store.ranges.set(key, list);
      try {
        for (const range of merged.items) await visit(range.item);
      } finally {
        const remaining = (store.ranges.get(key) ?? []).filter((entry) => entry !== parked);
        if (remaining.length > 0) store.ranges.set(key, remaining);
        else store.ranges.delete(key);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(RANGE_CONCURRENCY, requests.length) }, worker));
}

/** Thrown when a window would read more than {@link TESSERA_MAX_READ_CHUNKS} chunks. */
export class TesseraTooLargeError extends Error {
  constructor(readonly chunkCount: number) {
    super(`The area needs ${chunkCount} chunks; the limit is ${TESSERA_MAX_READ_CHUNKS}.`);
  }
}

/** Thrown when the store has not completed a year in the area's hemisphere. */
export class TesseraYearMissingError extends Error {
  constructor(readonly year: number) {
    super(`Tessera ${year} is not complete here.`);
  }
}

/**
 * Reads three bands of a lon/lat box for one year, de-quantized. The box
 * should lie in one UTM zone (a 0.1° grid tile always does); it is read from
 * the zone of its centre.
 *
 * @param onProgress Called with the chunks read so far and the total.
 * @returns The window and its bands, or null when the box misses the store.
 */
export async function readTesseraBands(
  bbox: LonLatBbox,
  year: number,
  bandIndices: [number, number, number],
  signal?: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<TesseraWindowBands | null> {
  const zone = tesseraZone((bbox[0] + bbox[2]) / 2);
  const { info, group, store, embeddings, scales } = await openZone(zone);
  signal?.throwIfAborted();
  const hemisphere = (bbox[1] + bbox[3]) / 2 >= 0 ? "N" : "S";
  const complete = info.yearsComplete[hemisphere];
  if (complete && !complete.includes(year)) throw new TesseraYearMissingError(year);
  const timeIndex = year - TESSERA_FIRST_YEAR;
  if (timeIndex < 0 || timeIndex >= embeddings.shape[0]) throw new TesseraYearMissingError(year);
  const plan = planTesseraWindow(info.transform, info.shape, lonLatBboxToTesseraUtm(bbox, zone));
  if (!plan) return null;
  if (plan.chunkCount > TESSERA_MAX_READ_CHUNKS) throw new TesseraTooLargeError(plan.chunkCount);

  const { width, height } = plan;
  const [col0, row0, col1, row1] = plan.window;
  const size = TESSERA_CHUNK_SIZE;
  const bands: [Float32Array, Float32Array, Float32Array] = [
    new Float32Array(width * height).fill(Number.NaN),
    new Float32Array(width * height).fill(Number.NaN),
    new Float32Array(width * height).fill(Number.NaN),
  ];
  const chunks: [number, number][] = [];
  for (let cy = Math.floor(row0 / size); cy * size < row1; cy += 1) {
    for (let cx = Math.floor(col0 / size); cx * size < col1; cx += 1) chunks.push([cy, cx]);
  }
  const options = signal ? { signal } : undefined;
  let done = 0;
  onProgress?.(done, chunks.length);

  // Scales first (~3 KB a chunk): a chunk with no embedded pixel is left NaN
  // without fetching its 128 bands.
  const scaleChunks = new Map<string, { data: Float32Array; stride: number[] }>();
  await visitChunks(
    store,
    (shardY, shardX) => `/${group}/scales/c/${timeIndex}/${shardY}/${shardX}`,
    chunks,
    async ([cy, cx]) => {
      const chunk = await scales.getChunk([timeIndex, cy, cx], options);
      const data = chunk.data as Float32Array;
      if (data.some((value) => Number.isFinite(value))) {
        scaleChunks.set(`${cy},${cx}`, { data, stride: chunk.stride });
      } else {
        done += 1;
      }
    },
    signal,
  );
  onProgress?.(done, chunks.length);

  const embedded = chunks.filter(([cy, cx]) => scaleChunks.has(`${cy},${cx}`));
  await visitChunks(
    store,
    (shardY, shardX) => `/${group}/embeddings/c/${timeIndex}/0/${shardY}/${shardX}`,
    embedded,
    async ([cy, cx]) => {
      const scaleChunk = scaleChunks.get(`${cy},${cx}`)!;
      const embeddingChunk = await embeddings.getChunk([timeIndex, 0, cy, cx], options);
      const data = embeddingChunk.data as Int8Array;
      const [, bandStride, rowStride, colStride] = embeddingChunk.stride;
      const [, scaleRowStride, scaleColStride] = scaleChunk.stride;
      const y0 = Math.max(row0, cy * size);
      const y1 = Math.min(row1, (cy + 1) * size);
      const x0 = Math.max(col0, cx * size);
      const x1 = Math.min(col1, (cx + 1) * size);
      for (let y = y0; y < y1; y += 1) {
        const localY = y - cy * size;
        for (let x = x0; x < x1; x += 1) {
          const localX = x - cx * size;
          const scale = scaleChunk.data[localY * scaleRowStride + localX * scaleColStride];
          if (!Number.isFinite(scale)) continue;
          const target = (y - row0) * width + (x - col0);
          const offset = localY * rowStride + localX * colStride;
          for (let channel = 0; channel < 3; channel += 1) {
            bands[channel][target] = data[offset + bandIndices[channel] * bandStride] * scale;
          }
        }
      }
      done += 1;
      onProgress?.(done, chunks.length);
    },
    signal,
  );
  return { plan, bands };
}
