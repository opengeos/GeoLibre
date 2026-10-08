/**
 * Fields of the World (FTW) global field boundaries, 2nd Edition.
 *
 * FTW (https://fieldsofthe.world) publishes agricultural field boundaries
 * predicted worldwide from Sentinel-2 quarterly mosaics for 2017–2025, on
 * Source Cooperative (https://source.coop/ftw/global-data-2e):
 *
 * - one vector PMTiles archive per year holding two source layers: `cells`
 *   (A5 resolution-7 summaries, zoom 0–8: field count, % covered, mean score,
 *   area) and `fields` (the polygons, zoom 9–13, with a 0–100 `score`);
 * - one GeoParquet file per year and UTM zone (WGS 84, up to ~6.6 GB), in
 *   spatially sorted 8,192-row groups whose `bbox` column statistics let a
 *   reader fetch only the groups overlapping an area;
 * - `index/vector.parquet`, a 54 KB manifest of every year × zone file with its
 *   URL, size, parcel count and extent.
 *
 * Everything here is pure (no map, no DOM) so it can be tested directly.
 */

import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import {
  asyncBufferFromUrl,
  parquetMetadataAsync,
  parquetReadObjects,
  type AsyncBuffer,
  type FileMetaData,
} from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { bboxesIntersect, type LonLatBbox } from "./satellite-embeddings-grids";

export const FTW_BASE_URL = "https://data.source.coop/ftw/global-data-2e";

/** Years with published global predictions, oldest first. */
export const FTW_YEARS = [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025] as const;
export type FtwYear = (typeof FTW_YEARS)[number];
export const FTW_DEFAULT_YEAR: FtwYear = 2025;

/**
 * The default score threshold. The 2nd Edition publishes no calibrated cutoff
 * and its README advises preferring the continuous score over a hard threshold,
 * so every field is shown until the user raises it.
 */
export const FTW_DEFAULT_THRESHOLD = 0;

export const FTW_VECTOR_INDEX_URL = `${FTW_BASE_URL}/index/vector.parquet`;

export const FTW_WEBSITE_URL = "https://fieldsofthe.world";
export const FTW_APP_URL = "https://fieldsofthe.world/ftw-inference-app";
export const FTW_MAP_URL = "https://research.taylorgeospatial.org/global-ftw-2e/web/";
export const FTW_DATA_URL = "https://source.coop/ftw/global-data-2e";
export const FTW_PAPER_URL = "https://arxiv.org/abs/2603.27101";
export const FTW_LICENSE = "CC-BY-4.0";

/** A source layer of a year's PMTiles archive. */
export interface FtwArchiveLayer {
  url: string;
  /** The vector-tile layer to draw. */
  sourceLayer: string;
  /** Lowest zoom with tiles for this layer; the map is empty below it. */
  minZoom: number;
  /** Highest zoom with tiles for this layer (MapLibre overzooms past it). */
  maxZoom: number;
}

/** The year's global PMTiles archive (both source layers live in it). */
export function ftwArchiveUrl(year: number): string {
  return `${FTW_BASE_URL}/vector/${year}/fields-${year}.pmtiles`;
}

/** The field polygons of a year's archive, tiled from zoom 9. */
export function ftwFieldsLayer(year: number): FtwArchiveLayer {
  return { url: ftwArchiveUrl(year), sourceLayer: "fields", minZoom: 9, maxZoom: 13 };
}

/** The A5 cell summaries of a year's archive, for zoom 0–8. */
export function ftwCellsLayer(year: number): FtwArchiveLayer {
  return { url: ftwArchiveUrl(year), sourceLayer: "cells", minZoom: 0, maxZoom: 8 };
}

/** URL of the GeoParquet file for one year and UTM zone. */
export function ftwZoneParquetUrl(year: number, zone: number): string {
  const nn = String(zone).padStart(2, "0");
  return `${FTW_BASE_URL}/vector/${year}/zone=${nn}/utm${nn}.parquet`;
}

// ---------------------------------------------------------------------------
// Score styling
// ---------------------------------------------------------------------------

/**
 * Score color bins (red → orange → pale yellow → light green → green), the
 * dataset's own `field-prob` style: each color applies from `min` up to the
 * next bin.
 */
export const FTW_SCORE_BINS: ReadonlyArray<{ min: number; color: string }> = [
  { min: 0, color: "#d73027" },
  { min: 45, color: "#fdae61" },
  { min: 55, color: "#ffffbf" },
  { min: 65, color: "#a6d96a" },
  { min: 80, color: "#1a9850" },
];

/**
 * Field-coverage color bins (% of an A5 cell covered by fields), the dataset's
 * own `coverage` style.
 */
