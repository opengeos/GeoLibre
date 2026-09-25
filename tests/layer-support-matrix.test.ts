import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, LAYER_TYPES, type GeoLibreLayer } from "@geolibre/core";
import { isArcgisSupportedLayer } from "../packages/map/src/arcgis-layers";
import { isCesiumSupportedLayerType } from "../packages/map/src/cesium-layer-sync";
import { classifyLayer, type LayerKind } from "../packages/map/src/layer-kind";
import { syncLayer } from "../packages/map/src/layer-sync";
import { isMapboxSupportedLayer } from "../packages/map/src/mapbox-layers";

// The layer support matrix across the four renderers (opengeos/GeoLibre#2633,
// item 4). Each engine switches on `classifyLayer` exhaustively, so a new
// layer kind cannot compile until every engine handles it; this test pins what
// each engine then decides, so a change to one engine's support shows up here
// as a deliberate edit to the table rather than as silent drift.

const corners = [
  [-90, 31],
  [-89, 31],
  [-89, 30],
  [-90, 30],
];

function layer(
  type: GeoLibreLayer["type"],
  source: GeoLibreLayer["source"],
  extra: Partial<GeoLibreLayer> = {},
): GeoLibreLayer {
  return {
    id: `matrix-${type}`,
    name: type,
    type,
    source,
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    ...extra,
  };
}

const point: GeoLibreLayer["geojson"] = {
  type: "FeatureCollection",
  features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [0, 0] } }],
};

/**
 * One representative store record per case, shaped as its producer writes it.
 * Types whose support depends on the data (a tile archive's tile type, a point
 * cloud's format) get one row per variant.
 */
const FIXTURES: Record<string, GeoLibreLayer> = {
  geojson: layer("geojson", { type: "geojson" }, { geojson: point }),
  raster: layer("raster", { type: "raster", tiles: ["https://t.example/{z}/{x}/{y}.png"] }),
  wms: layer("wms", {
    type: "raster",
    tiles: [
      "https://w.example/wms?service=WMS&request=GetMap&layers=a&bbox={bbox-epsg-3857}&width=256&height=256&srs=EPSG:3857&format=image/png",
    ],
  }),
  wmts: layer("wmts", { type: "raster", tiles: ["https://w.example/wmts/{z}/{y}/{x}.png"] }),
  xyz: layer("xyz", { type: "raster", tiles: ["https://x.example/{z}/{x}/{y}.png"] }),
  "vector-tiles": layer(
    "vector-tiles",
    { type: "vector", tiles: ["https://v.example/{z}/{x}/{y}.pbf"] },
    { metadata: { sourceLayers: ["roads"] } },
  ),
  arcgis: layer("arcgis", {
    type: "raster",
    url: "https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer",
  }),
  "pmtiles (vector)": layer(
    "pmtiles",
    {
      type: "vector",
      url: "https://p.example/a.pmtiles",
      tileType: "vector",
      sourceLayers: ["roads"],
    },
    { metadata: { tileType: "vector" } },
  ),
  "pmtiles (raster)": layer(
    "pmtiles",
    { type: "raster", url: "https://p.example/a.pmtiles" },
    { metadata: { tileType: "raster" } },
  ),
  "mbtiles (raster)": layer(
    "mbtiles",
    { type: "raster", tiles: ["mbtiles://a/{z}/{x}/{y}"] },
    { metadata: { tileType: "raster" } },
  ),
  zarr: layer("zarr", { url: "https://z.example/a.zarr", variable: "t2m" }),
  "lidar (COPC)": layer("lidar", { url: "https://l.example/a.copc.laz" }),
  "lidar (LiDAR control)": layer(
    "lidar",
    { url: "https://l.example/a.laz" },
    { metadata: { externalNativeLayer: true, sourceKind: "lidar-url" } },
  ),
  "gaussian-splat (.ply)": layer("gaussian-splat", { url: "https://s.example/a.ply" }),
  "gaussian-splat (tileset)": layer("gaussian-splat", { url: "https://s.example/tileset.json" }),
  "3d-tiles": layer("3d-tiles", { url: "https://t.example/tileset.json" }),
  "3d-tiles (3D Tiles control)": layer(
    "3d-tiles",
    { url: "https://t.example/tileset.json" },
    { metadata: { externalNativeLayer: true, sourceKind: "3d-tiles-url" } },
  ),
  cog: layer("cog", { url: "https://c.example/a.tif" }),
  flatgeobuf: layer("flatgeobuf", { url: "https://f.example/a.fgb" }),
  geoparquet: layer("geoparquet", { url: "https://f.example/a.parquet" }),
  "duckdb-query": layer("duckdb-query", {}, { metadata: { sourceKind: "duckdb-query" } }),
  "deckgl-viz": layer("deckgl-viz", {}, { metadata: { sourceKind: "deckgl-viz" } }),
  video: layer("video", { type: "video", urls: ["https://m.example/a.mp4"], coordinates: corners }),
  image: layer("image", { type: "image", url: "https://m.example/a.png", coordinates: corners }),
};

/**
 * How MapLibre draws the record: `"sync"` when layer-sync adds a source and a
 * render layer for it from the store record, `"plugin"` when a plugin control draws it (and
 * registers native or deck.gl layers that layer-sync then only mirrors).
 */
type MaplibreSupport = "sync" | "plugin";

interface Row {
  maplibre: MaplibreSupport;
  mapbox: boolean;
  arcgis: boolean;
  cesium: boolean;
}

