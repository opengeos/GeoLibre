/**
 * Data access for the Sentinel-2 Explorer plugin: the s2-stac-geoparquet
 * catalog published by Taylor Geospatial on Source Cooperative
 * (https://github.com/taylor-geospatial/s2-stac-geoparquet).
 *
 * Every Sentinel-2 L2A scene Earth Search indexes is republished there as
 * partitioned STAC-GeoParquet with no API in front of it, plus small MGRS
 * tile-by-month aggregates and a PMTiles archive of the MGRS grid. This module
 * reads them the way the reference explorer does
 * (https://research.taylorgeospatial.org/s2-stac-geoparquet/):
 *
 * - the map paints from `months/YYYY-MM.parquet` slices of the stats
 *   collection, fetched whole (~130 KB each) and aggregated over the window;
 * - a tile's scenes come from HTTP range reads of the year's item parts:
 *   the footer (or the published `.idx.json` sidecar) once per part, then
 *   only the column chunks of the row groups whose tile range can hold the
 *   tile, fetched in parallel. The wide `assets` column is never read; a
 *   scene's COGs sit in the directory of its thumbnail.
 *
 * Pure functions here are covered by `tests/sentinel2-explorer.test.ts`.
 */
import { VectorTile } from "@mapbox/vector-tile";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { parquetMetadata, parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { PbfReader } from "pbf";
import { PMTiles } from "pmtiles";

/** The catalog root on Source Cooperative's HTTPS gateway. */
export const S2_CATALOG_URL = "https://data.source.coop/tge-labs/s2-stac-geoparquet";
/** The reference explorer this plugin replicates. */
export const S2_EXPLORER_URL = "https://research.taylorgeospatial.org/s2-stac-geoparquet/";
/** The catalog's source repository. */
export const S2_SOURCE_URL = "https://github.com/taylor-geospatial/s2-stac-geoparquet";
/** The published catalog's landing page. */
export const S2_SOURCE_COOP_URL = "https://source.coop/tge-labs/s2-stac-geoparquet";

/** The two item collections the catalog publishes. */
export type S2CollectionId = "sentinel-2-c1-l2a" | "sentinel-2-l2a";

/** What differs between the two collections; the rest has the same shape. */
export interface S2Collection {
  id: S2CollectionId;
  /** Directory of the item parts. */
  dir: string;
  /** Directory of the stats products (month slices, MGRS PMTiles). */
  statsDir: string;
  /** Column holding the MGRS tile id (without the `T` prefix). */
  tileColumn: string;
  /** Day of the collection's oldest scene. */
  firstDate: string;
  /** Whether each archive part has a `<stem>.idx.json` search sidecar. */
  sidecars: boolean;
  /** Extra single-band masks the scenes carry, beyond {@link S2_BANDS}. */
  masks: readonly string[];
}

export const S2_COLLECTIONS: Record<S2CollectionId, S2Collection> = {
  "sentinel-2-c1-l2a": {
    id: "sentinel-2-c1-l2a",
    dir: "sentinel-2-c1-l2a",
    statsDir: "stats-c1",
    tileColumn: "_tile",
    firstDate: "2015-10-22",
    sidecars: true,
    masks: ["CLD_20m", "SNW_20m"],
  },
  "sentinel-2-l2a": {
    id: "sentinel-2-l2a",
    dir: "sentinel-2-l2a",
    statsDir: "stats",
    tileColumn: "s2:mgrs_tile",
    firstDate: "2016-11-01",
    sidecars: false,
    masks: [],
  },
};

export const S2_DEFAULT_COLLECTION: S2CollectionId = "sentinel-2-c1-l2a";

/** The MGRS grid footprints of a collection's stats. */
export function mgrsPmtilesUrl(collection: S2Collection): string {
  return `${S2_CATALOG_URL}/${collection.statsDir}/mgrs.pmtiles`;
}

/** The whole-file stats slice of one month (`YYYY-MM`). */
export function monthSliceUrl(collection: S2Collection, ym: string): string {
  return `${S2_CATALOG_URL}/${collection.statsDir}/months/${ym}.parquet`;
}

/** An MGRS tile id as the catalog stores it: zone, latitude band, square. */
export const MGRS_TILE_RE = /^\d{1,2}[C-X][A-Z]{2}$/;

// ---------------------------------------------------------------------------
// Which parts hold a tile's scenes
// ---------------------------------------------------------------------------

/**
 * The original collection splits each year from 2019 into parts by the UTM
 * zone of the tile, four from 2019 and eight from 2021, so a query for one
 * tile reads exactly one archive part (`tools/s2_build.zone_parts_for`).
 */
const ZONE_PARTS_4: ReadonlyArray<readonly [string, number, number]> = [
  ["z01-20", 1, 20],
  ["z21-35", 21, 35],
  ["z36-46", 36, 46],
  ["z47-60", 47, 60],
];
const ZONE_PARTS_8: ReadonlyArray<readonly [string, number, number]> = [
  ["z01-15", 1, 15],
  ["z16-20", 16, 20],
  ["z21-31", 21, 31],
  ["z32-35", 32, 35],
  ["z36-40", 36, 40],
  ["z41-46", 41, 46],
  ["z47-52", 47, 52],
  ["z53-60", 53, 60],
];

/**
 * The archive part stem of the original collection holding `tile` in `year`.
 *
 * @param tile - MGRS tile id, e.g. `"31UFU"`.
 * @param year - Acquisition year.
 * @returns `"items"` before 2019, the zone part after, or null for a tile id
 *   with no UTM zone.
 */
export function l2aArchivePart(tile: string, year: number): string | null {
  const parts = year >= 2021 ? ZONE_PARTS_8 : year >= 2019 ? ZONE_PARTS_4 : null;
  if (!parts) return "items";
  const digits = tile.match(/^\d{1,2}/);
  const zone = digits ? Number(digits[0]) : Number.NaN;
  const hit = parts.find(([, lo, hi]) => zone >= lo && zone <= hi);
  return hit ? hit[0] : null;
}

/**
 * The months 1-12 of `year` that the day window `[from, to]` touches.
 *
 * @param year - The year being read.
 * @param from - Window start, `YYYY-MM-DD`.
 * @param to - Window end, `YYYY-MM-DD`.
 * @returns Month numbers in order; empty when the year is outside the window.
 */
export function windowMonths(year: number, from: string, to: string): number[] {
  const y0 = Number(from.slice(0, 4));
  const y1 = Number(to.slice(0, 4));
  if (year < y0 || year > y1) return [];
  const first = year === y0 ? Number(from.slice(5, 7)) : 1;
  const last = year === y1 ? Number(to.slice(5, 7)) : 12;
  const months: number[] = [];
  for (let m = first; m <= last; m++) months.push(m);
  return months;
}

/**
 * The URLs of the parts that may hold `tile` over the window. Collection 1 is
 * one `items.parquet` per year plus a `live-MM.parquet` tail per month (and a
 * legacy, emptied `live.parquet`); the original collection is one archive
 * part plus `live.parquet` for the current year. A part that is not published
 * reads as empty, so the list may name parts that do not exist.
 *
 * @param collection - The item collection.
 * @param tile - MGRS tile id.
 * @param from - Window start, `YYYY-MM-DD`.
 * @param to - Window end, `YYYY-MM-DD`.
 * @param currentYear - The current UTC year (injectable for tests).
 * @returns Part URLs, in year order.
 */
export function partUrls(
  collection: S2Collection,
  tile: string,
  from: string,
  to: string,
  currentYear = new Date().getUTCFullYear(),
): string[] {
  const urls: string[] = [];
  for (let year = Number(from.slice(0, 4)); year <= Number(to.slice(0, 4)); year++) {
    let stems: string[];
    if (collection.id === "sentinel-2-c1-l2a") {
      stems = [
        "items",
        "live",
        ...windowMonths(year, from, to).map((m) => `live-${String(m).padStart(2, "0")}`),
      ];
    } else {
      const archive = l2aArchivePart(tile, year);
      stems = [...(archive ? [archive] : []), ...(year === currentYear ? ["live"] : [])];
    }
    for (const stem of stems) {
      urls.push(`${S2_CATALOG_URL}/${collection.dir}/year=${year}/${stem}.parquet`);
    }
  }
  return urls;
}

// ---------------------------------------------------------------------------
// Range-read machinery
// ---------------------------------------------------------------------------

/** The columns a scene search decodes; never the wide `assets` column. */
const SEARCH_COLUMNS = [
  "id",
  "datetime",
  "eo:cloud_cover",
  "s2:nodata_pixel_percentage",
  "thumbnail_url",
  "bbox",
  "s2:processing_baseline",
];

/** Most column-chunk fetches in flight per part. */
const MAX_IN_FLIGHT = 24;
/** Tail read size: holds the trailer and the whole footer of most parts. */
const TAIL_BYTES = 64 * 1024;

type FileMetaData = ReturnType<typeof parquetMetadata>;

interface ChunkRange {
  column: string;
  off: number;
  len: number;
  stats?: { min_value?: unknown; max_value?: unknown };
}

interface RowGroupRange {
  row0: number;
  row1: number;
  tileMin?: string;
  tileMax?: string;
  chunks: ChunkRange[];
}

interface PartMeta {
  url: string;
  absent?: boolean;
  /** When the metadata was read, epoch milliseconds. */
  readAt: number;
  fromSidecar?: boolean;
  size: number;
  footerOff: number;
  footer: ArrayBuffer;
  metadata: FileMetaData | null;
  groups: RowGroupRange[];
}

interface Tally {
  parts: number;
  groups: number;
  gets: number;
  bytes: number;
  absent: number;
}

/**
 * One range read. `cache: "no-store"` keeps Chrome from serialising
 * concurrent reads of one object behind its HTTP cache lock, which the
 * reference explorer measured as the largest single latency lever.
 */
async function rangeGet(
  url: string,
  start: number,
  len: number,
  signal?: AbortSignal,
  expectSize?: number,
): Promise<ArrayBuffer> {
  const res = await fetch(url, {
    cache: "no-store",
    headers: { Range: `bytes=${start}-${start + len - 1}` },
    signal,
  });
  // A 200 means the Range header was ignored; never pull a multi-GB part.
  if (res.status !== 206) throw new Error(`Range read of ${url} returned HTTP ${res.status}`);
  if (expectSize !== undefined) {
    const total = Number(res.headers.get("content-range")?.split("/")[1]);
    if (Number.isFinite(total) && total !== expectSize) {
      throw new Error(`${url} is ${total} bytes but its sidecar says ${expectSize}`);
    }
  }
  return res.arrayBuffer();
}

const big = (v: unknown): bigint | undefined =>
  v === undefined || v === null ? undefined : BigInt(v as number);

interface SidecarColumn {
  path_in_schema: string[];
  num_values?: number;
  total_compressed_size: number;
  total_uncompressed_size?: number;
  data_page_offset: number;
  dictionary_page_offset?: number;
  [key: string]: unknown;
}

interface Sidecar {
  v: number;
  size: number;
  num_rows: number;
  schema: unknown;
  groups: Array<{
    num_rows: number;
    tile_min?: string;
    tile_max?: string;
    columns: SidecarColumn[];
  }>;
}

/**
 * A part's search sidecar (`<stem>.idx.json`): the slice of the footer the
 * search needs, ~100 KB against a multi-MB footer. Rebuilt into hyparquet
 * metadata that names only the search columns, with absolute offsets.
 */
async function sidecarMeta(url: string, signal?: AbortSignal): Promise<PartMeta | null> {
  const res = await fetch(url.replace(/\.parquet$/, ".idx.json"), { signal });
  if (!res.ok) return null;
  const sc = (await res.json()) as Sidecar;
  if (sc.v !== 1 || !Array.isArray(sc.groups)) return null;
  let row = 0;
  const rowGroups = [];
  const groups: RowGroupRange[] = [];
  for (const g of sc.groups) {
    const columns = g.columns.map((c) => ({
      file_offset: 0n,
      meta_data: {
        ...c,
        num_values: big(c.num_values),
        total_compressed_size: big(c.total_compressed_size),
        total_uncompressed_size: big(c.total_uncompressed_size),
        data_page_offset: big(c.data_page_offset),
        dictionary_page_offset: big(c.dictionary_page_offset),
      },
    }));
    rowGroups.push({
      num_rows: big(g.num_rows),
      columns,
      total_byte_size: columns.reduce(
        (sum, c) => sum + (c.meta_data.total_compressed_size ?? 0n),
        0n,
      ),
    });
    groups.push({
      row0: row,
      row1: row + g.num_rows,
      tileMin: g.tile_min,
      tileMax: g.tile_max,
      chunks: g.columns.map((c) => ({
        column: c.path_in_schema[0],
        off: Number(c.dictionary_page_offset ?? c.data_page_offset),
        len: Number(c.total_compressed_size),
      })),
    });
    row += g.num_rows;
  }
  const metadata = {
    version: 2,
    created_by: "sidecar",
    num_rows: big(sc.num_rows),
    schema: sc.schema,
    row_groups: rowGroups,
    metadata_length: 0,
  } as unknown as FileMetaData;
  return {
    url,
    size: sc.size,
    footerOff: sc.size,
    footer: new ArrayBuffer(0),
    metadata,
    groups,
    fromSidecar: true,
    readAt: Date.now(),
  };
}

/** How long a part's 404 is trusted before it is probed again. */
const ABSENT_TTL_MS = 5 * 60 * 1000;

/** Footer or sidecar per part, once per session. */
const metadataCache = new Map<string, Promise<PartMeta>>();
/** Parts whose sidecar failed to decode; read through the footer instead. */
const noSidecar = new Set<string>();

function partMeta(url: string, sidecars: boolean): Promise<PartMeta> {
  let cached = metadataCache.get(url);
  if (!cached) {
    cached = (async (): Promise<PartMeta> => {
      // Only a yearly `items.parquet` gets a sidecar; the live tails never do,
      // so they skip the 404 probe.
      const sidecar =
        sidecars && url.endsWith("/items.parquet") && !noSidecar.has(url)
          ? await sidecarMeta(url).catch(() => null)
          : null;
      if (sidecar) return sidecar;
      const tail = await fetch(url, {
        cache: "no-store",
        headers: { Range: `bytes=-${TAIL_BYTES}` },
      });
      // An unpublished part (a future month's tail) is empty, not an error.
      // Only a 404 means that: a 403 (blocked, rate limited) is surfaced.
      if (tail.status === 404) {
        return {
          url,
          absent: true,
          readAt: Date.now(),
          size: 0,
          footerOff: 0,
          footer: new ArrayBuffer(0),
          metadata: null,
          groups: [],
        };
      }
      if (tail.status !== 206) throw new Error(`Range read of ${url} returned HTTP ${tail.status}`);
      const size = Number(tail.headers.get("content-range")?.split("/")[1]);
      const tailBuf = await tail.arrayBuffer();
      if (!Number.isFinite(size) || tailBuf.byteLength < 8) {
        throw new Error(`No usable Content-Range from ${url}`);
      }
      const footerLen = new DataView(tailBuf).getUint32(tailBuf.byteLength - 8, true) + 8;
      if (footerLen > size) throw new Error(`${url} names a footer larger than the file`);
      const footerOff = size - footerLen;
      const footer =
        footerLen <= tailBuf.byteLength
          ? tailBuf.slice(tailBuf.byteLength - footerLen)
          : await rangeGet(url, footerOff, footerLen);
      const metadata = parquetMetadata(footer);
      let row = 0;
      const groups = metadata.row_groups.map((g) => {
        const chunks: ChunkRange[] = [];
        for (const c of g.columns) {
          const m = c.meta_data;
          if (!m) continue;
          chunks.push({
            column: m.path_in_schema[0],
            off: Number(m.dictionary_page_offset ?? m.data_page_offset),
            len: Number(m.total_compressed_size),
            stats: m.statistics as ChunkRange["stats"],
          });
        }
        const out = { row0: row, row1: row + Number(g.num_rows), chunks };
        row += Number(g.num_rows);
        return out;
      });
      return {
        url,
        size,
        footerOff,
        footer,
        metadata,
        groups,
        readAt: Date.now(),
      };
    })();
    metadataCache.set(url, cached);
    // A failed read must not poison the cache for the next search.
    cached.catch(() => metadataCache.delete(url));
  }
  return cached;
}

const decodeStat = (v: unknown): string | null => {
  if (typeof v === "string") return v;
  if (v == null) return null;
  return new TextDecoder().decode(v as Uint8Array);
};

/**
 * The row groups whose tile range can hold `tile`. A group with no range
 * (a live part need not carry statistics) is admitted: correctness over bytes.
 */
function admittedGroups(meta: PartMeta, tileColumn: string, tile: string): RowGroupRange[] {
  return meta.groups.filter((g) => {
    let min: string | null | undefined;
    let max: string | null | undefined;
    if (g.tileMin !== undefined) {
      min = g.tileMin;
      max = g.tileMax;
    } else {
      const chunk = g.chunks.find((c) => c.column === tileColumn);
      if (!chunk) return false;
      min = decodeStat(chunk.stats?.min_value);
      max = decodeStat(chunk.stats?.max_value);
    }
    if (min == null || max == null) return true;
    return min <= tile && tile <= max;
  });
}

interface Region {
  off: number;
  buf: ArrayBuffer;
}

/** An AsyncBuffer over the prefetched chunks; a miss falls through to HTTP. */
function regionBuffer(url: string, size: number, regions: Region[], signal?: AbortSignal) {
  // Every fall-through read checks the object is still the size the
  // metadata was read from.
  return {
    byteLength: size,
    async slice(start: number, end?: number): Promise<ArrayBuffer> {
      const stop = end ?? size;
      for (const r of regions) {
        if (start >= r.off && stop <= r.off + r.buf.byteLength) {
          return r.buf.slice(start - r.off, stop - r.off);
        }
      }
      return rangeGet(url, start, stop - start, signal, size);
    },
  };
}

type RawRow = Record<string, unknown>;

async function searchPartWith(
  meta: PartMeta,
  tileColumn: string,
  tile: string,
  tally: Tally,
  signal?: AbortSignal,
): Promise<RawRow[]> {
  const groups = admittedGroups(meta, tileColumn, tile);
  if (!groups.length || !meta.metadata) return [];
  tally.parts += 1;
  tally.groups += groups.length;
  const columns = [tileColumn, ...SEARCH_COLUMNS];
  const jobs = groups.flatMap((g) => g.chunks.filter((c) => columns.includes(c.column)));
  const regions: Region[] = [{ off: meta.footerOff, buf: meta.footer }];
  // Always checked: a live tail is rewritten in place by the daily refresh,
  // so cached offsets must never be read against a different object.
  const expectSize = meta.size;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(MAX_IN_FLIGHT, jobs.length) }, async () => {
      while (next < jobs.length) {
        const job = jobs[next];
        next += 1;
        const buf = await rangeGet(meta.url, job.off, job.len, signal, expectSize);
        tally.gets += 1;
        tally.bytes += buf.byteLength;
        regions.push({ off: job.off, buf });
      }
    }),
  );
  const file = regionBuffer(meta.url, meta.size, regions, signal);
  const metadata = meta.metadata;
  const parts = await Promise.all(
    groups.map(
      (g) =>
        parquetReadObjects({
          file,
          metadata,
          compressors,
          columns,
          rowStart: g.row0,
          rowEnd: g.row1,
        }) as Promise<RawRow[]>,
    ),
  );
  return parts.flat().filter((r) => r[tileColumn] === tile);
}

