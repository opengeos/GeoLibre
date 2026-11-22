import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_LAYER_STYLE,
  DEFAULT_PROJECT_PREFERENCES,
  DEFAULT_STORY_MAP,
  PLUGIN_STATE_IDS,
  PROJECT_VERSION,
  PUBLISHABLE_PLUGIN_SETTINGS,
  VECTOR_COLOR_RAMPS,
} from "../packages/core/src/index.ts";
import { detectGeometryProfile } from "../packages/map/src/geojson-loader.ts";
import { prepareKmlFeatureIcons } from "../packages/map/src/markers.ts";

const ROOT = path.resolve(import.meta.dirname, "..");

test("project-constants.json stays byte-for-byte identical between @geolibre/core and Python", () => {
  const corePath = path.join(ROOT, "packages/core/src/project-constants.json");
  const pyPath = path.join(ROOT, "python/src/geolibre/project-constants.json");
  const coreRaw = fs.readFileSync(corePath, "utf8");
  const pyRaw = fs.readFileSync(pyPath, "utf8");
  assert.equal(pyRaw, coreRaw);

  const parsed = JSON.parse(coreRaw);
  assert.equal(PROJECT_VERSION, parsed.PROJECT_VERSION);
  assert.equal(PROJECT_VERSION, "0.2.0");
  assert.deepEqual(DEFAULT_LAYER_STYLE, parsed.DEFAULT_LAYER_STYLE);
  assert.deepEqual(DEFAULT_PROJECT_PREFERENCES, parsed.DEFAULT_PROJECT_PREFERENCES);
  assert.deepEqual(DEFAULT_STORY_MAP, parsed.DEFAULT_STORY_MAP);
  assert.deepEqual(PUBLISHABLE_PLUGIN_SETTINGS, parsed.PUBLISHABLE_PLUGIN_SETTINGS);
  assert.deepEqual(PLUGIN_STATE_IDS, parsed.PLUGIN_STATE_IDS);
  assert.ok(PLUGIN_STATE_IDS.includes("maplibre-gl-geolens"));
  assert.deepEqual(VECTOR_COLOR_RAMPS, parsed.VECTOR_COLOR_RAMPS);
});

test("detectGeometryProfile memoizes results and returns an isolated copy", () => {
  let geometryReads = 0;
  const pointFeature: GeoJSON.Feature = {
    type: "Feature",
    properties: {},
    get geometry(): GeoJSON.Geometry {
      geometryReads += 1;
      return { type: "Point", coordinates: [0, 0] };
    },
  };
  const fc: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features: [pointFeature],
  };
  const first = detectGeometryProfile(fc);
  assert.deepEqual(first, { hasPoint: true, hasLine: false, hasPolygon: false });
  assert.equal(geometryReads, 1);

  // Mutating the returned object must not corrupt the WeakMap cache.
  first.hasLine = true;
  const second = detectGeometryProfile(fc);
  assert.deepEqual(second, { hasPoint: true, hasLine: false, hasPolygon: false });
  assert.equal(geometryReads, 1, "second call must hit WeakMap cache without rescanning");
});

test("detectGeometryProfile exits early once all three geometry kinds are found", () => {
  let tailReads = 0;
  const tailFeature: GeoJSON.Feature = {
    type: "Feature",
    properties: {},
    get geometry(): GeoJSON.Geometry {
      tailReads += 1;
      return { type: "Point", coordinates: [1, 1] };
    },
  };
  const fc: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [0, 0] } },
      {
        type: "Feature",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        },
      },
      {
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
        },
      },
      tailFeature,
    ],
  };
  const profile = detectGeometryProfile(fc);
  assert.deepEqual(profile, { hasPoint: true, hasLine: true, hasPolygon: true });
  assert.equal(tailReads, 0, "loop should stop once point, line, and polygon are all seen");
});

test("prepareKmlFeatureIcons memoizes empty and non-empty collections", () => {
  let propertyReads = 0;
  const feature: GeoJSON.Feature = {
    type: "Feature",
    geometry: { type: "Point", coordinates: [0, 0] },
    get properties() {
      propertyReads += 1;
      return { name: "plain" };
    },
  };
  const fc: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features: [feature],
  };
  assert.equal(prepareKmlFeatureIcons(fc), null);
  assert.equal(propertyReads, 1);
  assert.equal(prepareKmlFeatureIcons(fc), null);
  assert.equal(propertyReads, 1, "second call should hit WeakMap cache");
});