export const FTW_COVERAGE_BINS: ReadonlyArray<{ min: number; color: string }> = [
  { min: 0, color: "#ffffd9" },
  { min: 2, color: "#edf8b1" },
  { min: 10, color: "#7fcdbb" },
  { min: 25, color: "#41b6c4" },
  { min: 50, color: "#225ea8" },
  { min: 75, color: "#081d58" },
];

/**
 * `score` as a number (a missing value is 0). The archive and the GeoParquet
 * both store an integer, but a hand-edited or re-exported layer may not.
 */
const SCORE_VALUE = ["to-number", ["get", "score"], 0];

/**
 * A MapLibre `step` color expression over `value`. The colors are wrapped in
 * `to-color`: bare strings leave the output typed as a string, which the Style
 * panel's expression mode rejects for a color property.
 */
function stepColorExpression(
  value: unknown[],
  bins: ReadonlyArray<{ min: number; color: string }>,
): unknown[] {
  const [first, ...rest] = bins;
  return [
    "step",
    value,
    ["to-color", first.color],
    ...rest.flatMap((bin) => [bin.min, ["to-color", bin.color]]),
  ];
}

/** Colors fields by their 0–100 score. */
export function scoreColorExpression(): unknown[] {
  return stepColorExpression(SCORE_VALUE, FTW_SCORE_BINS);
}

/** Colors A5 cells by the percent of their area covered by fields. */
export function coverageColorExpression(): unknown[] {
  return stepColorExpression(["to-number", ["get", "pct_covered"], 0], FTW_COVERAGE_BINS);
}

/**
 * A MapLibre filter keeping fields scoring at or above a threshold (0–100), or
 * undefined for 0 (every field, so no filter is needed).
 */
export function scoreFilterExpression(threshold: number): unknown[] | undefined {
  const clamped = Math.round(Math.max(0, Math.min(100, threshold)));
  if (!(clamped > 0)) return undefined;
  return [">=", SCORE_VALUE, clamped];
}

/**
 * Reads the threshold back out of a filter this module built, so a restored
 * project's layer shows the slider where it was left. Null when the filter was
 * not built here (edited by hand).
 */
