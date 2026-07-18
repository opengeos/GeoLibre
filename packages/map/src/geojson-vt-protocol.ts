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

import { addProtocol, config, type RequestParameters } from "maplibre-gl";
import { GeoJSONVT, Supercluster, type GeoJSONVTTile } from "@maplibre/geojson-vt";
import { fromGeojsonVt } from "@maplibre/vt-pbf";

/** Custom protocol scheme handled by {@link ensureGeoJsonVtProtocol}. */
export const GEOJSONVT_PROTOCOL = "geolibre-gjvt";

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

interface TileIndex {
  getTile(z: number, x: number, y: number): GeoJSONVTTile | null;
}

interface RegistryEntry {
  index: TileIndex;
  /** Reference to the geojson last indexed — used to detect data changes. */
  geojsonRef: GeoJSON.FeatureCollection;
  cluster: boolean;
  clusterRadius: number;
  clusterMaxZoom: number;
}

// Keyed by layer id. Module-level rather than on the Zustand record because tile
// indexes are large, non-serializable objects that must not enter app state or
// be written to `.geolibre.json`.
const registry = new Map<string, RegistryEntry>();

export interface GeoJsonVtSourceOptions {
  cluster: boolean;
  clusterRadius: number;
  clusterMaxZoom: number;
}

/**
 * Build (or rebuild) the tile index backing a layer's vector source.
 *
 * Rebuilds only when there is no existing index, the underlying GeoJSON object
 * reference changed (the store replaces it on edits), or the clustering
 * configuration changed.
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

  let index: TileIndex;
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
    index = cluster;
  } else {
    index = new GeoJSONVT(geojson, {
      maxZoom: TILE_MAX_ZOOM,
      extent: TILE_EXTENT,
      buffer: 64,
      tolerance: 3,
    });
  }

  registry.set(layerId, { index, geojsonRef: geojson, ...options });
  return true;
}

/** Drop a layer's tile index. Safe to call when none is registered. */
export function unregisterGeoJsonVtSource(layerId: string): void {
  registry.delete(layerId);
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
  const tile = lookupTile(params.url);
  if (!tile) return { data: new ArrayBuffer(0) };
  // MapLibre cancels tiles scrolled off-screen; skip the CPU-heavy encode when
  // the request was already aborted (the result would be discarded anyway).
  if (abortController?.signal.aborted) return { data: new ArrayBuffer(0) };
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
    return {
      data: pbf.buffer.slice(pbf.byteOffset, pbf.byteOffset + pbf.byteLength) as ArrayBuffer,
    };
  } catch (err) {
    console.warn("[GeoLibre] geojson-vt tile encode failed", err);
    return { data: new ArrayBuffer(0) };
  }
}

// Parse `geolibre-gjvt://<layerId>/<z>/<x>/<y>` and return the encoded tile, or
// null when the layer is unknown or the tile is empty/out of range.
function lookupTile(url: string): GeoJSONVTTile | null {
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
  const entry = registry.get(layerId);
  if (!entry || !Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  return entry.index.getTile(z, x, y);
}
