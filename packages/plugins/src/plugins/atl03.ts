// Read ICESat-2 ATL03 geolocated photons for an area, without loading the
// granule into memory.
//
// ATL03 granules hold every photon of an orbit segment (1-7 GB), so unlike the
// footprint products they cannot be written whole into h5wasm's in-memory
// filesystem. This module opens one lazily instead, from a local File mounted
// with WORKERFS or from a URL read in byte ranges, and reads only what an area
// needs: each beam's ~20 m geolocation segments first (a few MB), then just the
// photon index range those segments point at inside the bounding box.
//
// Lazy reads are synchronous (FileReaderSync, synchronous XMLHttpRequest), which
// browsers allow only in a worker: run this from a Web Worker
// (apps/geolibre-desktop/src/workers/atl03.worker.ts), never the main thread.
// Imported by the worker from this module directly, never the package barrel.

import type { FeatureCollection, Point } from "geojson";
import type { H5Dataset, H5File, H5Group, H5wasmModule } from "./local-netcdf";

/** Seconds in delta_time count from the ICESat-2 epoch, 2018-01-01T00:00:00Z. */
const EPOCH_MS = Date.UTC(2018, 0, 1);
const BEAM_PATTERN = /^gt[123][lr]$/;

/** Surface types, the columns of `signal_conf_ph`. */
export const ATL03_SURFACES = ["land", "ocean", "sea_ice", "land_ice", "inland_water"] as const;
export type Atl03Surface = (typeof ATL03_SURFACES)[number];

/** A ground track in the granule. */
export interface Atl03Beam {
  name: string;
  /** `strong` or `weak`, from the group's `atlas_beam_type`. */
  type: string | null;
  photons: number;
}

/** What to read. */
export interface Atl03ReadOptions {
  /** `[west, south, east, north]`; required, since a granule holds millions of photons. */
  bbox: [number, number, number, number];
  /** Ground tracks to read; all when omitted. */
  beams?: string[];
  /**
   * Lowest signal confidence to keep: 0 noise, 1 buffer, 2 low, 3 medium,
   * 4 high. Defaults to 2 (signal photons, noise and buffer dropped).
   */
  minConfidence?: number;
  /** Which surface's confidence to test. Defaults to `land`. */
  surface?: Atl03Surface;
  /** Cap on photons; every beam is thinned evenly to stay under it. */
  maxPoints?: number;
}

/** Properties on every photon point. */
export interface Atl03PhotonProperties {
  beam: string;
  beam_type: string | null;
  /** Photon height above the WGS 84 ellipsoid, m. */
  h_ph: number;
  /** Signal confidence for the chosen surface (0-4). */
  signal_conf: number;
  time: string | null;
  /** Along-track distance from the first photon read on this beam, km (to about 20 m). */
  distance_km: number;
}

/** Photons read for an area, with counts for reporting. */
export interface Atl03Photons {
  geojson: FeatureCollection<Point, Atl03PhotonProperties>;
  /** Photons in the index ranges read (before the per-photon filters). */
  scanned: number;
  /** Photons inside the bbox with enough confidence. */
  matched: number;
  /** Photons in `geojson` after thinning. */
  kept: number;
  stride: number;
  perBeam: Array<{ beam: string; kept: number }>;
}

/** An open ATL03 granule. */
export interface Atl03File {
  beams: Atl03Beam[];
  readPhotons(options: Atl03ReadOptions): Atl03Photons;
  close(): void;
}

/**
 * Whether a file or granule name is an ATL03 granule.
 *
 * @param name A file name or URL.
 * @returns True for `ATL03_…` names.
 */
