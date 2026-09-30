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
 * The lon/lat corners of a zone-grid box in MapLibre image-source order:
 * top-left, top-right, bottom-right, bottom-left.
 */
export function tesseraUtmBoundsToCorners(
  [minX, minY, maxX, maxY]: [number, number, number, number],
  zone: number,
): [[number, number], [number, number], [number, number], [number, number]] {
  const toLonLat = proj4(utmProjection(zone, false), "EPSG:4326");
  const corner = (x: number, y: number): [number, number] => {
    const [lon, lat] = toLonLat.forward([x, y]);
    return [lon, lat];
  };
  return [corner(minX, maxY), corner(maxX, maxY), corner(maxX, minY), corner(minX, minY)];
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

/**
 * Renders three de-quantized bands as RGBA, stretching each band between its
 * own 2nd and 98th percentiles. Pixels with no value (NaN) are transparent.
 */
export function renderTesseraRgba(
  bands: [Float32Array, Float32Array, Float32Array],
  width: number,
  height: number,
): Uint8ClampedArray {
  const ranges = bands.map(percentileRange);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    if (!Number.isFinite(bands[0][pixel])) continue; // unembedded in every band at once
    const target = pixel * 4;
    for (let channel = 0; channel < 3; channel += 1) {
      const range = ranges[channel];
      if (!range) continue;
      rgba[target + channel] = ((bands[channel][pixel] - range[0]) / (range[1] - range[0])) * 255;
    }
    rgba[target + 3] = 255;
  }
  return rgba;
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

interface OpenedZone {
  info: TesseraZoneInfo;
  embeddings: ZarrArray;
  scales: ZarrArray;
}

/** Opened zones, kept for the page's life (a zone's shard indexes are cached in its arrays). */
const openZones = new Map<number, Promise<OpenedZone>>();

async function openZone(zone: number): Promise<OpenedZone> {
  let opened = openZones.get(zone);
  if (!opened) {
    opened = (async () => {
      const zarr = await import("zarrita");
      const root = zarr.root(new zarr.FetchStore(TESSERA_ZARR_URL));
      const group = await zarr.open.v3(root.resolve(tesseraZoneGroup(zone)), { kind: "group" });
      const [embeddings, scales] = await Promise.all([
        zarr.open.v3(group.resolve("embeddings"), { kind: "array" }),
        zarr.open.v3(group.resolve("scales"), { kind: "array" }),
      ]);
      return {
        info: tesseraZoneInfo(zone, group.attrs as Record<string, unknown>),
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
  concurrency = 24,
): Promise<TesseraWindowBands | null> {
  const zone = tesseraZone((bbox[0] + bbox[2]) / 2);
  const { info, embeddings, scales } = await openZone(zone);
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
  const readChunk = async ([cy, cx]: [number, number]): Promise<void> => {
    const scaleChunk = await scales.getChunk([timeIndex, cy, cx], options);
    const scaleData = scaleChunk.data as Float32Array;
    // A chunk with no embedded pixel is left NaN without fetching its 128 bands.
    if (!scaleData.some((value) => Number.isFinite(value))) return;
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
        const scale = scaleData[localY * scaleRowStride + localX * scaleColStride];
        if (!Number.isFinite(scale)) continue;
        const target = (y - row0) * width + (x - col0);
        const offset = localY * rowStride + localX * colStride;
        for (let channel = 0; channel < 3; channel += 1) {
          bands[channel][target] = data[offset + bandIndices[channel] * bandStride] * scale;
        }
      }
    }
  };
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < chunks.length) {
      const chunk = chunks[next];
      next += 1;
      signal?.throwIfAborted();
      await readChunk(chunk);
      done += 1;
      onProgress?.(done, chunks.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker));
  return { plan, bands };
}