// prettier-ignore
const MATRIX: Record<string, Row> = {
  //                                 MapLibre           Mapbox         ArcGIS         Cesium
  geojson:                        { maplibre: "sync",   mapbox: true,  arcgis: true,  cesium: true },
  raster:                         { maplibre: "sync",   mapbox: true,  arcgis: true,  cesium: true },
  wms:                            { maplibre: "sync",   mapbox: true,  arcgis: true,  cesium: true },
  wmts:                           { maplibre: "sync",   mapbox: true,  arcgis: true,  cesium: true },
  xyz:                            { maplibre: "sync",   mapbox: true,  arcgis: true,  cesium: true },
  "vector-tiles":                 { maplibre: "sync",   mapbox: true,  arcgis: true,  cesium: true },
  arcgis:                         { maplibre: "plugin", mapbox: false, arcgis: true,  cesium: false },
  "pmtiles (vector)":             { maplibre: "plugin", mapbox: true,  arcgis: true,  cesium: true },
  "pmtiles (raster)":             { maplibre: "plugin", mapbox: false, arcgis: true,  cesium: true },
  "mbtiles (raster)":             { maplibre: "sync",   mapbox: false, arcgis: true,  cesium: true },
  zarr:                           { maplibre: "plugin", mapbox: false, arcgis: true,  cesium: false },
  "lidar (COPC)":                 { maplibre: "plugin", mapbox: false, arcgis: false, cesium: true },
  "lidar (LiDAR control)":        { maplibre: "plugin", mapbox: true,  arcgis: true,  cesium: false },
  "gaussian-splat (.ply)":        { maplibre: "plugin", mapbox: false, arcgis: false, cesium: false },
  "gaussian-splat (tileset)":     { maplibre: "plugin", mapbox: false, arcgis: false, cesium: true },
  "3d-tiles":                     { maplibre: "plugin", mapbox: false, arcgis: false, cesium: true },
  "3d-tiles (3D Tiles control)":  { maplibre: "plugin", mapbox: true,  arcgis: true,  cesium: true },
  cog:                            { maplibre: "plugin", mapbox: false, arcgis: true,  cesium: true },
  flatgeobuf:                     { maplibre: "plugin", mapbox: false, arcgis: false, cesium: false },
  geoparquet:                     { maplibre: "plugin", mapbox: false, arcgis: false, cesium: false },
  "duckdb-query":                 { maplibre: "plugin", mapbox: true,  arcgis: true,  cesium: false },
  "deckgl-viz":                   { maplibre: "plugin", mapbox: true,  arcgis: true,  cesium: false },
  video:                          { maplibre: "sync",   mapbox: true,  arcgis: false, cesium: false },
  image:                          { maplibre: "sync",   mapbox: true,  arcgis: true,  cesium: true },
};

/** Whether MapLibre's layer-sync adds a source and a render layer for the record. */
function maplibreSupport(record: GeoLibreLayer): MaplibreSupport {
  let added = false;
  let addedLayer = false;
  const noop = () => {};
  const map = {
    getStyle: () => ({ layers: [] }),
    getLayer: () => undefined,
    getSource: () => undefined,
    getLayersOrder: () => [],
    setLayoutProperty: noop,
    setPaintProperty: noop,
    setLayerZoomRange: noop,
    setFilter: noop,
    moveLayer: noop,
    removeLayer: noop,
    removeSource: noop,
    hasImage: () => false,
    addImage: noop,
    on: noop,
    off: noop,
    once: noop,
    addLayer: () => {
      addedLayer = true;
    },
    addSource: () => {
      added = true;
    },
  };
  syncLayer(map as never, record);
  return added && addedLayer ? "sync" : "plugin";
}

function actual(record: GeoLibreLayer): Row {
  return {
    maplibre: maplibreSupport(record),
    mapbox: isMapboxSupportedLayer(record),
    arcgis: isArcgisSupportedLayer(record),
    cesium: isCesiumSupportedLayerType(record),
  };
}

describe("classifyLayer", () => {
  it("gives every layer type a kind", () => {
    for (const type of LAYER_TYPES) {
      assert.equal(typeof classifyLayer({ type }), "string", type);
    }
  });

  it("groups the raster tile types, the tile archives and the vector files", () => {
    const kinds = (types: GeoLibreLayer["type"][]): LayerKind[] =>
      types.map((type) => classifyLayer({ type }));
    assert.deepEqual(kinds(["raster", "wms", "wmts", "xyz"]), Array(4).fill("raster-tiles"));
    assert.deepEqual(kinds(["pmtiles", "mbtiles"]), Array(2).fill("tile-archive"));
    assert.deepEqual(kinds(["flatgeobuf", "geoparquet"]), Array(2).fill("vector-file"));
  });

  it("classifies an unknown type as undefined, including Object.prototype names", () => {
    for (const type of ["not-a-layer", "constructor", "toString", "__proto__"]) {
      assert.equal(classifyLayer({ type } as unknown as GeoLibreLayer), undefined, type);
    }
  });
});

describe("layer support matrix", () => {
  it("has a fixture for every layer type", () => {
    const covered = new Set(Object.values(FIXTURES).map((record) => record.type));
    assert.deepEqual(
      LAYER_TYPES.filter((type) => !covered.has(type)),
      [],
    );
    assert.deepEqual(Object.keys(MATRIX).sort(), Object.keys(FIXTURES).sort());
  });

  for (const [name, record] of Object.entries(FIXTURES)) {
    it(`${name} renders where the matrix says`, () => {
      assert.deepEqual(actual(record), MATRIX[name]);
    });
  }

  it("ArcGIS draws deck.gl plugin layers only where the overlay exists", () => {
    for (const name of ["lidar (LiDAR control)", "3d-tiles (3D Tiles control)", "deckgl-viz"]) {
      assert.equal(isArcgisSupportedLayer(FIXTURES[name], false), false, name);
    }
  });
});
