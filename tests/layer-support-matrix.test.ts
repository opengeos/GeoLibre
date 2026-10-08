import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_LAYER_STYLE,
  LAYER_TYPES,
  type GeoLibreLayer,
  type MapRendererKind,
} from "@geolibre/core";
import { isArcgisSupportedLayer } from "../packages/map/src/arcgis-layers";
import { CESIUM_CAPABILITIES, CESIUM_PANE_CAPABILITIES } from "../packages/map/src/cesium-engine";
import { isCesiumSupportedLayerType } from "../packages/map/src/cesium-layer-sync";
import {
  classifyLayer,
  hasLayerKindSupport,
  layerKindSupport,
  type LayerKind,
  type LayerKindSupport,
} from "../packages/map/src/layer-kind";
import { syncLayer } from "../packages/map/src/layer-sync";
import { isMapboxSupportedLayer } from "../packages/map/src/mapbox-layers";
import { rendererCapabilities } from "../packages/map/src/renderer-capabilities";

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
/** A Deck.gl Layer builder config for `layerKind`, mapping an origin-destination row. */
function deckVizConfig(layerKind: string) {
  return {
    layerKind,
    format: "json-array",
    fieldMapping: { lng: 0, lat: 1, sourceLng: 0, sourceLat: 1, targetLng: 2, targetLat: 3 },
    style: {},
  };
}

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
  "arcgis (vector tile service)": layer(
    "arcgis",
    {
      arcgisSources: {
        parcels: {
          type: "vector",
          tiles: ["https://a.example/VectorTileServer/tile/{z}/{y}/{x}.pbf"],
        },
      },
      arcgisLayers: [
        { id: "parcels-fill", type: "fill", source: "parcels", "source-layer": "parcels" },
      ],
    },
    { metadata: { nativeLayerIds: ["parcels-fill"] } },
  ),
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
  "zarr (Zarr control)": layer(
    "zarr",
    { url: "https://z.example/a.zarr", variable: "t2m" },
    { metadata: { externalNativeLayer: true, sourceKind: "zarr-url" } },
  ),
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
  "cog (raster control)": layer(
    "cog",
    { url: "https://c.example/a.tif" },
    { metadata: { externalNativeLayer: true, sourceKind: "maplibre-gl-raster" } },
  ),
  flatgeobuf: layer("flatgeobuf", { url: "https://f.example/a.fgb" }),
  geoparquet: layer("geoparquet", { url: "https://f.example/a.parquet" }),
  "duckdb-query": layer("duckdb-query", {}, { metadata: { sourceKind: "duckdb-query" } }),
  "duckdb-query (no plugin)": layer("duckdb-query", {}),
  "deckgl-viz": layer("deckgl-viz", {}, { metadata: { sourceKind: "deckgl-viz" } }),
  "deckgl-viz (no plugin)": layer("deckgl-viz", {}),
  "deckgl-viz (arc)": layer(
    "deckgl-viz",
    { data: [[0, 0, 1, 1]] },
    { metadata: { sourceKind: "deckgl-viz", vizConfig: deckVizConfig("arc") } },
  ),
  "deckgl-viz (heatmap)": layer(
    "deckgl-viz",
    { data: [[0, 0]] },
    { metadata: { sourceKind: "deckgl-viz", vizConfig: deckVizConfig("heatmap") } },
  ),
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
  "arcgis (vector tile service)": { maplibre: "sync",   mapbox: true,  arcgis: true,  cesium: true },
  "pmtiles (vector)":             { maplibre: "plugin", mapbox: true,  arcgis: true,  cesium: true },
  "pmtiles (raster)":             { maplibre: "plugin", mapbox: false, arcgis: true,  cesium: true },
  "mbtiles (raster)":             { maplibre: "sync",   mapbox: false, arcgis: true,  cesium: true },
  zarr:                           { maplibre: "plugin", mapbox: false, arcgis: true,  cesium: true },
  "zarr (Zarr control)":          { maplibre: "plugin", mapbox: true,  arcgis: true,  cesium: true },
  "lidar (COPC)":                 { maplibre: "plugin", mapbox: false, arcgis: false, cesium: true },
  "lidar (LiDAR control)":        { maplibre: "plugin", mapbox: true,  arcgis: true,  cesium: false },
  "gaussian-splat (.ply)":        { maplibre: "plugin", mapbox: false, arcgis: false, cesium: false },
  "gaussian-splat (tileset)":     { maplibre: "plugin", mapbox: false, arcgis: false, cesium: true },
  "3d-tiles":                     { maplibre: "plugin", mapbox: false, arcgis: false, cesium: true },
  "3d-tiles (3D Tiles control)":  { maplibre: "plugin", mapbox: true,  arcgis: true,  cesium: true },
  cog:                            { maplibre: "plugin", mapbox: false, arcgis: true,  cesium: true },
  "cog (raster control)":         { maplibre: "plugin", mapbox: true,  arcgis: true,  cesium: true },
  flatgeobuf:                     { maplibre: "plugin", mapbox: false, arcgis: false, cesium: false },
  geoparquet:                     { maplibre: "plugin", mapbox: false, arcgis: false, cesium: false },
  "duckdb-query":                 { maplibre: "plugin", mapbox: true,  arcgis: true,  cesium: false },
  "duckdb-query (no plugin)":     { maplibre: "plugin", mapbox: false, arcgis: false, cesium: false },
  "deckgl-viz":                   { maplibre: "plugin", mapbox: true,  arcgis: true,  cesium: false },
  "deckgl-viz (no plugin)":       { maplibre: "plugin", mapbox: false, arcgis: false, cesium: false },
  "deckgl-viz (arc)":             { maplibre: "plugin", mapbox: true,  arcgis: true,  cesium: true },
  "deckgl-viz (heatmap)":         { maplibre: "plugin", mapbox: true,  arcgis: true,  cesium: false },
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
    const kinds = (types: GeoLibreLayer["type"][]): (LayerKind | undefined)[] =>
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

