/**
 * Earth Index embeddings (Earth Genome, SoftCon on Sentinel-2 2024 mosaics).
 *
 * One GeoParquet file per Sentinel-2 MGRS tile, each ~150–480 MB, with rows
 * `id` (uint64), `embedding` (float[384]) and a WKB point `geometry`, about
 * 320 m apart. Row groups hold ~1024 rows sorted by latitude, so each one is a
 * thin band spanning the whole tile's width. Loading a view therefore reads the
 * geometry column once (~2 MB), finds the rows inside the view, and decodes the
 * embedding column only for the row groups those rows fall in.
 */

import type { Feature, Point } from "geojson";
import { asyncBufferFromUrl, cachedAsyncBuffer, parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import type { LonLatBbox } from "./satellite-embeddings-grids";

export const EARTH_INDEX_BASE_URL = "https://data.source.coop/earthgenome/earthindexembeddings";
/** The only year Earth Index publishes so far. */
export const EARTH_INDEX_YEAR = 2024;
/** Most rows whose embeddings one load decodes (~2.2 MB of Parquet per 1000). */
export const EARTH_INDEX_MAX_ROWS = 30_000;

/** URL of the Parquet file for one MGRS tile. */
export function earthIndexFileUrl(tileId: string, year = EARTH_INDEX_YEAR): string {
  return `${EARTH_INDEX_BASE_URL}/${year}/${tileId}_${year}-01-01_${year + 1}-01-01.parquet`;
}

/** Properties of a loaded Earth Index point. */
export interface EarthIndexPointProps {
  id: string;
  /** Top three principal components, stretched to 0–255. */
  pc1: number;
  pc2: number;
  pc3: number;
  /** `#rrggbb` built from the three components, for map styling. */
  color: string;
  [key: string]: unknown;
}

/** Thrown when a view needs more rows than {@link EARTH_INDEX_MAX_ROWS}. */
export class EarthIndexTooLargeError extends Error {
  constructor(readonly rows: number) {
    super(`The area covers ${rows} embedding rows; zoom in to load fewer`);
    this.name = "EarthIndexTooLargeError";
  }
}

/** Loaded points and the file they came from. */
export interface EarthIndexLoadResult {
  features: Feature<Point, EarthIndexPointProps>[];
}

/** Reads a list-of-float cell (hyparquet returns arrays or typed arrays). */
function toVector(value: unknown): ArrayLike<number> | null {
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return value as ArrayLike<number>;
  return null;
}

/**
 * Loads the Earth Index points inside a box from one tile file and colors each
 * by the top three principal components of the loaded embeddings.
 */
export async function loadEarthIndexPoints(
  url: string,
  bbox: LonLatBbox,
  options: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {},
): Promise<EarthIndexLoadResult> {
  const [west, south, east, north] = bbox;
  const file = cachedAsyncBuffer(
    await asyncBufferFromUrl({ url, requestInit: { signal: options.signal } }),
  );
  const locations = await parquetReadObjects({
    file,
    columns: ["id", "geometry"],
    compressors,
  });
  options.onProgress?.(0.2);
  const rows: number[] = [];
  const coordinates: [number, number][] = [];
  locations.forEach((row, index) => {
    const geometry = row.geometry as Point | null;
    const [lon, lat] = geometry?.coordinates ?? [];
    if (lon >= west && lon <= east && lat >= south && lat <= north) {
      rows.push(index);
      coordinates.push([lon, lat]);
    }
  });
  if (rows.length === 0) return { features: [] };
  const rowStart = rows[0];
  const rowEnd = rows[rows.length - 1] + 1;
  if (rowEnd - rowStart > EARTH_INDEX_MAX_ROWS)
    throw new EarthIndexTooLargeError(rowEnd - rowStart);

  const embeddings = await parquetReadObjects({
    file,
    columns: ["embedding"],
    rowStart,
    rowEnd,
    compressors,
  });
  options.onProgress?.(0.9);
  const vectors: ArrayLike<number>[] = [];
  const kept: number[] = [];
  rows.forEach((row, index) => {
    const vector = toVector(embeddings[row - rowStart]?.embedding);
    if (vector && vector.length > 0) {
      vectors.push(vector);
      kept.push(index);
    }
  });
  const colors = pcaColors(vectors);
  const features = kept.map((index, position) => {
    const [pc1, pc2, pc3] = colors[position];
    return {
      type: "Feature" as const,
      properties: {
        id: String(locations[rows[index]].id),
        pc1,
        pc2,
        pc3,
        color: rgbHex(pc1, pc2, pc3),
      },
      geometry: { type: "Point" as const, coordinates: coordinates[index] },
    };
  });
  return { features };
}

/** Formats three 0–255 channels as `#rrggbb`. */
export function rgbHex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Projects vectors onto their top three principal components and stretches
 * each component (2nd–98th percentile) to 0–255, so similar embeddings get
 * similar colors. The covariance is estimated from at most `sampleSize`
 * vectors and diagonalized by power iteration with deflation.
 */
export function pcaColors(
  vectors: ArrayLike<number>[],
  sampleSize = 2000,
): [number, number, number][] {
  const count = vectors.length;
  if (count === 0) return [];
  const dims = vectors[0].length;
  const mean = new Float64Array(dims);
  for (const vector of vectors) {
    for (let d = 0; d < dims; d += 1) mean[d] += vector[d];
  }
  for (let d = 0; d < dims; d += 1) mean[d] /= count;

  // Covariance from an evenly spaced sample of the vectors.
  const stride = Math.max(1, Math.floor(count / sampleSize));
  const covariance = new Float64Array(dims * dims);
  const centered = new Float64Array(dims);
  let samples = 0;
  for (let index = 0; index < count; index += stride) {
    const vector = vectors[index];
    for (let d = 0; d < dims; d += 1) centered[d] = vector[d] - mean[d];
    for (let i = 0; i < dims; i += 1) {
      const ci = centered[i];
      if (ci === 0) continue;
      const rowOffset = i * dims;
      for (let j = i; j < dims; j += 1) covariance[rowOffset + j] += ci * centered[j];
    }
    samples += 1;
  }
  for (let i = 0; i < dims; i += 1) {
    for (let j = i; j < dims; j += 1) {
      const value = covariance[i * dims + j] / Math.max(1, samples - 1);
      covariance[i * dims + j] = value;
      covariance[j * dims + i] = value;
    }
  }

  const components: Float64Array[] = [];
  for (let component = 0; component < Math.min(3, dims); component += 1) {
    // Deterministic start vector so colors do not change between loads.
    let vector: Float64Array = new Float64Array(dims).map(
      (_, d) => 1 + ((d * 7 + component * 13) % 5),
    );
    let eigenvalue = 0;
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const next = new Float64Array(dims);
      for (let i = 0; i < dims; i += 1) {
        let sum = 0;
        const rowOffset = i * dims;
        for (let j = 0; j < dims; j += 1) sum += covariance[rowOffset + j] * vector[j];
        next[i] = sum;
      }
      const norm = Math.hypot(...next);
      if (norm === 0) break;
      for (let i = 0; i < dims; i += 1) next[i] /= norm;
      const delta = next.reduce((acc, value, i) => acc + Math.abs(value - vector[i]), 0);
      vector = next;
      eigenvalue = norm;
      if (delta < 1e-9) break;
    }
    components.push(vector);
    // Deflate so the next iteration finds the next component.
    for (let i = 0; i < dims; i += 1) {
      for (let j = 0; j < dims; j += 1)
        covariance[i * dims + j] -= eigenvalue * vector[i] * vector[j];
    }
  }

  const scores = components.map(() => new Float64Array(count));
  vectors.forEach((vector, index) => {
    components.forEach((component, c) => {
      let sum = 0;
      for (let d = 0; d < dims; d += 1) sum += (vector[d] - mean[d]) * component[d];
      scores[c][index] = sum;
    });
  });
  const stretched = scores.map((score) => {
    const sorted = Float64Array.from(score).sort();
    const low = sorted[Math.floor((count - 1) * 0.02)];
    const high = sorted[Math.ceil((count - 1) * 0.98)];
    const span = high - low || 1;
    return Array.from(score, (value) =>
      Math.round(Math.min(255, Math.max(0, ((value - low) / span) * 255))),
    );
  });
  return Array.from({ length: count }, (_, index) => [
    stretched[0]?.[index] ?? 128,
    stretched[1]?.[index] ?? 128,
    stretched[2]?.[index] ?? 128,
  ]);
}

/**
 * Checks that a file exists, returning its size in bytes, or null on a 404.
 * Other failures throw so a network error is not mistaken for "no data".
 */
export async function probeFileSize(url: string, signal?: AbortSignal): Promise<number | null> {
  const response = await fetch(url, { method: "HEAD", signal });
  if (response.status === 404 || response.status === 403) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const length = Number(response.headers.get("content-length"));
  return Number.isFinite(length) ? length : 0;
}
