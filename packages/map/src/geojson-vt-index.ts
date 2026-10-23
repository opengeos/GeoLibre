// Tile indexes for the client-side vector tiling of large local vector layers
// (see geojson-vt-protocol.ts), and the worker-side session that holds them.
//
// Building a `GeoJSONVT`/`Supercluster` index over a large layer and encoding
// its low-zoom tiles to MVT are each one uninterrupted task proportional to the
// data: after a 200k-point load, encoding the z0-z3 tiles' properties alone held
// the main thread for ~0.7 s. Both now run on geojson-vt.worker.ts, which keeps
// the indexes and answers tile requests with encoded bytes. This module is the
// code both sides share: the worker runs the session, and the main thread
// builds and encodes through the same functions where there is no worker.

import { GeoJSONVT, Supercluster, type GeoJSONVTTile } from "@maplibre/geojson-vt";
import { fromGeojsonVt } from "@maplibre/vt-pbf";

/**
 * The single source-layer name carried by every generated tile. Render layers
 * created in `layer-sync.ts` reference this via their `source-layer` key.
 */
export const TILE_SOURCE_LAYER = "data";

/** Tile extent shared by the index builders and the MVT encoder. */
const TILE_EXTENT = 4096;

/**
 * Highest zoom the tile index is built for; MapLibre over-zooms beyond it.
 * Exported so the vector source's `maxzoom` in `layer-sync.ts` cannot drift.
 */
export const TILE_MAX_ZOOM = 16;

export interface GeoJsonVtSourceOptions {
  cluster: boolean;
  clusterRadius: number;
  clusterMaxZoom: number;
}

/** A built tile index: `GeoJSONVT`, or `Supercluster` for clustered points. */
export interface TileIndex {
  getTile(z: number, x: number, y: number): GeoJSONVTTile | null;
}

/**
 * Build the tile index for one layer's features.
 *
 * @param geojson The full feature collection to index.
 * @param options Clustering configuration for point layers.
 * @returns The index tiles are cut from.
 */
export function buildTileIndex(
  geojson: GeoJSON.FeatureCollection,
  options: GeoJsonVtSourceOptions,
): TileIndex {
  if (options.cluster) {
    // Supercluster handles points only; non-point features are dropped from a
    // clustered point layer, matching MapLibre's source-level clustering.
    const points = geojson.features.filter(
      (feature) => feature.geometry?.type === "Point",
    ) as Array<GeoJSON.Feature<GeoJSON.Point>>;
    const cluster = new Supercluster({
      radius: options.clusterRadius,
      maxZoom: options.clusterMaxZoom,
      extent: TILE_EXTENT,
      // Match MapLibre's GeoJSON source clustering default so the tiled and
      // inline (native) clustering paths aggregate at the same point count.
      minPoints: 2,
    });
    cluster.load(points);
    return cluster;
  }
  return new GeoJSONVT(geojson, {
    maxZoom: TILE_MAX_ZOOM,
    extent: TILE_EXTENT,
    buffer: 64,
    tolerance: 3,
  });
}

/**
 * Encode one tile of an index to MVT bytes.
 *
 * @param index The layer's tile index.
 * @param z Tile zoom.
 * @param x Tile column.
 * @param y Tile row.
 * @returns The encoded tile, or an empty buffer when the tile holds nothing.
 */
export function encodeTile(index: TileIndex, z: number, x: number, y: number): ArrayBuffer {
  const tile = index.getTile(z, x, y);
  if (!tile) return new ArrayBuffer(0);
  try {
    // vt-pbf bundles an older geojson-vt whose tile type differs nominally from
    // ours; the shapes are runtime-compatible, so cast at the encode boundary.
    // The try-catch guards against that compatibility ever breaking (a future
    // vt-pbf release) — return an empty tile rather than leaving MapLibre with
    // an unhandled rejection that silently blanks the whole layer.
    const pbf = fromGeojsonVt(
      { [TILE_SOURCE_LAYER]: tile } as unknown as Parameters<typeof fromGeojsonVt>[0],
      { version: 2, extent: TILE_EXTENT },
    );
    // Hand MapLibre an exactly-sized ArrayBuffer; `pbf` may be a view into a
    // larger backing buffer.
    return pbf.buffer.slice(pbf.byteOffset, pbf.byteOffset + pbf.byteLength) as ArrayBuffer;
  } catch (err) {
    console.warn("[GeoLibre] geojson-vt tile encode failed", err);
    return new ArrayBuffer(0);
  }
}

