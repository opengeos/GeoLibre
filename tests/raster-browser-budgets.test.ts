import assert from "node:assert/strict";
import { it } from "node:test";
import {
  interpolatePoints,
  polygonizeRaster,
  transitionMatrix,
  zonalStatistics,
  type RasterData,
} from "@geolibre/processing";
import type { FeatureCollection, Polygon } from "geojson";

/** A regular point sample with finite, distinct geographic locations. */
function samples(count: number, columns: number): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: Array.from({ length: count }, (_, i) => ({
      type: "Feature",
      properties: { z: 7 + Math.sin(i) * 0.01 },
      geometry: {
        type: "Point",
        coordinates: [
          (i % columns) / columns,
          Math.floor(i / columns) / Math.ceil(count / columns),
        ],
      },
    })),
  };
}

it("computes an IDW extent above the JavaScript argument-count limit", async () => {
  const result = await interpolatePoints(samples(150000, 500), {
    field: "z",
    method: "idw",
    resolution: 1,
  });
  assert.equal(result.raster.width, 1);
  assert.equal(result.raster.height, 1);
  assert.ok(Math.abs(result.raster.bands[0][0] - 7) < 0.1);
});

it("fits kriging with more pair distances than a JavaScript argument list allows", async () => {
  const result = await interpolatePoints(samples(512, 32), {
    field: "z",
    method: "kriging",
    resolution: 1,
  });
  assert.equal(result.raster.bands[0].length, 1);
  assert.ok(Math.abs(result.raster.bands[0][0] - 7) < 0.1);
});

it("rejects a large point-grid product before interpolation begins", async () => {
  await assert.rejects(
    interpolatePoints(samples(1000, 50), {
      field: "z",
      method: "idw",
      resolution: 0.001,
    }),
    /work budget/,
  );
});

/** A small raster whose cells and zone sums are known exactly. */
function raster(values: number[], width = 2, height = 2): RasterData {
  return {
    width,
    height,
    originX: 0,
    originY: 2,
    resX: 1,
    resY: 1,
    bands: [Float32Array.from(values)],
    nodata: null,
    geoKeys: { GTModelTypeGeoKey: 2, GeographicTypeGeoKey: 4326 },
  };
}

it("clears a reused zonal mask when the next zone has holes", async () => {
  const outer = [
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 2],
    [0, 0],
  ];
  const hole = [
    [0.1, 0.1],
    [0.1, 1.9],
    [0.9, 1.9],
    [0.9, 0.1],
    [0.1, 0.1],
  ];
  const zones: FeatureCollection<Polygon> = {
    type: "FeatureCollection",
    features: [[outer], [outer, hole], [outer]].map((coordinates) => ({
      type: "Feature",
      properties: {},
      geometry: { type: "Polygon", coordinates },
    })),
  };
  const result = await zonalStatistics(raster([1, 2, 3, 4]), zones, { prefix: "z_" });
  assert.deepEqual(
    result.geojson.features.map((feature) => [
      feature.properties?.z_count,
      feature.properties?.z_sum,
    ]),
    [
      [4, 10],
      [2, 6],
      [4, 10],
    ],
  );
});

it("rejects transition codes that Float32 cannot represent exactly", () => {
  const large = raster([1679], 1, 1);
  assert.throws(() => transitionMatrix(large, large, {}), /Float32 integer range/);
  const supported = raster([1677], 1, 1);
  assert.equal(transitionMatrix(supported, supported, {}).raster.bands[0][0], 16771677);
});

it("bounds polygonization before allocating noisy boundary objects", () => {
  const noisy = raster(
    Array.from({ length: 300 * 300 }, (_, i) => ((i % 300) + Math.floor(i / 300)) % 2),
    300,
    300,
  );
  assert.throws(() => polygonizeRaster(noisy, {}), /boundary-edge budget/);
  const uniform = raster(new Array(1000 * 1000).fill(1), 1000, 1000);
  assert.equal(polygonizeRaster(uniform, {}).geojson.features.length, 1);
  assert.throws(
    () => polygonizeRaster({ ...uniform, width: 8_000_001, height: 1 }, {}),
    /limited to 8 million pixels/,
  );
});
