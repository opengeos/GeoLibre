// Client-side vector tiling for large local vector layers.
//
// Above a feature-count threshold (see `shouldUseTiledRendering` in
// `@geolibre/core`), a local GeoJSON layer is rendered through vector tiles
// generated in-browser rather than one in-memory geojson source pushed via
// `setData`. We build a `GeoJSONVT` index (or a `Supercluster` index for
// clustered point layers — both ship in `@maplibre/geojson-vt`, the same engine
// MapLibre uses internally), encode requested tiles to MVT with `vt-pbf`, and
// serve them through a custom MapLibre protocol — mirroring the pmtiles/mbtiles
// `type:"vector"` pattern already used in `layer-sync.ts`.
//
// The index build and the tile encoding run on a Web Worker
// (geojson-vt.worker.ts): both are single tasks proportional to the layer, and
// on the main thread they froze the UI for most of a second after a large load
// (#2869). The layer's features cross to the worker in chunks with a yield
// between posts, so the copy is many short tasks; encoded tiles come back as
// transferred buffers. Where there is no Worker (node, tests) or it fails to
// start, the same code runs inline as before.

import { addProtocol, config, type RequestParameters } from "maplibre-gl";
import {
  buildTileIndex,
  encodeTile,
  TILE_WORKER_CHUNK_FEATURES,
  type GeoJsonVtSourceOptions,
  type TileIndex,
  type TileWorkerMessage,
  type TileWorkerRequest,
} from "./geojson-vt-index";

export { TILE_MAX_ZOOM, TILE_SOURCE_LAYER, type GeoJsonVtSourceOptions } from "./geojson-vt-index";

/** Custom protocol scheme handled by {@link ensureGeoJsonVtProtocol}. */
export const GEOJSONVT_PROTOCOL = "geolibre-gjvt";

interface RegistryEntry {
  /** Reference to the geojson last indexed — used to detect data changes. */
  geojsonRef: GeoJSON.FeatureCollection;
  cluster: boolean;
  clusterRadius: number;
  clusterMaxZoom: number;
  /**
   * The index, when this thread holds it: built inline (no worker), or built
   * lazily here after the worker failed. Null while the worker holds it.
   */
  index: TileIndex | null;
  /** Settles once the worker has been sent everything it needs to build. */
  posted: Promise<void> | null;
}

// Keyed by layer id. Module-level rather than on the Zustand record because tile
// indexes are large, non-serializable objects that must not enter app state or
// be written to `.geolibre.json`.
const registry = new Map<string, RegistryEntry>();

/**
 * Resolve on a later task. `scheduler.yield` where it exists; otherwise a
 * MessageChannel round trip, which unlike `setTimeout(0)` is not clamped to
 * 4 ms once nested, so yielding after each of a hundred chunks stays cheap.
 * (Same helper as `@geolibre/processing`'s vector-tool-runner.ts.)
 */