/** Features per `features` message when a layer is sent to the worker. */
export const TILE_WORKER_CHUNK_FEATURES = 2_000;

/**
 * Main thread → worker. Indexing a layer is a `begin`, its features in
 * `features` chunks, then `build`; every message carries the layer's
 * generation, so chunks of a superseded build are ignored. Tile requests are
 * answered in arrival order unless a `cancel` for them arrives first.
 */
export type TileWorkerRequest =
  | { type: "begin"; layerId: string; generation: number; options: GeoJsonVtSourceOptions }
  | { type: "features"; layerId: string; generation: number; features: GeoJSON.Feature[] }
  | { type: "build"; layerId: string; generation: number }
  | { type: "drop"; layerId: string }
  | { type: "tile"; requestId: number; layerId: string; z: number; x: number; y: number }
  | { type: "cancel"; requestId: number };

/**
 * Worker → main thread: a tile request's encoded bytes (empty when the tile
 * holds nothing). A worker whose module fails to load reports it through the
 * Worker's `error` event instead, which sends the main thread back to tiling
 * inline.
 */
export type TileWorkerMessage = { type: "tile"; requestId: number; data: ArrayBuffer };

/**
 * Worker-side state: the indexes by layer id, the builds being assembled, and
 * the queue of tile requests.
 *
 * Tile requests are queued and answered one per task rather than straight from
 * the message handler, so a `cancel` for a tile MapLibre no longer wants (the
 * map panned on) is seen before that tile is encoded.
 *
 * @param post Sends one message back, transferring the given buffers.
 * @param schedule Runs a callback on a later task (`setTimeout` in the worker).
 * @returns The handler for each message the main thread posts.
 */
export function createTileIndexSession(
  post: (message: TileWorkerMessage, transfer: Transferable[]) => void,
  schedule: (callback: () => void) => void = (callback) => setTimeout(callback, 0),
): (request: TileWorkerRequest) => void {
  const indexes = new Map<string, TileIndex>();
  const building = new Map<
    string,
    { generation: number; options: GeoJsonVtSourceOptions; features: GeoJSON.Feature[] }
  >();
  const queue = new Map<number, { layerId: string; z: number; x: number; y: number }>();
  let draining = false;

  const answer = (requestId: number, data: ArrayBuffer) => {
    post({ type: "tile", requestId, data }, [data]);
  };

  const drain = () => {
    const next = queue.entries().next();
    if (next.done) {
      draining = false;
      return;
    }
    const [requestId, { layerId, z, x, y }] = next.value;
    queue.delete(requestId);
    const index = indexes.get(layerId);
    answer(requestId, index ? encodeTile(index, z, x, y) : new ArrayBuffer(0));
    schedule(drain);
  };

  return (request) => {
    switch (request.type) {
      case "begin":
        building.set(request.layerId, {
          generation: request.generation,
          options: request.options,
          features: [],
        });
        return;
      case "features": {
        const pending = building.get(request.layerId);
        if (pending?.generation !== request.generation) return;
        for (const feature of request.features) pending.features.push(feature);
        return;
      }
      case "build": {
        const pending = building.get(request.layerId);
        if (pending?.generation !== request.generation) return;
        building.delete(request.layerId);
        try {
          indexes.set(
            request.layerId,
            buildTileIndex(
              { type: "FeatureCollection", features: pending.features },
              pending.options,
            ),
          );
        } catch (err) {
          // A layer that cannot be indexed serves empty tiles rather than
          // stale ones from its previous data.
          indexes.delete(request.layerId);
          console.warn("[GeoLibre] geojson-vt index build failed", err);
        }
        return;
      }
      case "drop":
        indexes.delete(request.layerId);
        building.delete(request.layerId);
        return;
      case "tile":
        queue.set(request.requestId, request);
        if (!draining) {
          draining = true;
          schedule(drain);
        }
        return;
      case "cancel":
        // A queued tile is dropped unanswered: the main thread already settled
        // it when it aborted.
        queue.delete(request.requestId);
        return;
    }
  };
}
