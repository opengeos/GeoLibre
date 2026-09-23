/**
 * Fields of the World (FTW) global field boundary predictions.
 *
 * FTW (https://fieldsofthe.world) publishes agricultural field boundaries
 * predicted worldwide from Sentinel-2 by its PRUE model, on Source Cooperative:
 *
 * - one global vector PMTiles archive per year, the whole dataset as tiles;
 * - a 1° download grid (GeoJSON), listing per tile which years exist, how many
 *   fields each holds, and the size of its file;
 * - one GeoParquet file per grid tile and year (WKB polygons with the model's
 *   `confidence_mean`/`median`/`min`, a `label` and a `time`);
 * - global 500 m field-density and confidence COGs (EPSG:3857, uint8, 0–200,
 *   NoData 255) for the zoomed-out view.
 *
 * These are the same files the FTW inference app reads. Everything here is
 * pure (no map, no DOM) so it can be tested directly.
 */

import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import { asyncBufferFromUrl, parquetMetadataAsync, parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { bboxesIntersect, type LonLatBbox } from "./satellite-embeddings-grids";

export const FTW_BASE_URL = "https://data.source.coop/ftw";

/** Years with published global predictions, oldest first. */
export const FTW_YEARS = [2024, 2025] as const;
export type FtwYear = (typeof FTW_YEARS)[number];
export const FTW_DEFAULT_YEAR: FtwYear = 2025;

/** The FTW app's default confidence threshold, in percent. */
export const FTW_DEFAULT_THRESHOLD = 70;

/**
 * The highest `confidence_mean` the model assigns. The FTW app maps its 0–100%
 * threshold slider linearly onto 0..this, so "70%" keeps the same fields here
 * as there.
 */
export const FTW_MAX_CONFIDENCE = 0.578178;

export const FTW_DOWNLOAD_GRID_URL = `${FTW_BASE_URL}/global-field-boundaries/download-tiles/ftw-download-grid-v2.geojson`;
export const FTW_DENSITY_COG_URL = `${FTW_BASE_URL}/global-data/predictions/confidence/field-density/prue_v1_field_area_500m_fieldsonly_uint8_3857.tif`;
export const FTW_CONFIDENCE_COG_URL = `${FTW_BASE_URL}/global-data/predictions/confidence/confidence/prue_v1_confidence_global_uint8_3857.tif`;
/** Value range and NoData of the density and confidence COGs. */
export const FTW_COG_RANGE: [number, number] = [0, 200];
export const FTW_COG_NODATA = 255;

export const FTW_WEBSITE_URL = "https://fieldsofthe.world";
export const FTW_APP_URL = "https://fieldsofthe.world/ftw-inference-app";
export const FTW_DATA_URL = "https://source.coop/ftw/global-data/";
export const FTW_PAPER_URL = "https://arxiv.org/abs/2603.27101";
export const FTW_LICENSE = "CC-BY-4.0";

/** How one year's global archive is laid out. */
export interface FtwArchive {
  url: string;
  /** The vector-tile layer the fields are in. */
  sourceLayer: string;
  /** Lowest zoom the archive has tiles for; the map is empty below it. */
  minZoom: number;
}

/**
 * The global field-boundary PMTiles archive for a year. 2025 is the released
 * archive (tiles from zoom 0); 2024 is the earlier alpha, tiled only from 10.
 */
export function ftwArchive(year: FtwYear): FtwArchive {
  if (year === 2024) {
    return {
      url: `${FTW_BASE_URL}/global-data/predictions/vectors/alpha/2024_with_confidence.pmtiles`,
      sourceLayer: "2024",
      minZoom: 10,
    };
  }
  return {
    url: `${FTW_BASE_URL}/global-field-boundaries/pmtiles/ftw-global-fields-${year}.pmtiles`,
    sourceLayer: "fields",
    minZoom: 0,
  };
}

/** URL of the GeoParquet file for one 1° grid tile and year. */
export function ftwTileParquetUrl(year: number, tileId: string): string {
  return `${FTW_BASE_URL}/global-field-boundaries/download-tiles/geoparquet/${year}/${year}_${tileId}.parquet`;
}

/** A threshold percentage (0–100) as a `confidence_mean` value. */
export function thresholdToConfidence(percent: number): number {
  const clamped = Math.max(0, Math.min(100, percent));
  return (clamped / 100) * FTW_MAX_CONFIDENCE;
}

/**
 * Confidence color ramp (red → orange → pale yellow → pale green → green),
 * the FTW app's stops at 0, 70, 80, 90 and 100% of the threshold scale.
 */
export const FTW_CONFIDENCE_STOPS: ReadonlyArray<{ percent: number; color: string }> = [
  { percent: 0, color: "#d7191c" },
  { percent: 70, color: "#fec379" },
  { percent: 80, color: "#f3fabb" },
  { percent: 90, color: "#cfecb0" },
  { percent: 100, color: "#33a02c" },
];

/**
 * `confidence_mean` as a number. The 2025 archive stores it as a string and
 * the 2024 one as either, so the expression coerces (a missing value is 0).
 */
const CONFIDENCE_VALUE = ["to-number", ["get", "confidence_mean"], 0];

/**
 * A MapLibre color expression coloring fields by confidence. The stops are
 * wrapped in `to-color`: bare color strings leave the output typed as a
 * string, which `interpolate` rejects unless the caller's context says color.
 */
export function confidenceColorExpression(): unknown[] {
  return [
    "interpolate",
    ["linear"],
    CONFIDENCE_VALUE,
    ...FTW_CONFIDENCE_STOPS.flatMap((stop) => [
      thresholdToConfidence(stop.percent),
      ["to-color", stop.color],
    ]),
  ];
}

/**
 * A MapLibre filter keeping fields at or above a threshold percentage, or
 * undefined for 0% (every field, so no filter is needed).
 */
export function confidenceFilterExpression(percent: number): unknown[] | undefined {
  if (!(percent > 0)) return undefined;
  return [">=", CONFIDENCE_VALUE, roundConfidence(thresholdToConfidence(percent))];
}

/** Rounds a confidence value so filters stay short and compare stably. */
function roundConfidence(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Reads the threshold percentage back out of a filter this module built, so a
 * restored project's layer shows the slider where it was left. Null when the
 * filter is absent or was not built here (edited by hand).
 */
export function thresholdFromFilter(filter: unknown): number | null {
  if (filter === undefined || filter === null) return 0;
  if (!Array.isArray(filter) || filter.length !== 3 || filter[0] !== ">=") return null;
  if (JSON.stringify(filter[1]) !== JSON.stringify(CONFIDENCE_VALUE)) return null;
  const value = filter[2];
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round((value / FTW_MAX_CONFIDENCE) * 100);
}

// ---------------------------------------------------------------------------
// Download grid
// ---------------------------------------------------------------------------

/** One 1° cell of the download grid. */
export interface FtwGridTile {
  /** e.g. `N40W090`: the cell's south-west corner. */
  id: string;
  bbox: LonLatBbox;
  /** Years with a file for this cell. */
  years: number[];
  /** Fields per year. */
  featureCounts: Record<string, number>;
  /** File size in bytes per year. */
  sizeBytes: Record<string, number>;
}

/** Most grid tiles one search lists. */
export const FTW_MAX_SEARCH_TILES = 200;

function numberRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const number = Number(entry);
    if (Number.isFinite(number)) out[key] = number;
  }
  return out;
}