export function isAtl03Name(name: string): boolean {
  const base = name.split(/[?#]/)[0].split(/[\\/]/).pop() ?? "";
  return base.toUpperCase().startsWith("ATL03");
}

function isDataset(value: unknown): value is H5Dataset {
  return typeof value === "object" && value !== null && "shape" in value && "slice" in value;
}

function isGroup(value: unknown): value is H5Group {
  return typeof value === "object" && value !== null && "keys" in value && !("shape" in value);
}

function tryGet(group: H5Group, path: string): unknown {
  try {
    return group.get(path);
  } catch {
    return undefined;
  }
}

function dataset(group: H5Group, path: string): H5Dataset | null {
  const value = tryGet(group, path);
  return isDataset(value) ? value : null;
}

function stringAttr(entity: unknown, name: string): string | null {
  const attrs = (entity as { attrs?: Record<string, { value: unknown }> } | null)?.attrs;
  let value = attrs?.[name]?.value;
  if (Array.isArray(value)) value = value[0];
  return typeof value === "string" ? value : null;
}

/** Read a whole 1-D dataset as plain numbers (BigInt arrays converted). */
function readAll(ds: H5Dataset): ArrayLike<number> {
  return toNumbers(ds.value);
}

/** Read `[start, end)` of a 1-D dataset. */
function readRange(ds: H5Dataset, start: number, end: number): ArrayLike<number> {
  return toNumbers(ds.slice([[start, end]]));
}

function toNumbers(value: unknown): ArrayLike<number> {
  if (value instanceof BigInt64Array || value instanceof BigUint64Array) {
    return Float64Array.from(value, (v) => Number(v));
  }
  if (ArrayBuffer.isView(value)) return value as unknown as ArrayLike<number>;
  if (Array.isArray(value)) return value.map(Number);
  return [];
}

function isoTime(seconds: number): string | null {
  if (!Number.isFinite(seconds) || Math.abs(seconds) > 1e10) return null;
  return new Date(EPOCH_MS + seconds * 1000).toISOString();
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Whether a point is inside a bbox (west > east crosses the antimeridian). */
function inBbox(lon: number, lat: number, [west, south, east, north]: Atl03ReadOptions["bbox"]) {
  if (!(lat >= south && lat <= north)) return false;
  if (east - west >= 360) return true;
  if (west > east) return lon >= west || lon <= east;
  // The map reports an antimeridian-crossing view unwrapped (east > 180),
  // while photon longitudes are in [-180, 180].
  const x = east > 180 && lon < west ? lon + 360 : lon;
  return x >= west && x <= east;
}

/** Entries read per probe when searching a sorted dataset (about one HDF5 chunk). */
const PROBE_BLOCK = 4096;
/** Segments added on each side of the latitude window. */
const WINDOW_PAD = 50;

/**
 * The index window `[lo, hi)` of a beam's segments whose reference latitude
 * lies in `[south, north]`, found by binary search without reading the whole
 * array. ATL03 granules are cut so latitude changes monotonically along each
 * beam; a lazily read granule then costs a few small reads here instead of the
 * full segment arrays (14 MB a beam in a dense granule). Returns null when the
 * sampled latitudes are not monotonic, so the caller reads everything.
 */
function latitudeWindow(
  ds: H5Dataset,
  south: number,
  north: number,
): { lo: number; hi: number } | null {
  const n = ds.shape?.[0] ?? 0;
  if (n < PROBE_BLOCK * 4) return null;
  const blocks = new Map<number, ArrayLike<number>>();
  const at = (index: number): number => {
    const block = Math.floor(index / PROBE_BLOCK);
    let values = blocks.get(block);
    if (!values) {
      const from = block * PROBE_BLOCK;
      values = readRange(ds, from, Math.min(n, from + PROBE_BLOCK));
      blocks.set(block, values);
    }
    return values[index - block * PROBE_BLOCK];
  };
  // Monotonic check on a few samples; any reversal falls back to a full read.
  const samples = [0, Math.floor(n / 4), Math.floor(n / 2), Math.floor((3 * n) / 4), n - 1].map(at);
  if (!samples.every(Number.isFinite)) return null;
  const ascending = samples[samples.length - 1] >= samples[0];
  for (let i = 1; i < samples.length; i += 1) {
    if (ascending ? samples[i] < samples[i - 1] : samples[i] > samples[i - 1]) return null;
  }
  // First index whose latitude has entered the band, and first past it.
  const firstWhere = (test: (value: number) => boolean): number => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (test(at(mid))) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };
  const lo = ascending ? firstWhere((v) => v >= south) : firstWhere((v) => v <= north);
  const hi = ascending ? firstWhere((v) => v > north) : firstWhere((v) => v < south);
  // Reference latitudes jitter by a few segments along a monotonic track, so
  // pad the window (50 segments, about 1 km) rather than trusting its edges.
  return { lo: Math.max(0, lo - WINDOW_PAD), hi: Math.min(n, hi + WINDOW_PAD) };
}

/** Segments added around a window reused from another beam (about 10 km). */
const SHARED_PAD = 500;

/**
 * The latitude window of one beam, widened to serve every beam: the six tracks
 * run side by side, a few km apart, on the same segment rows. Searching one
 * beam instead of six saves most of the small reads, each a full round trip
 * when the granule is read over HTTP.
 */
function sharedWindow(
  file: H5File,
  beams: Atl03Beam[],
  bbox: Atl03ReadOptions["bbox"],
): { lo: number; hi: number; total: number } | null {
  const first = beams[0];
  if (!first) return null;
  const lat = dataset(tryGet(file, first.name) as H5Group, "geolocation/reference_photon_lat");
  const total = lat?.shape?.[0] ?? 0;
  if (!lat) return null;
  const window = latitudeWindow(lat, bbox[1], bbox[3]);
  if (!window) return null;
  return {
    lo: Math.max(0, window.lo - SHARED_PAD),
    hi: Math.min(total, window.hi + SHARED_PAD),
    total,
  };
}

/**
 * The photon index range `[start, end)` a beam's segments cover inside a bbox,
 * plus the per-segment data the photons need, or null when no segment falls
 * inside. Segments are ~20 m, so the range is padded by one segment on each
 * side to keep photons of a segment whose reference photon sits just outside.
 * `begs` and `counts` hold segments `base..` (index them with `s - base`).
 */
function segmentRange(
  group: H5Group,
  bbox: Atl03ReadOptions["bbox"],
  shared?: { lo: number; hi: number; total: number } | null,
) {
  const lat = dataset(group, "geolocation/reference_photon_lat");
  const lon = dataset(group, "geolocation/reference_photon_lon");
  const beg = dataset(group, "geolocation/ph_index_beg");
  const cnt = dataset(group, "geolocation/segment_ph_cnt");
  if (!lat || !lon || !beg || !cnt) return null;
  const total = lat.shape?.[0] ?? 0;
  // Beams share segment indexing (same along-track segment per row), so a
  // window found on one beam serves the others when their lengths match.
  const window =
    shared && shared.total === total
      ? { lo: shared.lo, hi: shared.hi }
      : (latitudeWindow(lat, bbox[1], bbox[3]) ?? { lo: 0, hi: total });
  if (window.hi <= window.lo) return null;
  const base = window.lo;
  const lats = readRange(lat, window.lo, window.hi);
  const lons = readRange(lon, window.lo, window.hi);
  const begs = readRange(beg, window.lo, window.hi);
  const counts = readRange(cnt, window.lo, window.hi);
  let first = -1;
  let last = -1;
  for (let i = 0; i < lats.length; i += 1) {
    // ph_index_beg is 1-based; 0 marks a segment with no photons.
    if (counts[i] <= 0 || begs[i] <= 0) continue;
    if (inBbox(lons[i], lats[i], bbox)) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return null;
  // Pad by one non-empty segment each side (within the window read).
  let lo = first;
  for (let i = first - 1; i >= 0; i -= 1) {
    if (counts[i] > 0 && begs[i] > 0) {
      lo = i;
      break;
    }
  }
  let hi = last;
  for (let i = last + 1; i < lats.length; i += 1) {
    if (counts[i] > 0 && begs[i] > 0) {
      hi = i;
      break;
    }
  }
  const start = begs[lo] - 1;
  const end = begs[hi] - 1 + counts[hi];
  return { lo: lo + base, hi: hi + base, start, end, begs, counts, base };
}

/**
 * Open an ATL03 granule already present in h5wasm's filesystem (a WORKERFS
 * mount or a range-backed lazy file).
 *
 * @param mod The loaded h5wasm module.
 * @param path The file's path in the h5wasm filesystem.
 * @returns The open granule.
 * @throws If the file is not ATL03 or has no ground tracks with photons.
 */
export function openAtl03(mod: H5wasmModule, path: string): Atl03File {
  const file: H5File = new mod.File(path, "r");
  try {
    const shortName = stringAttr(file, "short_name");
    if (shortName && shortName.trim().toUpperCase() !== "ATL03") {
      throw new Error(`This is an ${shortName} granule, not ATL03.`);
    }
    const beams: Atl03Beam[] = [];
    for (const name of file.keys().sort()) {
      if (!BEAM_PATTERN.test(name)) continue;
      const group = tryGet(file, name);
      if (!isGroup(group)) continue;
      const heights = dataset(group, "heights/h_ph");
      const photons = heights?.shape?.[0] ?? 0;
      if (photons === 0) continue;
      const type = stringAttr(group, "atlas_beam_type");
      beams.push({ name, type: type ? type.toLowerCase() : null, photons });
    }
    if (beams.length === 0) throw new Error("This granule has no ground tracks with photons.");
    return {
      beams,
      readPhotons: (options) => readPhotons(file, beams, options),
      close: () => {
        try {
          file.close();
        } catch {
          /* best effort */
        }
      },
    };
  } catch (error) {
    try {
      file.close();
    } catch {
      /* best effort */
    }
    throw error;
  }
}

function readPhotons(file: H5File, beams: Atl03Beam[], options: Atl03ReadOptions): Atl03Photons {
  const bbox = options.bbox;
  const minConfidence = options.minConfidence ?? 2;
  const surfaceColumn = Math.max(0, ATL03_SURFACES.indexOf(options.surface ?? "land"));
  const wanted = options.beams ? new Set(options.beams) : null;

  // First pass: per beam, the photon range and the photons that pass.
  const passes: Array<{
    beam: Atl03Beam;
    lat: ArrayLike<number>;
    lon: ArrayLike<number>;
    h: ArrayLike<number>;
    conf: Int8Array | ArrayLike<number>;
    time: Float64Array;
    xAtc: Float64Array;
    keep: number[];
  }> = [];
  let scanned = 0;
  let matched = 0;
  const chosen = beams.filter((beam) => !wanted || wanted.has(beam.name));
  const shared = sharedWindow(file, chosen, bbox);
  for (const beam of chosen) {
    const group = tryGet(file, beam.name) as H5Group;
    const range = segmentRange(group, bbox, shared);
    if (!range) continue;
    const { start, end } = range;
    const latDs = dataset(group, "heights/lat_ph");
    const lonDs = dataset(group, "heights/lon_ph");
    const hDs = dataset(group, "heights/h_ph");
    const confDs = dataset(group, "heights/signal_conf_ph");
    if (!latDs || !lonDs || !hDs || !confDs) continue;
    const lat = readRange(latDs, start, end);
    const lon = readRange(lonDs, start, end);
    const h = readRange(hDs, start, end);
    // [n, 5] row-major: this surface's value is every fifth entry.
    const confRows = toNumbers(confDs.slice([[start, end], []]));
    const columns = confDs.shape?.[1] ?? 5;
    const conf = new Int8Array(end - start);
    for (let i = 0; i < conf.length; i += 1) conf[i] = confRows[i * columns + surfaceColumn];
    // Time and along-track distance come from the ~20 m segments rather than
    // per-photon datasets: each photon dataset costs a compressed chunk read
    // per 100k photons, which over HTTP is the read's main cost. Within a
    // segment a photon is placed by its order (distance) and takes the
    // segment's time; both are exact to about a segment.
    const xAtc = new Float64Array(end - start);
    const time = new Float64Array(end - start).fill(Number.NaN);
    const segDistDs = dataset(group, "geolocation/segment_dist_x");
    const segTimeDs = dataset(group, "geolocation/delta_time");
    // The last segment can be in view, so never read past the dataset's end.
    const segEnd = (ds: H5Dataset) => Math.min(range.hi + 1, ds.shape?.[0] ?? range.hi + 1);
    const segDist = segDistDs ? readRange(segDistDs, range.lo, segEnd(segDistDs)) : null;
    const segTime = segTimeDs ? readRange(segTimeDs, range.lo, segEnd(segTimeDs)) : null;
    for (let s = range.lo; s <= range.hi; s += 1) {
      const count = range.counts[s - range.base];
      const first = range.begs[s - range.base] - 1;
      if (count <= 0 || first < 0) continue;
      const startX = segDist ? segDist[s - range.lo] : 0;
      // A segment's length from the next one's start (about 20 m).
      const next = segDist && s < range.hi ? segDist[s - range.lo + 1] : Number.NaN;
      const length = Number.isFinite(next) && next > startX ? next - startX : 20;
      for (let k = 0; k < count; k += 1) {
        const i = first + k - start;
        if (i < 0 || i >= xAtc.length) continue;
        xAtc[i] = startX + ((k + 0.5) / count) * length;
        if (segTime) time[i] = segTime[s - range.lo];
      }
    }

    scanned += end - start;
    const keep: number[] = [];
    for (let i = 0; i < lat.length; i += 1) {
      if (conf[i] < minConfidence) continue;
      if (!Number.isFinite(h[i]) || Math.abs(h[i]) > 1e37) continue;
      if (!inBbox(lon[i], lat[i], bbox)) continue;
      keep.push(i);
    }
    matched += keep.length;
    passes.push({ beam, lat, lon, h, conf, time, xAtc, keep });
  }

  const maxPoints = options.maxPoints && options.maxPoints > 0 ? options.maxPoints : Infinity;
  const stride = matched > maxPoints ? Math.ceil(matched / maxPoints) : 1;
  const features: Atl03Photons["geojson"]["features"] = [];
  const perBeam: Atl03Photons["perBeam"] = [];
  let offset = 0;
  for (const pass of passes) {
    let x0 = Number.POSITIVE_INFINITY;
    for (const i of pass.keep) if (pass.xAtc[i] < x0) x0 = pass.xAtc[i];
    let kept = 0;
    for (let k = 0; k < pass.keep.length; k += 1) {
      if ((offset + k) % stride !== 0) continue;
      const i = pass.keep[k];
      features.push({
        type: "Feature",
        id: features.length,
        geometry: { type: "Point", coordinates: [round(pass.lon[i], 7), round(pass.lat[i], 7)] },
        properties: {
          beam: pass.beam.name,
          beam_type: pass.beam.type,
          h_ph: round(pass.h[i], 3),
          signal_conf: pass.conf[i],
          time: isoTime(pass.time[i]),
          distance_km: Number.isFinite(x0) ? round((pass.xAtc[i] - x0) / 1000, 5) : 0,
        },
      });
      kept += 1;
    }
    offset += pass.keep.length;
    perBeam.push({ beam: pass.beam.name, kept });
  }
  return {
    geojson: { type: "FeatureCollection", features },
    scanned,
    matched,
    kept: features.length,
    stride,
    perBeam,
  };
}

/**
 * Merge photons read in parts (one part per worker, each a subset of the
 * beams, possibly already thinned to `maxPoints` by its worker) into one
 * result: concatenated in part order, thinned evenly across all of them to
 * `maxPoints`, and re-numbered. `matched` sums the parts; `stride` is the
 * overall thinning, approximated as matched / kept.
 *
 * @param parts Results of reading disjoint beam subsets.
 * @param maxPoints Cap on photons, or 0 / undefined for none.
 * @returns The merged result.
 */
export function mergeAtl03Photons(parts: Atl03Photons[], maxPoints?: number): Atl03Photons {
  const matched = parts.reduce((sum, part) => sum + part.matched, 0);
  // Parts may already be capped by their workers, so thin over what arrived.
  const arrived = parts.reduce((sum, part) => sum + part.geojson.features.length, 0);
  const cap = maxPoints && maxPoints > 0 ? maxPoints : Infinity;
  const step = arrived > cap ? Math.ceil(arrived / cap) : 1;
  const features: Atl03Photons["geojson"]["features"] = [];
  const perBeam: Atl03Photons["perBeam"] = [];
  let offset = 0;
  for (const part of parts) {
    const counts = new Map<string, number>();
    for (const feature of part.geojson.features) {
      if (offset % step === 0) {
        features.push({ ...feature, id: features.length });
        counts.set(feature.properties.beam, (counts.get(feature.properties.beam) ?? 0) + 1);
      }
      offset += 1;
    }
    for (const entry of part.perBeam) {
      perBeam.push({ beam: entry.beam, kept: counts.get(entry.beam) ?? 0 });
    }
  }
  return {
    geojson: { type: "FeatureCollection", features },
    scanned: parts.reduce((sum, part) => sum + part.scanned, 0),
    matched,
    kept: features.length,
    stride: features.length > 0 ? Math.max(1, Math.round(matched / features.length)) : 1,
    perBeam,
  };
}

// ---------------------------------------------------------------------------
// Lazy sources (worker only)
// ---------------------------------------------------------------------------

interface LazyFs {
  mkdir(path: string): void;
  mount(type: unknown, opts: unknown, mountpoint: string): void;
  unmount(mountpoint: string): void;
  rmdir(path: string): void;
  unlink(path: string): void;
  filesystems: { WORKERFS?: unknown };
  createLazyFile(
    parent: string,
    name: string,
    url: string,
    canRead: boolean,
    canWrite: boolean,
  ): {
    contents: unknown;
    stream_ops: Record<string, unknown>;
  };
}

let sourceCounter = 0;

/**
 * Mount a local File so h5wasm reads it lazily (FileReaderSync slices).
 *
 * @param mod The loaded h5wasm module.
 * @param file The File picked by the user.
 * @returns The path to open and a disposer that unmounts it.
 */
export function mountLocalFile(
  mod: H5wasmModule,
  file: File,
): { path: string; dispose: () => void } {
  const fs = mod.FS as unknown as LazyFs;
  if (!fs.filesystems.WORKERFS) throw new Error("This h5wasm build cannot read files lazily.");
  const dir = `/atl03-local-${sourceCounter++}`;
  fs.mkdir(dir);
  fs.mount(fs.filesystems.WORKERFS, { files: [file] }, dir);
  return {
    path: `${dir}/${file.name}`,
    dispose: () => {
      try {
        fs.unmount(dir);
        fs.rmdir(dir);
      } catch {
        /* best effort */
      }
    },
  };
}

/** Options for {@link createRangeFile}. */
export interface RangeFileOptions {
  /** Headers for every request (an Earthdata Login bearer token). */
  headers?: Record<string, string>;
  /**
   * Block size for small reads (HDF5 metadata), cached. A read at least this
   * large (a whole compressed chunk) is fetched as one exact range instead.
   */
  chunkSize?: number;
  /** Chunks kept in memory (least recently used dropped first). */
  maxChunks?: number;
  /** Called after each range request with the bytes it returned. */
  onFetch?: (bytes: number) => void;
}

/**
 * Synchronously fetch `[start, end]` (inclusive) of a URL.
 *
 * @returns The bytes and the total size from `Content-Range`.
 */
function syncRange(
  url: string,
  start: number,
  end: number,
  headers: Record<string, string>,
): { bytes: Uint8Array; total: number | null } {
  const xhr = new XMLHttpRequest();
  xhr.open("GET", url, false);
  xhr.setRequestHeader("Range", `bytes=${start}-${end}`);
  for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
  // Synchronous XHR cannot use responseType in a window, but can in a worker.
  xhr.responseType = "arraybuffer";
  xhr.send(null);
  if (xhr.status !== 206 && xhr.status !== 200) {
    const detail =
      typeof xhr.response === "object" && xhr.response
        ? new TextDecoder().decode(new Uint8Array(xhr.response as ArrayBuffer)).slice(0, 200)
        : "";
    throw new Error(detail || `The server answered ${xhr.status}.`);
  }
  const contentRange = xhr.getResponseHeader("Content-Range");
  const total = contentRange ? Number(contentRange.split("/")[1]) : null;
  const bytes = new Uint8Array(xhr.response as ArrayBuffer);
  if (xhr.status === 200 && bytes.length > end - start + 1) {
    // The server ignored the range: refuse rather than keep reading a
    // multi-gigabyte file whole, one request at a time.
    throw new Error(
      "The server does not support byte-range requests, so the granule cannot be read lazily.",
    );
  }
  return { bytes, total: Number.isFinite(total) ? total : null };
}

/**
 * Create a lazy h5wasm file backed by HTTP range requests, with an LRU chunk
 * cache. Unlike Emscripten's own lazy file it learns the size from a ranged
 * GET (the Earthdata relay accepts only GET), sends request headers, copies
 * whole chunk slices instead of one byte per call, and evicts old chunks, so a
 * multi-gigabyte granule reads in bounded memory.
 *
 * @param mod The loaded h5wasm module.
 * @param url The file URL (it must serve byte ranges with CORS).
 * @param options Headers and cache sizing.
 * @returns The path to open and a disposer.
 */
export function createRangeFile(
  mod: H5wasmModule,
  url: string,
  options: RangeFileOptions = {},
): { path: string; dispose: () => void } {
  const fs = mod.FS as unknown as LazyFs;
  const headers = options.headers ?? {};
  const fetchRange = (start: number, end: number) => {
    const result = syncRange(url, start, end, headers);
    options.onFetch?.(result.bytes.length);
    return result;
  };
  // Moderate blocks: HDF5 metadata reads are a few KB scattered across the
  // file, so big blocks fetch bytes nobody reads, while tiny ones multiply
  // round trips (about half a second each to NASA's storage). 256 KB measured
  // best for a dense granule's view.
  const chunkSize = options.chunkSize ?? 256 * 1024;
  // About 32 MB a worker; a remote read runs up to six.
  const maxChunks = options.maxChunks ?? 128;
  const probe = syncRange(url, 0, 0, headers);
  const length = probe.total;
  if (!length) throw new Error("The server did not report the file size for a range request.");

  const chunks = new Map<number, Uint8Array>();
  const chunk = (index: number): Uint8Array => {
    const cached = chunks.get(index);
    if (cached) {
      chunks.delete(index);
      chunks.set(index, cached);
      return cached;
    }
    const start = index * chunkSize;
    const end = Math.min(length, start + chunkSize) - 1;
    const { bytes } = fetchRange(start, end);
    chunks.set(index, bytes);
    while (chunks.size > maxChunks) {
      const oldest = chunks.keys().next().value;
      if (oldest === undefined) break;
      chunks.delete(oldest);
    }
    return bytes;
  };

  const name = `atl03-remote-${sourceCounter++}.h5`;
  // The URL argument is never fetched: contents and read are replaced below
  // before anything opens the file.
  const node = fs.createLazyFile("/", name, url, true, false);
  node.contents = {
    length,
    get: (index: number) => chunk(Math.floor(index / chunkSize))[index % chunkSize],
  };
  node.stream_ops = {
    ...node.stream_ops,
    read: (
      _stream: unknown,
      buffer: Uint8Array,
      offset: number,
      want: number,
      position: number,
    ): number => {
      if (position >= length) return 0;
      const size = Math.min(length - position, want);
      if (size >= chunkSize) {
        // A whole compressed chunk: one exact request. No read-ahead: over a
        // slow link the bytes cost more than the requests, which the client
        // spreads across parallel workers.
        const { bytes } = fetchRange(position, position + size - 1);
        const take = Math.min(size, bytes.length);
        buffer.set(bytes.subarray(0, take), offset);
        return take;
      }
      let copied = 0;
      while (copied < size) {
        const at = position + copied;
        const index = Math.floor(at / chunkSize);
        const data = chunk(index);
        const from = at - index * chunkSize;
        const take = Math.min(size - copied, data.length - from);
        if (take <= 0) break;
        buffer.set(data.subarray(from, from + take), offset + copied);
        copied += take;
      }
      return copied;
    },
  };
  return {
    path: `/${name}`,
    dispose: () => {
      chunks.clear();
      try {
        fs.unlink(`/${name}`);
      } catch {
        /* best effort */
      }
    },
  };
}