async function searchPart(
  url: string,
  collection: S2Collection,
  tile: string,
  tally: Tally,
  signal?: AbortSignal,
): Promise<RawRow[]> {
  let meta = await partMeta(url, collection.sidecars);
  // A tail that was not published yet (a new month) may appear during the
  // session, so an absence is only trusted for a few minutes.
  if (meta.absent && Date.now() - meta.readAt > ABSENT_TTL_MS) {
    metadataCache.delete(url);
    meta = await partMeta(url, collection.sidecars);
  }
  if (meta.absent) {
    tally.absent += 1;
    return [];
  }
  try {
    return await searchPartWith(meta, collection.tileColumn, tile, tally, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    // A rewritten part (a refreshed live tail, a re-folded year) or a stale
    // or malformed sidecar: read its footer again once and retry.
    metadataCache.delete(url);
    if (meta.fromSidecar) noSidecar.add(url);
    const fresh = await partMeta(url, collection.sidecars);
    if (fresh.absent) {
      tally.absent += 1;
      return [];
    }
    return searchPartWith(fresh, collection.tileColumn, tile, tally, signal);
  }
}

/** One Sentinel-2 scene, projected to what the panel shows and filters on. */
export interface S2Scene {
  /** STAC item id, e.g. `S2B_T31UET_20260921T105030_L2A`. */
  id: string;
  /** Acquisition time, epoch milliseconds. */
  t: number;
  /** Acquisition day, `YYYY-MM-DD` (UTC). */
  day: string;
  /** Scene cloud cover, percent. */
  cloud: number;
  /** Share of the tile the scene fills, percent, or null when unknown. */
  cover: number | null;
  /** Browse image URL; the scene's COGs sit in the same directory. */
  thumbnailUrl: string;
  /** `[west, south, east, north]` in degrees. */
  bbox: number[];
  /** Processing baseline, e.g. `"05.11"`. */
  baseline: string | null;
}

/**
 * Turns decoded parquet rows into scenes: drops rows without a usable time,
 * derives coverage from the nodata percentage, and sorts by time then id.
 *
 * @param raw - Rows decoded from the item parts.
 * @returns Scenes, oldest first.
 */
export function toScenes(raw: RawRow[]): S2Scene[] {
  const scenes: S2Scene[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const id = typeof r.id === "string" ? r.id : null;
    // The live tail and the archive are disjoint except during a fold, so a
    // dedupe on id is always safe.
    if (!id || seen.has(id)) continue;
    const dt = r.datetime;
    const t = dt instanceof Date ? dt.getTime() : Date.parse(String(dt));
    if (!Number.isFinite(t)) continue;
    seen.add(id);
    const nodata = Number(r["s2:nodata_pixel_percentage"]);
    const bbox = r.bbox;
    scenes.push({
      id,
      t,
      day: new Date(t).toISOString().slice(0, 10),
      cloud: Number(r["eo:cloud_cover"]),
      cover:
        r["s2:nodata_pixel_percentage"] != null && Number.isFinite(nodata) ? 100 - nodata : null,
      thumbnailUrl: typeof r.thumbnail_url === "string" ? r.thumbnail_url : "",
      bbox: Array.isArray(bbox)
        ? bbox.map(Number)
        : bbox && typeof bbox === "object"
          ? bboxFromStruct(bbox as Record<string, unknown>)
          : [],
      baseline:
        typeof r["s2:processing_baseline"] === "string" ? r["s2:processing_baseline"] : null,
    });
  }
  return scenes.sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function bboxFromStruct(b: Record<string, unknown>): number[] {
  const values = [b.xmin, b.ymin, b.xmax, b.ymax].map(Number);
  return values.every(Number.isFinite) ? values : [];
}

/** The outcome of a tile search, with the read plan the panel reports. */
export interface S2SearchResult {
  scenes: S2Scene[];
  /** Parts that held the tile. */
  parts: number;
  /** HTTP range GETs issued for column chunks. */
  gets: number;
  /** Bytes read for column chunks. */
  bytes: number;
  /** Wall time, milliseconds. */
  ms: number;
}

/**
 * Every scene of `tile` in the window's parts, unfiltered. The panel filters
 * by date, cloud and coverage in memory, so a slider drag reads nothing.
 *
 * @param collection - The item collection.
 * @param tile - MGRS tile id.
 * @param from - Window start, `YYYY-MM-DD`.
 * @param to - Window end, `YYYY-MM-DD`.
 * @param signal - Aborts the column-chunk reads.
 * @returns The scenes and the read plan.
 */
export async function searchTileScenes(
  collection: S2Collection,
  tile: string,
  from: string,
  to: string,
  signal?: AbortSignal,
): Promise<S2SearchResult> {
  if (!MGRS_TILE_RE.test(tile)) throw new Error(`Not an MGRS tile id: ${tile}`);
  const tally: Tally = { parts: 0, groups: 0, gets: 0, bytes: 0, absent: 0 };
  const t0 = performance.now();
  const urls = partUrls(collection, tile, from, to);
  const raw = (
    await Promise.all(urls.map((url) => searchPart(url, collection, tile, tally, signal)))
  ).flat();
  return {
    scenes: toScenes(raw),
    parts: tally.parts,
    gets: tally.gets,
    bytes: tally.bytes,
    ms: performance.now() - t0,
  };
}

// ---------------------------------------------------------------------------
// Scene filters and sorting
// ---------------------------------------------------------------------------

export interface S2SceneFilters {
  /** Window start, `YYYY-MM-DD`. */
  from: string;
  /** Window end, `YYYY-MM-DD`, inclusive. */
  to: string;
  /** Cloud ceiling, percent. */
  maxCloud: number;
  /** Coverage floor, percent; 0 disables it. */
  minCoverage: number;
}

export type S2SceneSort = "cloud" | "coverage" | "date";

const cmpId = (a: S2Scene, b: S2Scene) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The scenes that pass the filters, sorted. A scene with unknown coverage is
 * never excluded by the coverage floor, matching how the map treats it.
 *
 * @param scenes - All scenes of the tile.
 * @param filters - Date window, cloud ceiling, coverage floor.
 * @param sort - `cloud` (clearest first), `coverage` (fullest first), or
 *   `date` (newest first).
 * @returns A new, filtered and sorted array.
 */
export function filterScenes(
  scenes: S2Scene[],
  filters: S2SceneFilters,
  sort: S2SceneSort,
): S2Scene[] {
  const lo = Date.parse(`${filters.from}T00:00:00Z`);
  const hi = Date.parse(`${filters.to}T23:59:59.999Z`);
  const kept = scenes.filter(
    (s) =>
      s.t >= lo &&
      s.t <= hi &&
      s.cloud <= filters.maxCloud &&
      (filters.minCoverage <= 0 || s.cover === null || s.cover >= filters.minCoverage),
  );
  const cmp =
    sort === "coverage"
      ? (a: S2Scene, b: S2Scene) =>
          (b.cover ?? -1) - (a.cover ?? -1) || a.cloud - b.cloud || cmpId(a, b)
      : sort === "date"
        ? (a: S2Scene, b: S2Scene) => b.t - a.t || cmpId(a, b)
        : (a: S2Scene, b: S2Scene) => a.cloud - b.cloud || cmpId(a, b);
  return kept.sort(cmp);
}

/**
 * The frames of the time slider: the scenes that pass the filters, oldest
 * first, so stepping forward moves forward in time.
 *
 * @param scenes - All scenes of the tile.
 * @param filters - Date window, cloud ceiling, coverage floor.
 * @returns The passing scenes in chronological order.
 */
export function timeSeriesScenes(scenes: S2Scene[], filters: S2SceneFilters): S2Scene[] {
  return filterScenes(scenes, filters, "date").sort((a, b) => a.t - b.t || cmpId(a, b));
}

/**
 * The slider position of a scene in a series, clamped into range: the index
 * of `sceneId` when the series still holds it, else the nearest earlier frame
 * by time (or the first), so a filter change keeps the slider near where the
 * user left it.
 *
 * @param series - The chronological frames.
 * @param sceneId - The scene the slider showed, or null.
 * @param t - That scene's acquisition time, epoch ms, or null.
 * @returns The index, or -1 for an empty series.
 */
export function timeSeriesIndex(
  series: S2Scene[],
  sceneId: string | null,
  t: number | null,
): number {
  if (!series.length) return -1;
  if (sceneId !== null) {
    const exact = series.findIndex((scene) => scene.id === sceneId);
    if (exact >= 0) return exact;
  }
  if (t === null) return 0;
  let index = 0;
  for (let i = 0; i < series.length; i++) {
    if (series[i].t <= t) index = i;
    else break;
  }
  return index;
}

// ---------------------------------------------------------------------------
// Scene imagery
// ---------------------------------------------------------------------------

/**
 * The buckets Earth Search keeps Sentinel-2 L2A COGs in: Collection 1 and the
 * original collection. A scene directory anywhere else is refused, so a
 * crafted project or tile URL cannot point the reader at another host.
 */
export const S2_SCENE_HOSTS: ReadonlySet<string> = new Set([
  "e84-earth-search-sentinel-data.s3.us-west-2.amazonaws.com",
  "sentinel-cogs.s3.us-west-2.amazonaws.com",
]);

/**
 * The directory holding a scene's COGs (`TCI.tif`, `B04.tif`, `SCL.tif`, ...),
 * derived from its thumbnail URL so the wide `assets` column is never read.
 *
 * @param thumbnailUrl - The scene's `thumbnail_url`.
 * @returns The directory URL without a trailing slash.
 * @throws When the URL is not https or not on an expected host.
 */
export function sceneDirectory(thumbnailUrl: string): string {
  let url: URL;
  try {
    url = new URL(thumbnailUrl);
  } catch {
    throw new Error(`The scene has no usable thumbnail URL: ${thumbnailUrl}`);
  }
  if (url.protocol !== "https:") throw new Error(`Thumbnail URL is not https: ${thumbnailUrl}`);
  if (!S2_SCENE_HOSTS.has(url.hostname)) {
    throw new Error(`Thumbnail URL is on an unexpected host: ${url.hostname}`);
  }
  url.pathname = url.pathname.replace(/\/[^/]*$/, "");
  url.search = "";
  url.hash = "";
  return url.href;
}

/** A band of a scene the panel can add to the map. */
export interface S2Band {
  /** File stem in the scene directory. */
  key: string;
  label: string;
  /** Native resolution, meters. */
  res: number;
}

export const S2_BANDS: readonly S2Band[] = [
  { key: "B01", label: "Coastal aerosol (443 nm)", res: 60 },
  { key: "B02", label: "Blue (490 nm)", res: 10 },
  { key: "B03", label: "Green (560 nm)", res: 10 },
  { key: "B04", label: "Red (665 nm)", res: 10 },
  { key: "B05", label: "Red edge 1 (705 nm)", res: 20 },
  { key: "B06", label: "Red edge 2 (740 nm)", res: 20 },
  { key: "B07", label: "Red edge 3 (783 nm)", res: 20 },
  { key: "B08", label: "NIR (842 nm)", res: 10 },
  { key: "B8A", label: "Narrow NIR (865 nm)", res: 20 },
  { key: "B09", label: "Water vapour (945 nm)", res: 60 },
  { key: "B11", label: "SWIR 1 (1610 nm)", res: 20 },
  { key: "B12", label: "SWIR 2 (2190 nm)", res: 20 },
  { key: "AOT", label: "Aerosol optical thickness", res: 20 },
  { key: "WVP", label: "Water vapour column", res: 20 },
  { key: "SCL", label: "Scene classification", res: 20 },
];

export const S2_MASK_BANDS: readonly S2Band[] = [
  { key: "CLD_20m", label: "Cloud probability", res: 20 },
  { key: "SNW_20m", label: "Snow probability", res: 20 },
];

/**
 * The BOA offset a scene's reflectance DN carry: 1000 from processing
 * baseline 04.00 (January 2022) on, else 0 (also when the baseline is unknown).
 *
 * @param baseline - The scene's processing baseline, e.g. `"05.11"`.
 * @returns 1000 or 0.
 */
export function baselineOffset(baseline: string | null): number {
  return baseline && /^\d\d\.\d\d$/.test(baseline) && baseline >= "04.00" ? 1000 : 0;
}

/**
 * The display range of a single band, in stored DN. Reflectance is DN/10000,
 * plus a BOA offset of 1000 from processing baseline 04.00 (January 2022) on.
 *
 * @param band - Band key.
 * @param baseline - The scene's processing baseline, when known.
 * @returns `[min, max]` for the contrast stretch.
 */
export function bandRescale(band: string, baseline: string | null): [number, number] {
  if (band === "CLD_20m" || band === "SNW_20m") return [0, 100];
  // tab20 has 20 entries, so 0..19 gives each class value its own color.
  if (band === "SCL") return [0, 19];
  if (band === "AOT") return [0, 1000];
  if (band === "WVP") return [0, 6000];
  const offset = baselineOffset(baseline);
  // Visible land sits below ~0.3 reflectance; vegetation reaches ~0.5 in the
  // red edge and NIR, and ~0.4 in SWIR 1.
  const top = /^B0[5-8]$|^B8A$/.test(band)
    ? 6000
    : band === "B11"
      ? 5000
      : band === "B12"
        ? 4000
        : 3000;
  return [offset, offset + top];
}

// ---------------------------------------------------------------------------
// MGRS stats for the choropleth
// ---------------------------------------------------------------------------

/** The quantities the map can color tiles by. */
export type S2Metric = "min_cloud_cover" | "scene_count" | "median_cloud_cover" | "max_cover";

export const S2_METRICS: readonly S2Metric[] = [
  "min_cloud_cover",
  "scene_count",
  "median_cloud_cover",
  "max_cover",
];

/** One tile's numbers in one month slice. */
export interface S2MonthRow {
  tile: string;
  /** Clearest scene's cloud cover. */
  cc: number | null;
  /** Number of scenes. */
  sc: number | null;
  /** Most of the tile any one scene fills. */
  cover: number | null;
  /** Median scene cloud cover. */
  med: number | null;
}

/** Aggregated numbers of one tile over the window. */
export interface S2TileStats {
  /** The metric on the 0 (good, green) to 100 (bad, dark red) ramp. */
  v: number;
  cc: number | null;
  sc: number | null;
  cover: number | null;
}

/**
 * The `YYYY-MM` months the day window overlaps.
 *
 * @param from - Window start, `YYYY-MM-DD`.
 * @param to - Window end, `YYYY-MM-DD`.
 * @returns Months in order.
 */
export function monthsIn(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const end = Number(to.slice(0, 4)) * 100 + Number(to.slice(5, 7));
  while (y * 100 + m <= end) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    if (m === 12) {
      y += 1;
      m = 1;
    } else {
      m += 1;
    }
  }
  return out;
}

/**
 * A metric's raw value on the shared 0-100 ramp, where 0 is good: cloud as
 * is, coverage inverted, and scene counts scaled so 12 or more is green.
 *
 * @param metric - The metric.
 * @param raw - Its raw value.
 * @returns A value in [0, 100].
 */
export function onRamp(metric: S2Metric, raw: number): number {
  if (metric === "scene_count") return Math.max(0, 100 - raw * 8);
  if (metric === "max_cover") return Math.max(0, Math.min(100, 100 - raw));
  return Math.max(0, Math.min(100, raw));
}

/**
 * Aggregates month slices per tile: the clearest scene's cloud is a minimum,
 * coverage a maximum, scene count a sum, and the median cloud the best
 * month's median (an approximation; a true median needs the raw scenes).
 *
 * @param months - The month slices of the window.
 * @param metric - The metric the map colors by.
 * @returns Tile id to aggregated stats; tiles without the metric are left out.
 */
export function aggregateMonths(
  months: ReadonlyArray<readonly S2MonthRow[]>,
  metric: S2Metric,
): Map<string, S2TileStats> {
  const acc = new Map<string, Omit<S2MonthRow, "tile">>();
  for (const rows of months) {
    for (const r of rows) {
      const cur = acc.get(r.tile);
      if (!cur) {
        acc.set(r.tile, { cc: r.cc, sc: r.sc, cover: r.cover, med: r.med });
        continue;
      }
      if (r.cc !== null) cur.cc = cur.cc === null ? r.cc : Math.min(cur.cc, r.cc);
      if (r.sc !== null) cur.sc = (cur.sc ?? 0) + r.sc;
      if (r.cover !== null) cur.cover = cur.cover === null ? r.cover : Math.max(cur.cover, r.cover);
      if (r.med !== null) cur.med = cur.med === null ? r.med : Math.min(cur.med, r.med);
    }
  }
  const out = new Map<string, S2TileStats>();
  for (const [tile, s] of acc) {
    const raw =
      metric === "scene_count"
        ? s.sc
        : metric === "max_cover"
          ? s.cover
          : metric === "median_cloud_cover"
            ? s.med
            : s.cc;
    if (raw == null) continue;
    out.set(tile, {
      v: onRamp(metric, raw),
      cc: s.cc,
      sc: s.sc,
      cover: s.cover,
    });
  }
  return out;
}

/** The map filters: a tile failing any of them is drawn grey. */
export interface S2TileFilters {
  maxCloud: number;
  minCoverage: number;
  minScenes: number;
}

/**
 * Whether a tile's aggregate passes the map filters. A null value is unknown
 * and never fails a filter.
 *
 * @param s - The tile's aggregate.
 * @param f - The filters.
 * @returns True when the tile passes.
 */
export function tilePasses(s: S2TileStats, f: S2TileFilters): boolean {
  if (s.cc !== null && s.cc > f.maxCloud) return false;
  if (s.cover !== null && s.cover < f.minCoverage) return false;
  if (s.sc !== null && s.sc < f.minScenes) return false;
  return true;
}

/** The choropleth ramp, 0 (good) to 100 (bad), from the reference explorer. */
export const S2_RAMP: ReadonlyArray<readonly [number, string]> = [
  [0, "#1a9850"],
  [25, "#fee08b"],
  [60, "#d73027"],
  [100, "#4d0013"],
];

const monthSlices = new Map<string, Promise<S2MonthRow[] | null>>();
/** Slices kept decoded; three years covers any window moved back and forth. */
const MONTH_CACHE_MAX = 36;

/**
 * One month's stats slice, decoded once and cached. A 404 (no slice for the
 * month) resolves to null; a failed fetch is forgotten so the next call retries.
 *
 * @param collection - The item collection whose stats to read.
 * @param ym - `YYYY-MM`.
 * @returns The month's rows, or null when the month has none.
 */
export function loadMonthSlice(collection: S2Collection, ym: string): Promise<S2MonthRow[] | null> {
  const url = monthSliceUrl(collection, ym);
  let cached = monthSlices.get(url);
  if (!cached) {
    cached = (async () => {
      const res = await fetch(url);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      const rows = (await parquetReadObjects({
        file: buf,
        compressors,
        columns: ["mgrs_tile", "min_cloud_cover", "scene_count", "max_cover", "median_cloud_cover"],
      })) as RawRow[];
      const num = (v: unknown) => (v == null ? null : Number(v));
      return rows.map((r) => ({
        tile: String(r.mgrs_tile),
        cc: num(r.min_cloud_cover),
        sc: num(r.scene_count),
        cover: num(r.max_cover),
        med: num(r.median_cloud_cover),
      }));
    })();
    monthSlices.set(url, cached);
    cached.catch(() => monthSlices.delete(url));
    if (monthSlices.size > MONTH_CACHE_MAX) {
      const oldest = monthSlices.keys().next().value;
      if (oldest !== undefined) monthSlices.delete(oldest);
    }
  }
  return cached;
}

// ---------------------------------------------------------------------------
// MGRS grid
// ---------------------------------------------------------------------------

/** One MGRS grid cell; `v` is filled in per window by the panel. */
export interface S2GridProperties {
  mgrs_tile: string;
  [key: string]: unknown;
}

const gridCache = new Map<string, Promise<FeatureCollection<Geometry, S2GridProperties>>>();

/**
 * The MGRS grid footprints as GeoJSON, decoded once from the stats PMTiles.
 * The archive's z0 tile holds every cell unclipped (~35k polygons), which is
 * precise enough to pick a tile and avoids stitching cells split across the
 * z1 tiles.
 *
 * @param collection - The item collection whose stats grid to read.
 * @returns The grid, one feature per MGRS tile.
 */
export function loadMgrsGrid(
  collection: S2Collection,
): Promise<FeatureCollection<Geometry, S2GridProperties>> {
  const url = mgrsPmtilesUrl(collection);
  let cached = gridCache.get(url);
  if (!cached) {
    cached = (async () => {
      const archive = new PMTiles(url);
      const tile = await archive.getZxy(0, 0, 0);
      if (!tile?.data) throw new Error(`${url} has no z0 tile`);
      const layer = new VectorTile(new PbfReader(new Uint8Array(tile.data))).layers.mgrs;
      if (!layer) throw new Error(`${url} has no "mgrs" layer`);
      const features: Feature<Geometry, S2GridProperties>[] = [];
      for (let i = 0; i < layer.length; i++) {
        const feature = layer.feature(i).toGeoJSON(0, 0, 0) as Feature<Geometry, S2GridProperties>;
        const id = feature.properties?.mgrs_tile;
        if (typeof id !== "string") continue;
        features.push({
          type: "Feature",
          geometry: feature.geometry,
          properties: { mgrs_tile: id },
        });
      }
      return { type: "FeatureCollection", features };
    })();
    gridCache.set(url, cached);
    cached.catch(() => gridCache.delete(url));
  }
  return cached;
}

/** Most month slices fetched at once. */
const MONTH_FETCH_CONCURRENCY = 6;

/**
 * The month slices of a window, at most {@link MONTH_FETCH_CONCURRENCY} in
 * flight, so a multi-year window does not fire a hundred requests at once.
 *
 * @param collection - The item collection whose stats to read.
 * @param months - `YYYY-MM` months, in order.
 * @returns Each month's rows (null when the month has no slice), in order.
 */
export async function loadMonthSlices(
  collection: S2Collection,
  months: readonly string[],
): Promise<Array<S2MonthRow[] | null>> {
  const out = new Array<S2MonthRow[] | null>(months.length);
  let next = 0;
  // After one month fails the whole read fails, so stop starting new ones.
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(MONTH_FETCH_CONCURRENCY, months.length) }, async () => {
      while (!failed && next < months.length) {
        const i = next;
        next += 1;
        try {
          out[i] = await loadMonthSlice(collection, months[i]);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  return out;
}
