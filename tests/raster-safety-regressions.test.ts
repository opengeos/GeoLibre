import assert from "node:assert/strict";
import { it } from "node:test";
import {
  bandDifference,
  clipRasterByMask,
  contourRaster,
  interpolatePoints,
  mosaicRasters,
  readRasterData,
  reprojectRaster,
  resampleRaster,
  sarDbConvert,
  writeRasterData,
  zonalStatistics,
  SAR_NODATA,
  runRasterToolClientAsync,
  speckleFilter,
  type RasterData,
} from "@geolibre/processing";
import { rasterEpsg } from "../packages/processing/src/raster-geo";
import { geojsonEpsg } from "../packages/processing/src/raster-geo";
import { writeArrayBuffer } from "geotiff";

it("rejects explicit unsupported zone CRSs and malformed interpolation positions", async () => {
  assert.equal(geojsonEpsg({}), 4326);
  assert.equal(
    geojsonEpsg({ crs: { properties: { name: "urn:ogc:def:crs:OGC:1.3:CRS84" } } }),
    4326,
  );
  assert.throws(
    () =>
      geojsonEpsg({
        crs: { properties: { name: "+proj=utm +zone=17 +datum=WGS84 +units=m +no_defs" } },
      }),
    /sidecar/,
  );
  await assert.rejects(
    interpolatePoints(
      {
        type: "FeatureCollection",
        features: [
          [0, 0],
          [1, 1],
          [null, 0],
        ].map((coordinates) => ({
          type: "Feature",
          properties: { z: 1 },
          geometry: { type: "Point", coordinates },
        })),
      },
      { field: "z", resolution: 1 },
    ),
    /at least 3/,
  );
});

it("decodes decimal Float32 NoData exactly and retains nearby valid samples", async () => {
  const bytes = writeArrayBuffer(Float32Array.of(-9999.1, -9999.05), {
    width: 2,
    height: 1,
    GDAL_NODATA: "-9999.1",
    ModelPixelScale: [1, 1, 0],
    ModelTiepoint: [0, 0, 0, 0, 1, 0],
    GeographicTypeGeoKey: 4326,
    GTModelTypeGeoKey: 2,
  });
  const decoded = await readRasterData(bytes);
  assert.equal(decoded.nodata, Math.fround(-9999.1));
  assert.equal(decoded.bands[0][0], decoded.nodata);
  assert.notEqual(decoded.bands[0][1], decoded.nodata);
  const output = await zonalStatistics(
    decoded,
    {
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
                [2, 0],
                [2, 1],
                [0, 1],
                [0, 0],
              ],
            ],
          },
        },
      ],
    },
    {},
  );
  assert.equal(output.geojson.features[0].properties?.count, 1);
});

it("preserves PixelIsPoint centers through encoding and a same-CRS warp", async () => {
  const bytes = writeArrayBuffer(Float32Array.of(1, 2, 3, 4), {
    width: 2,
    height: 2,
    ModelPixelScale: [1, 1, 0],
    ModelTiepoint: [0, 0, 0, 10, 20, 0],
    GeographicTypeGeoKey: 4326,
    GTModelTypeGeoKey: 2,
    GTRasterTypeGeoKey: 2,
  });
  const decoded = await readRasterData(bytes);
  assert.equal(decoded.originX, 9.5);
  assert.equal(decoded.originY, 20.5);
  const roundtrip = await readRasterData(writeRasterData(decoded));
  assert.equal(roundtrip.originX, decoded.originX);
  assert.equal(roundtrip.originY, decoded.originY);
  const warped = await reprojectRaster(decoded, { dst_crs: "EPSG:4326", resampling: "nearest" });
  assert.equal(warped.originX + warped.resX / 2, 10);
  assert.equal(warped.originY - warped.resY / 2, 20);
});

