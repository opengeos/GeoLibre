// In-browser PMTiles bbox/zoom extraction, backed by the `geolibre-wasm`
// PmtilesExtractor (the MAIN wasm-bindgen module, same one cog-convert.ts
// initialises). The wasm side is a sans-IO planner: it publishes the byte
// ranges it needs and this module fetches them with HTTP Range requests —
// bounded concurrency, retries, and abort support — then feeds the bytes
// back until the extracted archive can be assembled.
//
// The source host must allow cross-origin `Range` reads (e.g. source.coop's
// `Access-Control-Allow-Origin: *`); the Protomaps build server itself only
// allowlists a few origins, which is why GeoLibre points at a mirror.
import { PmtilesExtractor } from "geolibre-wasm";

import { initCogWasm } from "./cog-convert";

/** Extraction progress mirrored from the wasm planner. */
export interface PmtilesExtractProgress {
  phase: "header" | "directories" | "data" | "done";
  /** Tiles addressed by the selection (known once directories resolve). */
  tilesSelected: number;
  /** Distinct tile blobs to download. */
  blobsTotal: number;
  /** Planned tile-data bytes (includes small gap overfetch). */
  dataBytesTotal: number;
  dataBytesReceived: number;
  /** Rough size of the archive the extraction will produce. */
  estimatedOutputBytes: number;
}

/** Source archive facts parsed from its header. */
export interface PmtilesSourceInfo {
  /** PMTiles tile type code: 1 = MVT, 2 = PNG, 3 = JPEG, 4 = WebP, 5 = AVIF. */
  tileType: number;
  tileCompression: number;
  minZoom: number;
  maxZoom: number;
  /** `[minLon, minLat, maxLon, maxLat]` the source claims to cover. */
  bounds: [number, number, number, number];
}

export interface ExtractPmtilesOptions {
  /** `[minLon, minLat, maxLon, maxLat]` in WGS84 degrees. */
  bbox: [number, number, number, number];
  /** Lowest zoom to include; 0 (default) keeps the basemap usable zoomed out. */
  minZoom?: number;
  /** Highest zoom to include; clamped to the source archive's max. */
  maxZoom?: number;
  /** Abort cap on addressed tiles (wasm default: 2,000,000). */
  maxTiles?: number;
  /** Concurrent range requests (default 8). */
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (progress: PmtilesExtractProgress) => void;
  /**
   * Called once the tile selection is planned, before any tile data is
   * downloaded — the progress carries `dataBytesTotal` and
   * `estimatedOutputBytes`, so a UI can warn about large extracts. Return
   * `false` to cancel (the extraction rejects with an AbortError).
   */
  confirmDownload?: (progress: PmtilesExtractProgress) => boolean | Promise<boolean>;
  /** Test seam; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface PmtilesExtractResult {
  /** A complete, self-contained `.pmtiles` archive. */
  archive: Uint8Array;
  source: PmtilesSourceInfo;
  progress: PmtilesExtractProgress;
}

/** Whether a PMTiles tile-type code renders as raster tiles. */
export function pmtilesTileTypeKind(tileType: number): "vector" | "raster" {
  return tileType === 1 ? "vector" : "raster";
}

const RANGE_RETRIES = 3;
const RETRY_DELAY_MS = 500;
/** Refuse full-body (200) fallbacks larger than this: a server that ignores
 * `Range` on a planet-scale archive must fail fast, not stream 100+ GB. */
const MAX_FULL_BODY_BYTES = 64 * 1024 * 1024;

interface WantedRange {
  offset: number;
  length: number;
}