/**
 * Whether a plugin control owns the record (it carries the plugin's metadata).
 * MapLibre's layer-sync also hands a record whose plugin registered native
 * layer ids to its external-native path before the kind dispatch, so on
 * MapLibre those ids alone mark it plugin-owned.
 */
function isPluginOwned(record: GeoLibreLayer, engine?: keyof Row): boolean {
  const { externalNativeLayer, sourceKind, nativeLayerIds } = record.metadata;
  return (
    externalNativeLayer === true ||
    typeof sourceKind === "string" ||
    (engine === "maplibre" && Array.isArray(nativeLayerIds) && nativeLayerIds.length > 0)
  );
}

/**
 * The support each fixture of a kind shows on one engine, as the per-kind
 * verdict it implies: `"native"` when a record without plugin metadata draws,
 * `"plugin"` when only plugin-owned records draw, `"unsupported"` when none
 * does. On MapLibre "draws" means layer-sync adds a source and render layer
 * itself; plugin controls are not modeled, so a kind it leaves to them reads
 * `"plugin"` without a drawn fixture.
 */
function observedKindSupport(
  engine: keyof Row,
  kind: LayerKind,
): { support: LayerKindSupport; fixtures: string[] } {
  const fixtures = Object.keys(FIXTURES).filter((name) => classifyLayer(FIXTURES[name]) === kind);
  const draws = (name: string): boolean => {
    const value = MATRIX[name][engine];
    return value === true || value === "sync";
  };
  const plain = fixtures.filter((name) => !isPluginOwned(FIXTURES[name], engine));
  let support: LayerKindSupport;
  if (plain.some(draws)) support = "native";
  else if (engine === "maplibre" || fixtures.some(draws)) support = "plugin";
  else support = "unsupported";
  return { support, fixtures };
}

describe("supported layer kinds", () => {
  const ENGINES: Record<keyof Row, MapRendererKind> = {
    maplibre: "maplibre",
    mapbox: "mapbox",
    arcgis: "arcgis",
    cesium: "cesium",
  };
  const KINDS = [...new Set(LAYER_TYPES.map((type) => classifyLayer({ type })))].filter(
    (kind): kind is LayerKind => kind !== undefined,
  );

  it("every kind has a fixture without plugin metadata", () => {
    for (const kind of KINDS) {
      assert.ok(
        Object.values(FIXTURES).some(
          (record) => classifyLayer(record) === kind && !isPluginOwned(record),
        ),
        kind,
      );
    }
  });

  for (const [engine, renderer] of Object.entries(ENGINES) as [keyof Row, MapRendererKind][]) {
    it(`${renderer}'s table matches what its dispatch draws`, () => {
      // The fixtures above run through each engine's real dispatch (MATRIX is
      // pinned to it), so a table entry that disagrees with them has drifted.
      const table = rendererCapabilities(renderer).supportedLayerKinds;
      for (const kind of KINDS) {
        const { support, fixtures } = observedKindSupport(engine, kind);
        assert.equal(table[kind], support, `${kind} (${fixtures.join(", ")})`);
      }
    });
  }

  it("every capability object of an engine carries its table", () => {
    assert.equal(
      CESIUM_PANE_CAPABILITIES.supportedLayerKinds,
      CESIUM_CAPABILITIES.supportedLayerKinds,
    );
    assert.equal(
      rendererCapabilities("arcgis", "globe").supportedLayerKinds,
      rendererCapabilities("arcgis", "mercator").supportedLayerKinds,
    );
  });

  it("treats an unknown type as unsupported", () => {
    for (const renderer of Object.values(ENGINES)) {
      const table = rendererCapabilities(renderer).supportedLayerKinds;
      assert.equal(layerKindSupport(table, undefined), "unsupported", renderer);
      assert.equal(hasLayerKindSupport(table, undefined, "unsupported"), true, renderer);
      assert.equal(hasLayerKindSupport(table, undefined, "native"), false, renderer);
    }
  });
});