it("budgets long warp rows, skips zero-weight NaN taps, and snaps mosaic extents", () => {
  assert.throws(
    () =>
      resampleRaster({ ...raster([]), width: 16_000_000, height: 1, resX: 4 }, { resolution: 1 }),
    /too large/,
  );
  const sampled = resampleRaster(raster([1, NaN, 3, 4], 2, 2), {
    resolution: 1,
    resampling: "bilinear",
  });
  assert.equal(sampled.bands[0][0], 1);
  const merged = mosaicRasters(
    [raster([1]), { ...raster([2]), originX: 1 + 1 / 2048 }],
    "first",
  ).raster;
  assert.equal(merged.width, 2);
  assert.deepEqual([...merged.bands[0]], [1, 2]);
});

it("keeps unreferenced vectors downloadable and exports custom projected vectors as WGS84", async () => {
  const input = raster([1, 1, 1, 1], 2, 2);
  const unreferenced = await runRasterToolClientAsync(
    "polygonize",
    { raster: { ...input, geoKeys: {} } },
    {},
  );
  assert.equal(unreferenced.kind, "vector");
  if (unreferenced.kind !== "vector") return;
  assert.equal(unreferenced.wgs84, null);
  assert.ok("crs" in unreferenced.geojson);
  assert.equal(unreferenced.geojson.crs, null);
  const projected = await runRasterToolClientAsync(
    "polygonize",
    {
      raster: {
        ...input,
        originX: 500000,
        originY: 4100000,
        resX: 10,
        resY: 10,
        geoKeys: {
          GTModelTypeGeoKey: 1,
          ProjectedCSTypeGeoKey: 32767,
          GeographicTypeGeoKey: 4326,
          ProjCoordTransGeoKey: 1,
          ProjNatOriginLatGeoKey: 0,
          ProjNatOriginLongGeoKey: -81,
          ProjScaleAtNatOriginGeoKey: 0.9996,
          ProjFalseEastingGeoKey: 500000,
          ProjFalseNorthingGeoKey: 0,
          ProjLinearUnitsGeoKey: 9001,
        },
      },
    },
    {},
  );
  assert.equal(projected.kind, "vector");
  if (projected.kind !== "vector") return;
  assert.ok(projected.wgs84);
  assert.deepEqual(projected.geojson, projected.wgs84);
  const geometry = projected.geojson.features[0].geometry;
  assert.equal(geometry?.type, "Polygon");
  if (geometry?.type === "Polygon") {
    assert.ok(Math.abs(geometry.coordinates[0][0][0] + 81) < 0.01);
    assert.ok(geometry.coordinates[0][0][1] > 36 && geometry.coordinates[0][0][1] < 38);
  }
});

it("includes point cells on integer pixel edges", async () => {
  const input = raster([1, 2, 3, 4], 2, 2);
  const clipped = await clipRasterByMask(
    input,
    {
      type: "MultiPoint",
      coordinates: [
        [0, 2],
        [1, 1],
      ],
    },
    { crop: true },
  );
  assert.equal(clipped.raster.width, 2);
  assert.equal(clipped.raster.height, 2);
  assert.equal(clipped.raster.bands[0][0], 1);
  assert.equal(clipped.raster.bands[0][3], 4);
});

it("rejects multiband speckle work before orienting or allocating bands", () => {
  const input = {
    ...raster([1]),
    width: 1000,
    height: 1000,
    flipY: true,
    bands: Array.from({ length: 100 }, () => new Float32Array(0)),
  };
  assert.throws(() => speckleFilter(input, { method: "refined-lee" }), /limit|large|budget/i);
});