export function thresholdFromFilter(filter: unknown): number | null {
  if (filter === undefined || filter === null) return 0;
  if (!Array.isArray(filter) || filter.length !== 3 || filter[0] !== ">=") return null;
  if (JSON.stringify(filter[1]) !== JSON.stringify(SCORE_VALUE)) return null;
  const value = filter[2];
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

// ---------------------------------------------------------------------------
// Zone index
// ---------------------------------------------------------------------------

/** One year × UTM zone GeoParquet file, from `index/vector.parquet`. */
export interface FtwZoneFile {
  year: number;
  zone: number;
  url: string;
  sizeBytes: number;
  parcels: number;
  /** The extent of the zone's fields (not the zone's 6° strip). */
  bbox: LonLatBbox;
}

/**
 * A lon/lat box as one or two boxes that do not cross the antimeridian. A box
 * with west > east (a map view spanning 180°) is split at it.
 */
export function splitAntimeridian(bbox: LonLatBbox): LonLatBbox[] {
  const [west, south, east, north] = bbox;
  if (west <= east) return [bbox];
  return [
    [west, south, 180, north],
    [-180, south, east, north],
  ];
}

function finiteOrNull(value: unknown): number | null {
  const number = typeof value === "bigint" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
}

/**
 * Parses the rows of `index/vector.parquet`. The zone's URL is rebuilt from
 * the year and zone rather than taken from `href`, so the reader only ever
 * fetches from the dataset's own prefix. Rows missing a number are skipped.
 */
export function parseFtwZoneIndex(rows: ReadonlyArray<Record<string, unknown>>): FtwZoneFile[] {
  const zones: FtwZoneFile[] = [];
  for (const row of rows) {
    const year = finiteOrNull(row.year);
    const zone = finiteOrNull(row.zone);
    const box = [row.xmin, row.ymin, row.xmax, row.ymax].map(finiteOrNull);
    if (year === null || zone === null || box.some((value) => value === null)) continue;
    zones.push({
      year,
      zone,
      url: ftwZoneParquetUrl(year, zone),
      sizeBytes: finiteOrNull(row.size_bytes) ?? 0,
      parcels: finiteOrNull(row.n_parcels) ?? 0,
      bbox: box as LonLatBbox,
    });
  }
  return zones;
}

/** Reads and parses `index/vector.parquet`. */
export async function loadFtwZoneIndex(signal?: AbortSignal): Promise<FtwZoneFile[]> {
  const file = await asyncBufferFromUrl({ url: FTW_VECTOR_INDEX_URL, requestInit: { signal } });
  const rows = (await parquetReadObjects({
    file,
    columns: ["year", "zone", "size_bytes", "n_parcels", "xmin", "ymin", "xmax", "ymax"],
    compressors,
  })) as Record<string, unknown>[];
  return parseFtwZoneIndex(rows);
}

/** The year's zone files whose extent overlaps a box, west to east. */
export function searchFtwZones(
  zones: readonly FtwZoneFile[],
  bbox: LonLatBbox,
  year: number,
): FtwZoneFile[] {
  const parts = splitAntimeridian(bbox);
  return zones
    .filter((zone) => zone.year === year && parts.some((part) => bboxesIntersect(zone.bbox, part)))
    .sort((a, b) => a.zone - b.zone);
}

// ---------------------------------------------------------------------------
// Row-group planning
// ---------------------------------------------------------------------------

/** Columns read for each field. */
const FIELD_COLUMNS = ["id", "geometry", "bbox", "metrics:area", "metrics:perimeter", "score"];

/** The row groups of a zone file that may hold fields in an area. */
export interface FtwReadPlan {
  groups: Array<{ rowStart: number; rowEnd: number; bbox: LonLatBbox | null }>;
  /** Rows in those groups: an upper bound on the fields in the area. */
  rows: number;
  /** Compressed bytes of the columns read from those groups. */
  bytes: number;
  /** The union of the groups' extents, clipped to the area; null when none. */
  extent: LonLatBbox | null;
}

function statNumber(value: unknown): number | null {
  return finiteOrNull(value);
}

/**
 * The extent of one row group from its `bbox.*` column statistics, or null
 * when the writer left them out (the group then counts as overlapping).
 */
function rowGroupBbox(group: FileMetaData["row_groups"][number]): LonLatBbox | null {
  const stats = new Map<string, { min: number | null; max: number | null }>();
  for (const column of group.columns) {
    const meta = column.meta_data;
    if (!meta) continue;
    const path = meta.path_in_schema.join(".");
    if (!path.startsWith("bbox.")) continue;
    const s = meta.statistics;
    stats.set(path, {
      min: statNumber(s?.min_value ?? s?.min),
      max: statNumber(s?.max_value ?? s?.max),
    });
  }
  const west = stats.get("bbox.xmin")?.min;
  const south = stats.get("bbox.ymin")?.min;
  const east = stats.get("bbox.xmax")?.max;
  const north = stats.get("bbox.ymax")?.max;
  if (west == null || south == null || east == null || north == null) return null;
  return [west, south, east, north];
}

/** Whether two boxes overlap (touching counts), neither crossing 180°. */
function touches(a: LonLatBbox, b: LonLatBbox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/**
 * Picks the row groups of a zone file whose extent overlaps an area. The
 * files are spatially sorted, so a field-sized box selects a handful of the
 * hundreds of groups.
 */
export function planFtwRead(metadata: FileMetaData, area: LonLatBbox): FtwReadPlan {
  const parts = splitAntimeridian(area);
  const plan: FtwReadPlan = { groups: [], rows: 0, bytes: 0, extent: null };
  let extent: LonLatBbox | null = null;
  let rowStart = 0;
  for (const group of metadata.row_groups) {
    const rowEnd = rowStart + Number(group.num_rows);
    const box = rowGroupBbox(group);
    const overlapping = box ? parts.filter((part) => touches(box, part)) : parts;
    if (overlapping.length > 0) {
      plan.groups.push({ rowStart, rowEnd, bbox: box });
      plan.rows += rowEnd - rowStart;
      for (const column of group.columns) {
        const meta = column.meta_data;
        if (meta && FIELD_COLUMNS.includes(meta.path_in_schema[0])) {
          plan.bytes += Number(meta.total_compressed_size);
        }
      }
      for (const part of overlapping) {
        const clipped: LonLatBbox = box
          ? [
              Math.max(box[0], part[0]),
              Math.max(box[1], part[1]),
              Math.min(box[2], part[2]),
              Math.min(box[3], part[3]),
            ]
          : part;
        extent = extent
          ? [
              Math.min(extent[0], clipped[0]),
              Math.min(extent[1], clipped[1]),
              Math.max(extent[2], clipped[2]),
              Math.max(extent[3], clipped[3]),
            ]
          : clipped;
      }
    }
    rowStart = rowEnd;
  }
  plan.extent = extent;
  return plan;
}

/** An open zone file: its byte source and footer, reused across reads. */
export interface FtwZoneReader {
  file: AsyncBuffer;
  metadata: FileMetaData;
}

/**
 * Opens a zone file and reads its footer (up to ~2.7 MB for the largest
 * zones). Only the footer is fetched; row groups are read on demand.
 */
export async function openFtwZone(url: string, signal?: AbortSignal): Promise<FtwZoneReader> {
  const file = await asyncBufferFromUrl({ url, requestInit: { signal } });
  const metadata = await parquetMetadataAsync(file);
  return { file, metadata };
}

// ---------------------------------------------------------------------------
// GeoParquet rows
// ---------------------------------------------------------------------------

/** Properties of a field read from a zone's GeoParquet file. */
export interface FtwFieldProps {
  id: string | null;
  score: number | null;
  "metrics:area": number | null;
  "metrics:perimeter": number | null;
  [key: string]: unknown;
}

/** The lon/lat box of a geometry's coordinates, or null when it has none. */
export function geometryBbox(geometry: Geometry | null | undefined): LonLatBbox | null {
  if (!geometry) return null;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const visit = (coords: unknown): void => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === "number") {
      const [lon, lat] = coords as Position;
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
      return;
    }
    for (const child of coords) visit(child);
  };
  if (geometry.type === "GeometryCollection") {
    for (const child of geometry.geometries) {
      const box = geometryBbox(child);
      if (!box) continue;
      west = Math.min(west, box[0]);
      south = Math.min(south, box[1]);
      east = Math.max(east, box[2]);
      north = Math.max(north, box[3]);
    }
  } else {
    visit(geometry.coordinates);
  }
  return Number.isFinite(west) ? [west, south, east, north] : null;
}