/**
 * Parses the download grid GeoJSON. Each cell's box is its 1° square, taken
 * from `lon_min`/`lat_min` (the geometry is that square too, but the numbers
 * are cheaper and exact). Cells missing an id or corner are skipped.
 */
export function parseFtwDownloadGrid(data: unknown): FtwGridTile[] {
  const features = (data as { features?: unknown })?.features;
  if (!Array.isArray(features)) throw new Error("The FTW download grid is not a FeatureCollection");
  const tiles: FtwGridTile[] = [];
  for (const feature of features) {
    const props = (feature as { properties?: Record<string, unknown> })?.properties;
    if (!props) continue;
    const id = typeof props.tile_id === "string" ? props.tile_id : null;
    const lon = Number(props.lon_min);
    const lat = Number(props.lat_min);
    if (!id || !Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    tiles.push({
      id,
      bbox: [lon, lat, lon + 1, lat + 1],
      years: Array.isArray(props.years)
        ? props.years.map(Number).filter((year) => Number.isFinite(year))
        : [],
      featureCounts: numberRecord(props.feature_counts),
      sizeBytes: numberRecord(props.size_bytes),
    });
  }
  return tiles;
}

/**
 * Grid tiles overlapping a box that have a file for the year, most fields
 * first (the cells a user most likely wants), capped at `limit`.
 *
 * @returns The tiles to show and how many matched in total.
 */
export function searchFtwGrid(
  tiles: readonly FtwGridTile[],
  bbox: LonLatBbox,
  year: number,
  limit = FTW_MAX_SEARCH_TILES,
): { tiles: FtwGridTile[]; total: number } {
  const key = String(year);
  const matches = tiles.filter(
    (tile) => tile.years.includes(year) && bboxesIntersect(tile.bbox, bbox),
  );
  matches.sort(
    (a, b) => (b.featureCounts[key] ?? 0) - (a.featureCounts[key] ?? 0) || a.id.localeCompare(b.id),
  );
  return { tiles: matches.slice(0, limit), total: matches.length };
}

// ---------------------------------------------------------------------------
// GeoParquet tiles
// ---------------------------------------------------------------------------

/** Properties of a field read from a tile's GeoParquet file. */
export interface FtwFieldProps {
  confidence_mean: number | null;
  confidence_median: number | null;
  confidence_min: number | null;
  label: string | null;
  time: string | null;
  tile_id: string | null;
  [key: string]: unknown;
}

function finiteOrNull(value: unknown): number | null {
  const number = typeof value === "bigint" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
}

function timeString(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string") return value;
  return null;
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

/** Whether a geometry overlaps a box (by its bounding box; touching counts). */
function geometryTouchesBbox(geometry: Geometry | null, bbox: LonLatBbox): boolean {
  const box = geometryBbox(geometry);
  return (
    box !== null && box[0] <= bbox[2] && box[2] >= bbox[0] && box[1] <= bbox[3] && box[3] >= bbox[1]
  );
}

/**
 * Turns rows read from an FTW GeoParquet file into GeoJSON features. hyparquet
 * decodes the GeoParquet WKB column to GeoJSON geometry already; rows without
 * one are dropped. With `clip`, only fields whose bounding box overlaps it are
 * kept (fields are whole polygons, never cut).
 */
export function ftwRowsToFeatures(
  rows: ReadonlyArray<Record<string, unknown>>,
  clip?: LonLatBbox | null,
): Feature<Geometry, FtwFieldProps>[] {
  const features: Feature<Geometry, FtwFieldProps>[] = [];
  for (const row of rows) {
    const geometry = row.geometry as Geometry | null | undefined;
    if (!geometry || typeof geometry !== "object" || !("type" in geometry)) continue;
    if (clip && !geometryTouchesBbox(geometry, clip)) continue;
    features.push({
      type: "Feature",
      geometry,
      properties: {
        confidence_mean: finiteOrNull(row.confidence_mean),
        confidence_median: finiteOrNull(row.confidence_median),
        confidence_min: finiteOrNull(row.confidence_min),
        label: typeof row.label === "string" ? row.label : null,
        time: timeString(row.time),
        tile_id: typeof row.chunk_id === "string" ? row.chunk_id : null,
      },
    });
  }
  return features;
}

/** Thrown when a tile read keeps more fields than the caller allows. */
export class FtwTooManyFieldsError extends Error {
  constructor(
    /** Fields kept so far: the whole count, or a lower bound when `partial`. */
    readonly count: number,
    readonly limit: number,
    /** Whether reading stopped early, so the true count is higher. */
    readonly partial: boolean,
  ) {
    super(`The tile holds ${partial ? "more than " : ""}${count} matching fields (limit ${limit})`);
    this.name = "FtwTooManyFieldsError";
  }
}

const TILE_COLUMNS = [
  "time",
  "label",
  "confidence_mean",
  "confidence_median",
  "confidence_min",
  "geometry",
  "chunk_id",
];

/**
 * Reads one tile's GeoParquet file as GeoJSON features, one row group at a
 * time. The largest tiles hold ~3 million fields in ~123k-row groups, and
 * decoding a whole file at once exhausts the tab's memory; per group, only
 * the kept fields outlive the group. Reading stops with
 * {@link FtwTooManyFieldsError} as soon as more than `maxFeatures` are kept.
 */
export async function loadFtwTileFeatures(
  url: string,
  options: {
    clip?: LonLatBbox | null;
    maxFeatures?: number;
    signal?: AbortSignal;
    /** Called after each row group with the rows read and the total. */
    onProgress?: (rowsRead: number, totalRows: number) => void;
  } = {},
): Promise<FeatureCollection<Geometry, FtwFieldProps>> {
  const { clip, maxFeatures = Infinity, signal } = options;
  const file = await asyncBufferFromUrl({ url, requestInit: { signal } });
  const metadata = await parquetMetadataAsync(file);
  const totalRows = Number(metadata.num_rows);
  const features: Feature<Geometry, FtwFieldProps>[] = [];
  let rowStart = 0;
  for (const group of metadata.row_groups) {
    signal?.throwIfAborted();
    const rowEnd = rowStart + Number(group.num_rows);
    const rows = (await parquetReadObjects({
      file,
      metadata,
      columns: TILE_COLUMNS,
      compressors,
      rowStart,
      rowEnd,
    })) as Record<string, unknown>[];
    for (const feature of ftwRowsToFeatures(rows, clip)) features.push(feature);
    rowStart = rowEnd;
    if (features.length > maxFeatures) {
      throw new FtwTooManyFieldsError(features.length, maxFeatures, rowStart < totalRows);
    }
    options.onProgress?.(rowStart, totalRows);
  }
  signal?.throwIfAborted();
  return { type: "FeatureCollection", features };
}

/** Whether a clip box covers a whole grid tile, so clipping keeps every field. */
export function clipCoversTile(clip: LonLatBbox, tile: FtwGridTile): boolean {
  return (
    clip[0] <= tile.bbox[0] &&
    clip[1] <= tile.bbox[1] &&
    clip[2] >= tile.bbox[2] &&
    clip[3] >= tile.bbox[3]
  );
}
