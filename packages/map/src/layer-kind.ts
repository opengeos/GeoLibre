import type { GeoLibreLayer, LayerType } from "@geolibre/core";

// The one place a store layer's `type` is mapped onto the rendering kind the
// four engines dispatch on (MapLibre's layer-sync, the Mapbox and ArcGIS
// compilers, the Cesium globe). Each engine switches on `classifyLayer` with an
// exhaustive `switch`, so adding a layer type to `LAYER_TYPES` in
// @geolibre/core is a compile error here until it is given a kind, and adding
// a kind is a compile error in every engine until each decides how (or
// whether) it draws it.

/**
 * The rendering kind of a store layer. Types every engine treats alike share
 * a kind (the four raster tile types, the two tile archives, the two
 * file-backed vector formats); every other type is its own kind, named after
 * the type.
 */
export type LayerKind =
  | "geojson"
  /** `raster`, `wms`, `wmts` and `xyz`: a raster tile template or TileJSON URL. */
  | "raster-tiles"
  | "vector-tiles"
  | "arcgis"
  /** `pmtiles` and `mbtiles`: a raster or vector tile archive. */
  | "tile-archive"
  | "zarr"
  | "lidar"
  | "gaussian-splat"
  | "3d-tiles"
  | "cog"
  /** `flatgeobuf` and `geoparquet`: vector files a plugin control reads. */
  | "vector-file"
  | "duckdb-query"
  | "deckgl-viz"
  | "video"
  | "image";

/** Every layer type's kind. The mapped type makes a missing type a compile error. */
const KIND_BY_TYPE: { readonly [T in LayerType]: LayerKind } = {
  geojson: "geojson",
  raster: "raster-tiles",
  wms: "raster-tiles",
  wmts: "raster-tiles",
  xyz: "raster-tiles",
  "vector-tiles": "vector-tiles",
  arcgis: "arcgis",
  pmtiles: "tile-archive",
  mbtiles: "tile-archive",
  zarr: "zarr",
  lidar: "lidar",
  "gaussian-splat": "gaussian-splat",
  "3d-tiles": "3d-tiles",
  cog: "cog",
  flatgeobuf: "vector-file",
  geoparquet: "vector-file",
  "duckdb-query": "duckdb-query",
  "deckgl-viz": "deckgl-viz",
  video: "video",
  image: "image",
};

/**
 * The rendering kind of a store layer, from its `type` alone. Whether an
 * engine can draw a particular record still depends on its data (a source
 * URL, a FeatureCollection, a plugin's metadata); each engine's support check
 * switches on this kind and then reads what it needs.
 *
 * A type outside `LAYER_TYPES` (a hand-edited project) classifies as
 * `undefined` at runtime, which every engine's `default` branch rejects.
 */
export function classifyLayer(layer: Pick<GeoLibreLayer, "type">): LayerKind {
  // Own properties only, so a type like "constructor" or "__proto__" cannot
  // resolve to an Object.prototype member instead of `undefined`.
  return (
    Object.hasOwn(KIND_BY_TYPE, layer.type) ? KIND_BY_TYPE[layer.type] : undefined
  ) as LayerKind;
}

/**
 * The `default` branch of an exhaustive `switch` over {@link LayerKind}: a
 * kind no case handles fails to compile here. At runtime (an unknown layer
 * type from untrusted input) it returns `fallback` rather than throwing, so a
 * bad record degrades to "not drawn" instead of breaking a whole sync pass.
 */
export function unhandledLayerKind<T>(kind: never, fallback: T): T {
  void kind;
  return fallback;
}
