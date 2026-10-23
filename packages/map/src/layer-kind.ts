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
 * A type outside `LAYER_TYPES` (a hand-edited project; `parseProject` does
 * not validate `type`) classifies as `undefined`, which every engine's
 * `default` branch rejects.
 */
export function classifyLayer(layer: Pick<GeoLibreLayer, "type">): LayerKind | undefined {
  // Own properties only, so a type like "constructor" or "__proto__" cannot
  // resolve to an Object.prototype member instead of `undefined`.
  return Object.hasOwn(KIND_BY_TYPE, layer.type) ? KIND_BY_TYPE[layer.type] : undefined;
}

/**
 * What an engine's per-kind dispatch does with a {@link LayerKind}:
 *
 * - `"native"`: the engine draws records of this kind from the store record
 *   itself (its layer sync or style compiler has a path for them). A record
 *   can still be rejected for its data (a missing URL, a tile type the engine
 *   cannot read).
 * - `"plugin"`: only a plugin control draws this kind, on the engine's map or
 *   its deck.gl overlay; the engine mirrors the store record onto whatever
 *   the plugin registered.
 * - `"unsupported"`: the engine's kind dispatch draws no record of this kind.
 *
 * The verdict is the kind's alone. Paths that apply whatever the kind — a
 * FeatureCollection on the globe, a CZML or KML document, a plugin's own
 * registered native layers — sit outside it, so the layer panels keep asking
 * each engine's per-record support check rather than this table.
 */
export type LayerKindSupport = "native" | "plugin" | "unsupported";

/**
 * One engine's {@link LayerKindSupport} for every {@link LayerKind}. The mapped
 * type makes a missing kind a compile error, so a new kind cannot ship until
 * every engine declares what it does with it. `tests/layer-support-matrix.test.ts`
 * checks each engine's table against what its dispatch actually draws.
 */
export type SupportedLayerKinds = { readonly [K in LayerKind]: LayerKindSupport };

/** The kinds a {@link SupportedLayerKinds} table gives `S`. */
export type LayerKindsWith<T extends SupportedLayerKinds, S extends LayerKindSupport> = {
  [K in LayerKind]: T[K] extends S ? K : never;
}[LayerKind];

/**
 * The support `table` gives `kind`; an unknown type ({@link classifyLayer}'s
 * `undefined`) is `"unsupported"`.
 *
 * @param table - An engine's supported-kinds table.
 * @param kind - A {@link classifyLayer} result.
 * @returns The kind's support on that engine.
 */
export function layerKindSupport(
  table: SupportedLayerKinds,
  kind: LayerKind | undefined,
): LayerKindSupport {
  return kind === undefined ? "unsupported" : table[kind];
}

/**
 * Whether `table` gives `kind` the support `support`. A type guard, so an
 * engine can settle a whole support class with one lookup and leave an
 * exhaustive `switch` over only the kinds that remain: declare the table
 * `as const satisfies SupportedLayerKinds` so its values stay literal.
 *
 * An unknown type counts as `"unsupported"`, as in {@link layerKindSupport}.
 *
 * @param table - An engine's supported-kinds table, declared `as const`.
 * @param kind - A {@link classifyLayer} result.
 * @param support - The support class to test for.
 * @returns Whether `kind` has that support.
 */
export function hasLayerKindSupport<T extends SupportedLayerKinds, S extends LayerKindSupport>(
  table: T,
  kind: LayerKind | undefined,
  support: S,
): kind is LayerKindsWith<T, S> | (S extends "unsupported" ? undefined : never) {
  return layerKindSupport(table, kind) === support;
}

/**
 * The `default` branch of an exhaustive `switch` over {@link classifyLayer}'s
 * result: once every {@link LayerKind} has a case, only `undefined` (an
 * unknown layer type from untrusted input) is left, so a kind no case handles
 * fails to compile here. At runtime it returns `fallback` rather than
 * throwing, so a bad record degrades to "not drawn" instead of breaking a
 * whole sync pass.
 */
export function unhandledLayerKind<T>(kind: undefined, fallback: T): T {
  void kind;
  return fallback;
}
