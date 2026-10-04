import assert from "node:assert/strict";
import { it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import { loadedVectorTileFeatures } from "../apps/geolibre-desktop/src/hooks/useVectorTileGeometryBackfill";
import { createPMTilesStoreLayer } from "../packages/map/src/pmtiles-layer";
import { mapboxSourceId } from "../packages/map/src/style-layer-ids";

it("samples the Mapbox PMTiles source for extrusion height fields", () => {
  const layer = createPMTilesStoreLayer({
    id: "buildings",
    name: "Buildings",
    url: "https://example.com/buildings.pmtiles",
    tileType: "vector",
    sourceLayers: ["buildings"],
  });
  const feature = {
    type: "Feature" as const,
    geometry: { type: "Polygon" as const, coordinates: [] },
    properties: { height: 42 },
  };
  const map = {
    querySourceFeatures: (id: string, options?: { sourceLayer?: string }) =>
      id === mapboxSourceId(layer.id) && options?.sourceLayer === "buildings" ? [feature] : [],
  };
  assert.deepEqual(loadedVectorTileFeatures(map, layer, "mapbox"), [feature]);
});

it("retains MapLibre's external archive source and bounds the sample", () => {
  const layer = createPMTilesStoreLayer({
    id: "buildings",
    name: "Buildings",
    url: "https://example.com/buildings.pmtiles",
    tileType: "vector",
    sourceLayers: ["buildings"],
  });
  layer.source.sourceId = "control-owned-archive";
  const feature = {
    type: "Feature" as const,
    geometry: { type: "Polygon" as const, coordinates: [] },
    properties: { height: 42 },
  };
  const map = {
    querySourceFeatures: (id: string) => {
      assert.equal(id, "control-owned-archive");
      return Array.from({ length: 500 }, () => feature);
    },
  };
  assert.equal(loadedVectorTileFeatures(map, layer).length, 400);
});

/** An Overture Maps mirror row, as the plugin records it in the store. */
function overtureBuildingsLayer(): GeoLibreLayer {
  return {
    id: "overture-maps-buildings-building",
    name: "Overture Building",
    type: "vector-tiles",
    source: {
      type: "vector",
      sourceId: "overture-buildings",
      url: "pmtiles://https://example.com/buildings.pmtiles",
    },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      customLayerType: "overture-maps",
      externalNativeLayer: true,
      sourceKind: "overture-maps",
      sourceId: "overture-buildings",
      sourceLayers: ["building"],
      nativeLayerIds: ["overture-buildings-building-fill"],
    },
  };
}

it("samples the Overture control's own source on Mapbox", () => {
  // The Overture Maps control adds `overture-<theme>` to whichever map hosts it,
  // and the Mapbox engine never compiles these mirror rows, so there is no
  // `geolibre-mapbox-<id>` source to read.
  const layer = overtureBuildingsLayer();
  const feature = {
    type: "Feature" as const,
    geometry: { type: "Polygon" as const, coordinates: [] },
    properties: { height: 12 },
  };
  const queried: string[] = [];
  const map = {
    getSource: (id: string) => (id === "overture-buildings" ? {} : undefined),
    querySourceFeatures: (id: string, options?: { sourceLayer?: string }) => {
      queried.push(id);
      return id === "overture-buildings" && options?.sourceLayer === "building" ? [feature] : [];
    },
  };
  assert.deepEqual(loadedVectorTileFeatures(map, layer, "mapbox"), [feature]);
  assert.deepEqual(queried, ["overture-buildings"]);
});

it("keeps the compiled Mapbox source when the named one is not on the map", () => {
  // A tile archive layer names its MapLibre source on the record, but Mapbox
  // compiles it into `geolibre-mapbox-<id>`; nothing adds the named source.
  const layer = createPMTilesStoreLayer({
    id: "buildings",
    name: "Buildings",
    url: "https://example.com/buildings.pmtiles",
    tileType: "vector",
    sourceLayers: ["buildings"],
  });
  layer.source.sourceId = "grid";
  const queried: string[] = [];
  const map = {
    getSource: (id: string) => (id === mapboxSourceId(layer.id) ? {} : undefined),
    querySourceFeatures: (id: string) => {
      queried.push(id);
      return [];
    },
  };
  loadedVectorTileFeatures(map, layer, "mapbox");
  assert.deepEqual(queried, [mapboxSourceId(layer.id)]);
});
