import type { SupportedLayerKinds } from "./layer-kind";

/**
 * What MapLibre's layer sync (`syncLayer` in layer-sync.ts) does with each
 * layer kind: the `"native"` kinds get a source and render layers from the
 * store record (a tile archive only as MBTiles; PMTiles is its plugin
 * control's), and the `"plugin"` kinds are drawn by a plugin control (the
 * ArcGIS, Zarr, LiDAR, splat, 3D Tiles, COG, vector-file, DuckDB and deck.gl
 * controls) that registers its own native or deck.gl layers, which the sync
 * then only mirrors. MapLibre is the engine every plugin targets, so no kind is
 * `"unsupported"`.
 *
 * Its own module, not layer-sync.ts, so the capability object in map-engine.ts
 * can carry it without pulling the whole sync into every engine's imports.
 */
export const MAPLIBRE_SUPPORTED_LAYER_KINDS = Object.freeze({
  geojson: "native",
  "raster-tiles": "native",
  "vector-tiles": "native",
  arcgis: "plugin",
  "tile-archive": "native",
  zarr: "plugin",
  lidar: "plugin",
  "gaussian-splat": "plugin",
  "3d-tiles": "plugin",
  cog: "plugin",
  "vector-file": "plugin",
  "duckdb-query": "plugin",
  "deckgl-viz": "plugin",
  video: "native",
  image: "native",
} as const satisfies SupportedLayerKinds);