/** A row's `bbox` struct as a box, or null when it is missing or partial. */
function rowBbox(value: unknown): LonLatBbox | null {
  if (!value || typeof value !== "object") return null;
  const box = value as Record<string, unknown>;
  const numbers = [box.xmin, box.ymin, box.xmax, box.ymax].map(finiteOrNull);
  return numbers.every((number) => number !== null) ? (numbers as LonLatBbox) : null;
}

/**
 * Turns rows read from an FTW GeoParquet file into GeoJSON features. hyparquet
 * decodes the GeoParquet WKB column to GeoJSON geometry already; rows without
 * one are dropped. With `clip`, only fields whose bounding box (the row's
 * `bbox` column, else the geometry's) overlaps it are kept, whole.
 */
export function ftwRowsToFeatures(
  rows: ReadonlyArray<Record<string, unknown>>,
  clip?: LonLatBbox | null,
): Feature<Geometry, FtwFieldProps>[] {
  const parts = clip ? splitAntimeridian(clip) : null;
  const features: Feature<Geometry, FtwFieldProps>[] = [];
  for (const row of rows) {
    const geometry = row.geometry as Geometry | null | undefined;
    if (!geometry || typeof geometry !== "object" || !("type" in geometry)) continue;
    if (parts) {
      const box = rowBbox(row.bbox) ?? geometryBbox(geometry);
      if (!box || !parts.some((part) => touches(box, part))) continue;
    }
    features.push({
      type: "Feature",
      geometry,
      properties: {
        id: typeof row.id === "string" ? row.id : null,
        score: finiteOrNull(row.score),
        "metrics:area": finiteOrNull(row["metrics:area"]),
        "metrics:perimeter": finiteOrNull(row["metrics:perimeter"]),
      },
    });
  }
  return features;
}

/** Thrown when a read keeps more fields than the caller allows. */
export class FtwTooManyFieldsError extends Error {
  constructor(
    /** Fields kept so far: a lower bound, as reading stopped early. */
    readonly count: number,
    readonly limit: number,
  ) {
    super(`The area holds more than ${limit} matching fields`);
    this.name = "FtwTooManyFieldsError";
  }
}

/**
 * Reads the fields of a zone file that overlap an area, one planned row group
 * at a time, so only those groups' column chunks are fetched and only the
 * kept fields outlive each group. Stops with {@link FtwTooManyFieldsError} as
 * soon as more than `maxFeatures` are kept.
 */
export async function loadFtwAreaFeatures(
  reader: FtwZoneReader,
  area: LonLatBbox,
  options: {
    maxFeatures?: number;
    signal?: AbortSignal;
    /** Called after each row group with the groups read and the total. */
    onProgress?: (groupsRead: number, totalGroups: number) => void;
  } = {},
): Promise<FeatureCollection<Geometry, FtwFieldProps>> {
  const { maxFeatures = Infinity, signal } = options;
  const plan = planFtwRead(reader.metadata, area);
  const features: Feature<Geometry, FtwFieldProps>[] = [];
  let done = 0;
  for (const group of plan.groups) {
    signal?.throwIfAborted();
    const rows = (await parquetReadObjects({
      file: reader.file,
      metadata: reader.metadata,
      columns: FIELD_COLUMNS,
      compressors,
      rowStart: group.rowStart,
      rowEnd: group.rowEnd,
    })) as Record<string, unknown>[];
    for (const feature of ftwRowsToFeatures(rows, area)) features.push(feature);
    if (features.length > maxFeatures) {
      throw new FtwTooManyFieldsError(features.length, maxFeatures);
    }
    done += 1;
    options.onProgress?.(done, plan.groups.length);
  }
  signal?.throwIfAborted();
  return { type: "FeatureCollection", features };
}