function yieldToEventLoop(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === "function") return scheduler.yield();
  if (typeof MessageChannel === "function") {
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(null);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * The main thread's side of the tiling worker: sends layers to be indexed and
 * turns tile requests into promises of encoded bytes.
 *
 * Once the worker fails (its module did not load, it crashed, or a layer could
 * not be cloned to it) every pending and later request resolves `null`, which
 * tells the caller to tile that layer on this thread instead.
 */
export class TileWorkerHost {
  private failed = false;
  private nextRequestId = 1;
  private readonly pending = new Map<number, (data: ArrayBuffer | null) => void>();
  private readonly worker: Worker;
  private readonly onFailed: () => void;

  /**
   * @param worker The tiling worker (geojson-vt.worker.ts or a test double).
   * @param onFailed Called once if the worker fails.
   */
  constructor(worker: Worker, onFailed: () => void = () => {}) {
    this.worker = worker;
    this.onFailed = onFailed;
    worker.addEventListener("message", (event: MessageEvent<TileWorkerMessage>) => {
      const message = event.data;
      const resolve = this.pending.get(message.requestId);
      this.pending.delete(message.requestId);
      resolve?.(message.data);
    });
    worker.addEventListener("error", () => this.fail());
    worker.addEventListener("messageerror", () => this.fail());
  }

  /**
   * Stop using the worker: terminate it and settle every pending request with
   * `null`. `notify` reports an actual failure (not a deliberate shutdown).
   */
  private fail(notify = true): void {
    if (this.failed) return;
    this.failed = true;
    this.worker.terminate();
    for (const resolve of this.pending.values()) resolve(null);
    this.pending.clear();
    if (notify) this.onFailed();
  }

  /** Post a request; a message that cannot be cloned fails the worker. */
  private post(request: TileWorkerRequest): boolean {
    if (this.failed) return false;
    try {
      this.worker.postMessage(request);
      return true;
    } catch {
      this.fail();
      return false;
    }
  }

  /**
   * Send a layer's features to be indexed, a chunk per task.
   *
   * @param layerId The layer's id.
   * @param generation Distinguishes this build from an earlier or later one of
   *   the same layer, whose chunks may interleave with it.
   * @param geojson The features to index.
   * @param options Clustering configuration.
   * @param isCurrent Whether this build is still the layer's latest; a
   *   superseded build stops posting.
   * @returns Settles once everything is posted (or the build was abandoned).
   */
  async build(
    layerId: string,
    generation: number,
    geojson: GeoJSON.FeatureCollection,
    options: GeoJsonVtSourceOptions,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (!this.post({ type: "begin", layerId, generation, options })) return;
    const { features } = geojson;
    for (let start = 0; start < features.length; start += TILE_WORKER_CHUNK_FEATURES) {
      const chunk = features.slice(start, start + TILE_WORKER_CHUNK_FEATURES);
      if (!this.post({ type: "features", layerId, generation, features: chunk })) return;
      // Each post serializes its chunk on this thread; yield so the copy is
      // many short tasks rather than one long one.
      await yieldToEventLoop();
      if (!isCurrent()) return;
    }
    this.post({ type: "build", layerId, generation });
  }

  /**
   * Ask the worker for one encoded tile.
   *
   * @returns The tile's bytes (empty when the tile holds nothing or the request
   *   was aborted), or `null` when the worker has failed.
   */
  requestTile(
    layerId: string,
    z: number,
    x: number,
    y: number,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer | null> {
    if (this.failed) return Promise.resolve(null);
    const requestId = this.nextRequestId++;
    return new Promise((resolve) => {
      const onAbort = () => {
        if (!this.pending.delete(requestId)) return;
        this.post({ type: "cancel", requestId });
        resolve(new ArrayBuffer(0));
      };
      this.pending.set(requestId, (data) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(data);
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.post({ type: "tile", requestId, layerId, z, x, y });
    });
  }

  /** Drop a layer's index in the worker. */
  drop(layerId: string): void {
    this.post({ type: "drop", layerId });
  }

  /** Stop the worker. Pending requests resolve `null` (tile inline). */
  terminate(): void {
    this.fail(false);
  }
}

/** Creates the tiling worker, or returns null where workers cannot run. */
export type GeoJsonVtWorkerFactory = () => Worker | null;

let workerFactory: GeoJsonVtWorkerFactory | null = null;
let tileWorker: TileWorkerHost | null = null;
/** Set once a worker could not be used; later layers tile inline. */
let tileWorkerUnavailable = false;
let buildGeneration = 0;

/**
 * Install how the tiling worker is created. Until a factory is installed,
 * layers tile on the main thread. The app installs one from
 * geojson-vt-worker-factory.ts (imported by this package's app entry); the
 * published headless build has no worker file to point at, so it never does.
 *
 * @param factory Creates the worker, or null to tile inline from now on.
 */
export function setGeoJsonVtWorkerFactory(factory: GeoJsonVtWorkerFactory | null): void {
  workerFactory = factory;
}

/** The tiling worker, spawned on first use; null where workers cannot run. */
function getTileWorker(): TileWorkerHost | null {
  if (tileWorker) return tileWorker;
  if (tileWorkerUnavailable || !workerFactory) return null;
  try {
    const worker = workerFactory();
    if (!worker) return null;
    const host: TileWorkerHost = new TileWorkerHost(worker, () => {
      if (tileWorker === host) tileWorker = null;
      tileWorkerUnavailable = true;
    });
    tileWorker = host;
  } catch {
    tileWorkerUnavailable = true;
  }
  return tileWorker;
}

/**
 * Terminate the tiling worker and forget that one ever failed, so the next
 * large layer spawns a fresh one. The registered layers re-tile on this thread
 * until they are re-registered. For teardown and tests.
 */
export function disposeGeoJsonVtWorker(): void {
  tileWorker?.terminate();
  tileWorker = null;
  tileWorkerUnavailable = false;
}

/**
 * Build (or rebuild) the tile index backing a layer's vector source.
 *
 * Rebuilds only when there is no existing index, the underlying GeoJSON object
 * reference changed (the store replaces it on edits), or the clustering
 * configuration changed. The build itself runs on the tiling worker where
 * there is one: this returns at once, and tile requests for the layer wait
 * until the worker has the new data.
 *
 * @param layerId - The owning layer's id.
 * @param geojson - The full feature collection to index.
 * @param options - Clustering configuration for point layers.
 * @returns `true` when the index was (re)built, so the caller can refresh the
 *   MapLibre source to evict cached tiles; `false` when reused as-is.
 */
export function registerGeoJsonVtSource(
  layerId: string,
  geojson: GeoJSON.FeatureCollection,
  options: GeoJsonVtSourceOptions,
): boolean {
  const existing = registry.get(layerId);
  const unchanged =
    existing !== undefined &&
    existing.geojsonRef === geojson &&
    existing.cluster === options.cluster &&
    existing.clusterRadius === options.clusterRadius &&
    existing.clusterMaxZoom === options.clusterMaxZoom;
  if (unchanged) return false;

  const worker = getTileWorker();
  if (!worker) {
    registry.set(layerId, {
      geojsonRef: geojson,
      ...options,
      index: buildTileIndex(geojson, options),
      posted: null,
    });
    return true;
  }
  const entry: RegistryEntry = { geojsonRef: geojson, ...options, index: null, posted: null };
  registry.set(layerId, entry);
  const generation = ++buildGeneration;
  entry.posted = worker.build(
    layerId,
    generation,
    geojson,
    {
      cluster: options.cluster,
      clusterRadius: options.clusterRadius,
      clusterMaxZoom: options.clusterMaxZoom,
    },
    () => registry.get(layerId) === entry,
  );
  return true;
}

/** Drop a layer's tile index. Safe to call when none is registered. */
export function unregisterGeoJsonVtSource(layerId: string): void {
  if (!registry.delete(layerId)) return;
  if (!tileWorker) return;
  if (registry.size === 0) {
    // Nothing left to tile: free the worker and the copies it holds.
    const host = tileWorker;
    tileWorker = null;
    host.terminate();
  } else {
    tileWorker.drop(layerId);
  }
}

/** Whether a tile index is currently registered for this layer. */
export function hasGeoJsonVtSource(layerId: string): boolean {
  return registry.has(layerId);
}

/** The `tiles` template for a layer's vector source. */
export function geojsonVtTileUrl(layerId: string): string {
  return `${GEOJSONVT_PROTOCOL}://${encodeURIComponent(layerId)}/{z}/{x}/{y}`;
}

/**
 * Register the custom protocol once. Re-registers after `setStyle()` clears
 * MapLibre's protocol table, detected via its live `REGISTERED_PROTOCOLS`
 * (mirrors the pmtiles protocol handling in `layer-sync.ts`).
 */
export function ensureGeoJsonVtProtocol(): void {
  const registered = (config as { REGISTERED_PROTOCOLS?: Record<string, unknown> })
    .REGISTERED_PROTOCOLS?.[GEOJSONVT_PROTOCOL];
  if (registered) return;
  addProtocol(GEOJSONVT_PROTOCOL, geojsonVtProtocolHandler);
}

async function geojsonVtProtocolHandler(
  params: RequestParameters,
  abortController?: AbortController,
): Promise<{ data: ArrayBuffer }> {
  const empty = { data: new ArrayBuffer(0) };
  const request = parseTileUrl(params.url);
  if (!request) return empty;
  const { layerId, z, x, y } = request;
  const entry = registry.get(layerId);
  if (!entry) return empty;
  const signal = abortController?.signal;

  const worker = tileWorker;
  if (!entry.index && entry.posted && worker) {
    // Wait for the layer's features to reach the worker, so the tile is cut
    // from this build rather than an earlier one.
    await entry.posted;
    if (signal?.aborted) return empty;
    const data = await worker.requestTile(layerId, z, x, y, signal);
    if (data) return { data };
    // The worker failed: tile this layer here from now on.
  }

  // MapLibre cancels tiles scrolled off-screen; skip the CPU-heavy encode when
  // the request was already aborted (the result would be discarded anyway).
  if (signal?.aborted) return empty;
  entry.index ??= buildTileIndex(entry.geojsonRef, entry);
  return { data: encodeTile(entry.index, z, x, y) };
}

// Parse `geolibre-gjvt://<layerId>/<z>/<x>/<y>`, or null when malformed.
function parseTileUrl(url: string): { layerId: string; z: number; x: number; y: number } | null {
  const path = url.slice(`${GEOJSONVT_PROTOCOL}://`.length);
  const slash = path.indexOf("/");
  if (slash < 0) return null;
  let layerId: string;
  try {
    layerId = decodeURIComponent(path.slice(0, slash));
  } catch {
    return null;
  }
  const [z, x, y] = path
    .slice(slash + 1)
    .split("/")
    .map(Number);
  if (!Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { layerId, z, x, y };
}
