import assert from "node:assert/strict";
import { it } from "node:test";
import proj4 from "proj4";
import type { FeatureCollection } from "geojson";
import { overviewProjection, sphericalGeoJSON } from "../packages/map/src/equal-earth-geometry";
import countries from "../packages/map/src/data/equal-earth-countries.json";
// Resolve the same D3 version as the map workspace, not a legacy root transitive copy.
import { createRequire } from "node:module";
const requireMap = createRequire(new URL("../packages/map/package.json", import.meta.url));
const { geoArea, geoPath } = await import(requireMap.resolve("d3-geo"));

it("agrees with independent PROJ Equal Earth coordinates and round-trips pointer positions", () => {
  const projection = overviewProjection(1000, 600, 2, [0, 0]);
  const scale = (512 * 4) / (2 * Math.PI);
  const reference = proj4("EPSG:4326", "+proj=eqearth +R=6371008.8 +units=m");
  for (const coordinate of [
    [0, 0],
    [-74.006, 40.7128],
    [151.2093, -33.8688],
    [179.9, 80],
    [-180, -90],
  ]) {
    const projected = projection(coordinate as [number, number])!;
    const expected = reference.forward(coordinate);
    assert.ok(Math.abs(projected[0] - (500 + (expected[0] / 6371008.8) * scale)) < 1e-6);
    assert.ok(Math.abs(projected[1] - (300 - (expected[1] / 6371008.8) * scale)) < 1e-6);
    const inverse = projection.invert!(projected)!;
    assert.ok(Math.abs(inverse[0] - coordinate[0]) < 1e-6);
    assert.ok(Math.abs(inverse[1] - coordinate[1]) < 1e-6);
  }
});

it("renders all 177 Natural Earth countries as small spherical polygons without mutating data", () => {
  const original = JSON.stringify(countries);
  const normalized = sphericalGeoJSON(countries as FeatureCollection);
  assert.equal(normalized.features.length, 177);
  const path = geoPath(overviewProjection(1000, 600, 1, [0, 0]));
  for (const feature of normalized.features) {
    assert.ok(geoArea(feature) < 2 * Math.PI, feature.properties?.name);
    assert.ok(path(feature));
  }
  assert.equal(JSON.stringify(countries), original);
});

it("clips a dateline crossing line into two paths rather than drawing across the world", () => {
  const path = geoPath(overviewProjection(1000, 600, 1, [0, 0]));
  const result = path({
    type: "LineString",
    coordinates: [
      [170, 20],
      [-170, 20],
    ],
  })!;
  assert.equal(result.split("M").length - 1, 2);
});

it("preserves polygon holes for either source winding", () => {
  const data: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [10, 0],
              [10, 10],
              [0, 10],
              [0, 0],
            ],
            [
              [2, 2],
              [2, 4],
              [4, 4],
              [4, 2],
              [2, 2],
            ],
          ],
        },
      },
    ],
  };
  const normalized = sphericalGeoJSON(data);
  const shell = {
    type: "Polygon",
    coordinates: [(data.features[0].geometry as GeoJSON.Polygon).coordinates[0].slice().reverse()],
  };
  assert.ok(geoArea(normalized) < geoArea(shell));
  assert.ok(geoArea(normalized) > 0);
});
