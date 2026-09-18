import assert from "node:assert/strict";
import { it } from "node:test";
import { loadedVectorTileFeatures } from "../apps/geolibre-desktop/src/hooks/useVectorTileGeometryBackfill";
import { createPMTilesStoreLayer } from "../packages/map/src/pmtiles-layer";
import { mapboxSourceId } from "../packages/map/src/style-layer-ids";

it("samples the Mapbox PMTiles source for extrusion height fields", () => {
  const layer = createPMTilesStoreLayer({
    id: "buildings",
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