function abortError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortError("PMTiles extraction aborted");
  }
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError("PMTiles extraction aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Fetch one byte range, tolerating servers that answer a small file with a
 * plain 200 (no range support) by slicing the full body. */
async function fetchRange(
  fetchImpl: typeof fetch,
  url: string,
  range: WantedRange,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RANGE_RETRIES; attempt++) {
    throwIfAborted(signal);
    if (attempt > 0) {
      await delay(RETRY_DELAY_MS * attempt, signal);
    }
    try {
      const response = await fetchImpl(url, {
        signal,
        headers: {
          Range: `bytes=${range.offset}-${range.offset + range.length - 1}`,
        },
      });
      if (response.status === 206) {
        const body = new Uint8Array(await response.arrayBuffer());
        // Trust but verify: a misbehaving proxy/CDN could answer 206 with a
        // different (or full) body. Feeding mismatched bytes at range.offset
        // would silently corrupt the assembled archive, so reject a wrong-sized
        // 206 (retryable) instead. The final short range may be legitimately
        // clipped at EOF, so only a body *longer* than requested is rejected;
        // a shorter one is handled by the extractor's own bounds.
        if (body.length > range.length) {
          throw new Error(
            `range request returned ${body.length} bytes, expected at most ${range.length}`,
          );
        }
        return body;
      }
      if (response.status === 200) {
        // A range-less server must declare a small, known length up front:
        // without a finite content-length (e.g. chunked transfer) we can't tell
        // a 1 KB body from a 136 GB planet build without buffering it first, so
        // fail fast rather than risk streaming the whole archive into memory.
        const contentLength = Number(response.headers.get("content-length") ?? Number.NaN);
        if (!Number.isFinite(contentLength) || contentLength > MAX_FULL_BODY_BYTES) {
          throw new Error(
            "server ignored the Range header and did not report a small " +
              "content-length; the host must support HTTP range requests",
          );
        }
        const body = new Uint8Array(await response.arrayBuffer());
        return body.slice(range.offset, range.offset + range.length);
      }
      // Retry server errors and rate limiting (429); fail fast on other 4xx
      // (the URL is simply wrong).
      const message = `range request failed: HTTP ${response.status}`;
      if (response.status >= 500 || response.status === 429) {
        lastError = new Error(message);
        continue;
      }
      throw new Error(message);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      // Network-level failures (TypeError from fetch) are retryable; anything
      // we threw above with a permanent cause is not.
      if (error instanceof TypeError) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("range request failed");
}

/**
 * Run `worker` over `items` with at most `limit` in flight.
 *
 * Every lane runs to completion before this resolves or rejects: the first
 * failure is recorded and stops lanes from picking up new items, but in-flight
 * workers are awaited rather than abandoned. This matters because the caller
 * frees the wasm extractor once this returns — a lane still awaiting a fetch
 * after an early reject could otherwise call `feed()` on a freed object.
 */
async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failure: unknown;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length && failure === undefined) {
      const item = items[next];
      next += 1;
      try {
        await worker(item);
      } catch (error) {
        failure ??= error;
      }
    }
  });
  await Promise.all(lanes);
  if (failure !== undefined) throw failure;
}

/**
 * Extract the tiles intersecting `bbox` across a zoom range from a remote
 * PMTiles archive into a new, self-contained archive. Tile type, tile
 * compression, and metadata (attribution included) carry through from the
 * source.
 */
export async function extractPmtiles(
  url: string,
  options: ExtractPmtilesOptions,
): Promise<PmtilesExtractResult> {
  const {
    bbox,
    minZoom = 0,
    maxZoom = 30,
    maxTiles,
    concurrency = 8,
    signal,
    onProgress,
    confirmDownload,
    fetchImpl = fetch,
  } = options;

  await initCogWasm();
  throwIfAborted(signal);

  const extractor = new PmtilesExtractor(bbox[0], bbox[1], bbox[2], bbox[3], minZoom, maxZoom);
  try {
    if (maxTiles !== undefined) {
      extractor.set_max_tiles(maxTiles);
    }

    const readProgress = (): PmtilesExtractProgress => {
      const raw = JSON.parse(extractor.progress_json()) as {
        phase: PmtilesExtractProgress["phase"];
        tiles_selected: number;
        blobs_total: number;
        data_bytes_total: number;
        data_bytes_received: number;
        estimated_output_bytes: number;
      };
      return {
        phase: raw.phase,
        tilesSelected: raw.tiles_selected,
        blobsTotal: raw.blobs_total,
        dataBytesTotal: raw.data_bytes_total,
        dataBytesReceived: raw.data_bytes_received,
        estimatedOutputBytes: raw.estimated_output_bytes,
      };
    };

    let downloadConfirmed = false;
    while (!extractor.done) {
      throwIfAborted(signal);
      const progress = readProgress();
      if (progress.phase === "data" && !downloadConfirmed) {
        downloadConfirmed = true;
        if (confirmDownload && !(await confirmDownload(progress))) {
          throw abortError("PMTiles extraction declined");
        }
      }

      const wants = JSON.parse(extractor.wanted_json()) as WantedRange[];
      if (wants.length === 0) {
        throw new Error("PMTiles extractor stalled: not done, nothing wanted");
      }
      await runPool(wants, concurrency, async (range) => {
        const bytes = await fetchRange(fetchImpl, url, range, signal);
        // feed() runs on the JS main thread, so wasm calls never interleave.
        extractor.feed(range.offset, bytes);
        onProgress?.(readProgress());
      });
    }

    const header = JSON.parse(extractor.header_json()) as {
      tile_type: number;
      tile_compression: number;
      min_zoom: number;
      max_zoom: number;
      bounds: [number, number, number, number];
    };
    const progress = readProgress();
    onProgress?.(progress);
    const archive = extractor.finish();
    return {
      archive,
      source: {
        tileType: header.tile_type,
        tileCompression: header.tile_compression,
        minZoom: header.min_zoom,
        maxZoom: header.max_zoom,
        bounds: header.bounds,
      },
      progress,
    };
  } finally {
    extractor.free();
  }
}