/** A small north-up raster with a declared geographic CRS. */
function raster(values: number[], width = values.length, height = 1): RasterData {
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

it("encodes a valid -9999 change separately from a missing pixel", async () => {
  const before = { ...raster([10000, -123]), nodata: -123 };
  const output = bandDifference(before, raster([1, 4]), {}).raster;
  const decoded = await readRasterData(writeRasterData(output));
  assert.equal(decoded.bands[0][0], -9999);
  assert.ok(Number.isNaN(decoded.bands[0][1]));
  assert.ok(Number.isNaN(decoded.nodata));
});

it("preserves undeclared -9999 samples through clipping, resampling, and mosaics", async () => {
  const input = raster([-9999, 5]);
  const clipped = await clipRasterByMask(
    input,
    { type: "Point", coordinates: [0.5, 1.5] },
    { crop: false },
  );
  assert.equal(clipped.raster.bands[0][0], -9999);
  assert.ok(Number.isNaN(clipped.raster.bands[0][1]));
  const resampled = resampleRaster(input, { resolution: 1, resampling: "nearest" });
  assert.equal(resampled.bands[0][0], -9999);
  assert.ok(Number.isNaN(resampled.nodata));
  const merged = mosaicRasters(
    [
      { ...raster([1]), nodata: -9999 },
      { ...raster([-9999]), originX: 1 },
    ],
    "first",
  ).raster;
  assert.deepEqual([...merged.bands[0]], [1, -9999]);
  assert.ok(Number.isNaN(merged.nodata));
});

it("rejects paired projected rasters with different CRSs", () => {
  const a = { ...raster([1]), geoKeys: { GTModelTypeGeoKey: 1, ProjectedCSTypeGeoKey: 3857 } };
  const b = { ...a, geoKeys: { GTModelTypeGeoKey: 1, ProjectedCSTypeGeoKey: 32617 } };
  assert.throws(() => bandDifference(a, b, {}), /CRS/);
  assert.equal(
    bandDifference(a, { ...a, geoKeys: { ...a.geoKeys, GTRasterTypeGeoKey: 1 } }, {}).raster
      .bands[0][0],
    0,
  );
});

it("does not confuse a projected CRS with its base geographic EPSG code", async () => {
  const custom = {
    ...raster([1]),
    geoKeys: { GTModelTypeGeoKey: 1, ProjectedCSTypeGeoKey: 32767, GeographicTypeGeoKey: 4326 },
  };
  assert.equal(rasterEpsg(custom), null);
  await assert.rejects(
    reprojectRaster(custom, { dst_crs: "EPSG:4326" }),
    /CRS|sidecar|projection/i,
  );
});

it("masks Float32 overflow in continuous change and dB conversion", () => {
  const changed = bandDifference(raster([-3e38]), raster([3e38]), {}).raster;
  assert.ok(Number.isNaN(changed.bands[0][0]));
  const converted = sarDbConvert(raster([400, 20]), { direction: "to-linear", quantity: "power" });
  assert.equal(converted.bands[0][0], SAR_NODATA);
  assert.ok(Math.abs(converted.bands[0][1] - 100) < 1e-5);
});

it("rejects malformed geometries and unsupported line masks", async () => {
  const input = raster([1, 2, 3, 4], 2, 2);
  await assert.rejects(
    zonalStatistics(
      input,
      {
        type: "FeatureCollection",
        features: [
          { type: "Feature", properties: {}, geometry: { type: "Polygonn", coordinates: [] } },
        ],
      },
      {},
    ),
    /malformed GeoJSON/,
  );
  await assert.rejects(
    clipRasterByMask(
      input,
      {
        type: "LineString",
        coordinates: [
          [0, 0],
          [2, 2],
        ],
      },
      {},
    ),
    /line geometries/,
  );
  const empty = await zonalStatistics(
    input,
    { type: "Feature", properties: {}, geometry: null },
    {},
  );
  assert.equal(empty.geojson.features[0].geometry, null);
  assert.equal(empty.geojson.features[0].properties?.count, 0);
});

it("bounds contour levels and retains sub-micro-unit elevations", () => {
  assert.throws(() => contourRaster(raster([0, 1, 0, 1], 2, 2), { interval: 1e-9 }), /work budget/);
  const output = contourRaster(raster([0, 4e-7, 0, 4e-7], 2, 2), { interval: 1e-7 });
  const levels = new Set(output.geojson.features.map((feature) => feature.properties?.elev));
  assert.ok(levels.has(1e-7));
  assert.ok(levels.has(2e-7));
  assert.ok(levels.has(3e-7));
  const noisy = raster(
    Array.from({ length: 500 * 500 }, (_, i) => ((i % 500) + Math.floor(i / 500)) % 2),
    500,
    500,
  );
  assert.throws(() => contourRaster(noisy, { interval: 1 }), /segment budget/);
});

it("bounds total warp and mosaic allocations and verifies mosaic CRS and resolution", () => {
  const input = { ...raster(new Array(1_000_000).fill(1), 1000, 1000), resX: 8, resY: 8 };
  input.bands = new Array(12).fill(input.bands[0]);
  assert.throws(() => resampleRaster(input, { resolution: 1 }), /too large/);
  assert.throws(
    () =>
      mosaicRasters([raster([1]), { ...raster([2]), originX: 40000, originY: -40000 }], "first"),
    /allocation budget/,
  );
  assert.throws(
    () =>
      mosaicRasters(
        [
          { ...raster([1]), geoKeys: { GTModelTypeGeoKey: 1 } },
          { ...raster([2]), geoKeys: {} },
        ],
        "first",
      ),
    /known EPSG/,
  );
  assert.throws(
    () =>
      mosaicRasters(
        [{ ...raster(new Array(1_000_001).fill(1)) }, { ...raster([2]), resX: 2 }],
        "first",
      ),
    /equal pixel size/,
  );
  const small = raster([1, 2, 3, 4], 2, 2);
  small.bands = new Array(12).fill(small.bands[0]);
  assert.equal(resampleRaster(small, { resolution: 1 }).bands.length, 12);
});

it("keeps degenerate interpolation axes at one cell and normalizes small kriging systems", async () => {
  const points = {
    type: "FeatureCollection",
    features: [0, 1, 2].map((y) => ({
      type: "Feature",
      properties: { z: 7 },
      geometry: { type: "Point", coordinates: [500000, y] },
    })),
    crs: { type: "name", properties: { name: "EPSG:32617" } },
  };
  for (const method of ["idw", "kriging"]) {
    const output = await interpolatePoints(points, {
      method,
      field: "z",
      resolution: 0.2,
      variogram_model: "linear",
    });
    assert.equal(output.raster.width, 1);
    assert.equal(output.raster.height, 10);
    assert.equal(output.raster.bands[0].length, 10);
    for (const value of output.raster.bands[0]) assert.ok(Math.abs(value - 7) < 1e-5);
    const horizontal = {
      ...points,
      features: points.features.map((feature) => ({
        ...feature,
        geometry: { ...feature.geometry, coordinates: [...feature.geometry.coordinates].reverse() },
      })),
    };
    const horizontalOutput = await interpolatePoints(horizontal, {
      method,
      field: "z",
      resolution: 0.2,
      variogram_model: "linear",
    });
    assert.equal(horizontalOutput.raster.width, 10);
    assert.equal(horizontalOutput.raster.height, 1);
    assert.equal(horizontalOutput.raster.bands[0].length, 10);
    for (const value of horizontalOutput.raster.bands[0]) assert.ok(Math.abs(value - 7) < 1e-5);
  }
  for (const feature of points.features) feature.properties.z = 1e39;
  const overflow = await interpolatePoints(points, { method: "idw", field: "z", resolution: 1 });
  assert.ok([...overflow.raster.bands[0]].every(Number.isNaN));
  points.features[1].geometry.coordinates = [...points.features[0].geometry.coordinates];
  await assert.rejects(
    interpolatePoints(points, { method: "kriging", field: "z", resolution: 1 }),
    /singular/,
  );
});

it("keeps the earliest exact linear variogram fit when residuals are near zero", async () => {
  const q = (-46 + Math.sqrt(2668)) / 6;
  const points = {
    type: "FeatureCollection",
    features: [0, 1, q].map((z, x) => ({
      type: "Feature",
      properties: { z },
      geometry: { type: "Point", coordinates: [x, 0] },
    })),
  };
  const result = await interpolatePoints(points, {
    method: "kriging",
    field: "z",
    resolution: 0.5,
    variogram_model: "linear",
  });
  assert.match(result.messages.join("\n"), /range=1\.95,/);
});
