import assert from "node:assert/strict";
import test from "node:test";

import { isGeoLibreProjectFileName } from "../apps/geolibre-desktop/src/lib/tauri-io";

test("recognizes GeoLibre project files dropped onto the app", () => {
  assert.equal(isGeoLibreProjectFileName("map.geolibre.json"), true);
  assert.equal(isGeoLibreProjectFileName("MAP.GEOLIBRE.JSON"), true);
  assert.equal(isGeoLibreProjectFileName("/maps/map.geolibre.json"), true);
});

test("does not divert ordinary JSON datasets into the project loader", () => {
  assert.equal(isGeoLibreProjectFileName("map.json"), false);
  assert.equal(isGeoLibreProjectFileName("map.geojson"), false);
  assert.equal(isGeoLibreProjectFileName("map.geolibre.json.backup"), false);
});
