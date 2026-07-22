import assert from "node:assert/strict";
import test from "node:test";
import type { GeoLibreLayer } from "../packages/core/src/index";
import {
  getMapEngineDescriptor,
  isMapEngineLayerSupported,
  resolvePrimaryEngineId,
} from "../packages/map/src/engine/registry";

function layer(type: GeoLibreLayer["type"]): GeoLibreLayer {
  return {
    id: type,
    name: type,
    type,
    source: {},
    visible: true,
    opacity: 1,
    style: {},
    metadata: {},
  } as GeoLibreLayer;
}

test("registry metadata describes lazy current-engine capabilities", () => {
  const maplibre = getMapEngineDescriptor("maplibre");
  const cesium = getMapEngineDescriptor("cesium");
  const arcgis = getMapEngineDescriptor("arcgis");
  const arcgisScene = getMapEngineDescriptor("arcgis-scene");

  assert.equal(maplibre.available, true);
  assert.equal(maplibre.capabilities.includes("controls"), true);
  assert.equal(cesium.available, true);
  assert.deepEqual(cesium.capabilities, []);
  assert.equal(arcgis.available, true);
  assert.deepEqual(arcgis.capabilities, [
    "capture",
    "controls",
    "feature-query",
    "interactions",
    "markers",
    "popups",
    "transient-overlays",
  ]);
  assert.equal(arcgisScene.available, true);
  assert.deepEqual(arcgisScene.capabilities, [
    "capture",
    "controls",
    "feature-query",
    "interactions",
    "markers",
    "popups",
    "transient-overlays",
  ]);
  assert.equal(isMapEngineLayerSupported("maplibre", layer("vector-tiles")), true);
  assert.equal(isMapEngineLayerSupported("cesium", layer("geojson")), true);
  assert.equal(isMapEngineLayerSupported("cesium", layer("vector-tiles")), false);
  assert.equal(isMapEngineLayerSupported("arcgis", layer("geojson")), true);
  assert.equal(isMapEngineLayerSupported("arcgis", layer("vector-tiles")), true);
  assert.equal(isMapEngineLayerSupported("arcgis-scene", layer("geojson")), true);
  assert.equal(isMapEngineLayerSupported("arcgis-scene", layer("3d-tiles")), false);
  assert.equal(isMapEngineLayerSupported("arcgis-scene", layer("vector-tiles")), true);
});

test("primary selection keeps MapLibre default while accepting the ArcGIS opt-in", () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message): void => {
    warnings.push(String(message));
  };
  try {
    assert.equal(resolvePrimaryEngineId(""), "maplibre");
    assert.equal(resolvePrimaryEngineId("?engine=maplibre"), "maplibre");
    assert.equal(resolvePrimaryEngineId("?engine=arcgis"), "arcgis");
    assert.equal(resolvePrimaryEngineId("?engine=cesium"), "maplibre");
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
});
