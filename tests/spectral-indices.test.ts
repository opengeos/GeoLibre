import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSpectralIndexExpression,
  getSpectralIndex,
  runRasterToolClient,
  supportsClientRaster,
  SPECTRAL_INDICES,
  type RasterData,
} from "@geolibre/processing";

/** Build a small in-memory raster for tests (top-left origin, 1-unit pixels). */
function makeRaster(
  bands: number[][],
  width = 1,
  height = 1,
  overrides: Partial<RasterData> = {},
): RasterData {
  return {
    bands: bands.map((b) => Float32Array.from(b)),
    width,
    height,
    originX: 0,
    originY: height,
    resX: 1,
    resY: 1,
    nodata: null,
    geoKeys: { GTModelTypeGeoKey: 2, GeographicTypeGeoKey: 4326 },
    ...overrides,
  };
}

describe("spectral index expression builder", () => {
  it("registers the tool as client-capable", () => {
    assert.equal(supportsClientRaster("spectral-index"), true);
  });

  it("builds NDVI from the Sentinel-2 preset (red at stack pos 3, NIR at stack pos 4)", () => {
    const { expression, bands, index } = buildSpectralIndexExpression({
      index: "ndvi",
      sensor: "sentinel2",
    });
    assert.equal(expression, "(A4 - A3) / (A4 + A3)");
    assert.deepEqual(bands, [4, 3]);
    assert.equal(index.id, "ndvi");
  });

  it("builds NDVI from the Landsat 8/9 preset (red B4, NIR B5)", () => {
    const { expression } = buildSpectralIndexExpression({
      index: "ndvi",
      sensor: "landsat89",
    });
    assert.equal(expression, "(A5 - A4) / (A5 + A4)");
  });

  it("orders NDWI as (green - nir)", () => {
    const { expression } = buildSpectralIndexExpression({
      index: "ndwi",
      sensor: "sentinel2",
    });
    assert.equal(expression, "(A2 - A4) / (A2 + A4)");
  });

  it("threads the SAVI soil factor into the formula", () => {
    const { expression } = buildSpectralIndexExpression({
      index: "savi",
      sensor: "sentinel2",
      L: 0.25,
    });
    assert.equal(expression, "((A4 - A3) / (A4 + A3 + 0.25)) * (1 + 0.25)");
  });

  it("applies the reflectance scale to EVI's additive constants", () => {
    const { expression, bands } = buildSpectralIndexExpression({
      index: "evi",
      sensor: "sentinel2",
      scale: 0.0001,
    });
    assert.equal(
      expression,
      "2.5 * (((0.0001 * A4) - (0.0001 * A3)) / " +
        "((0.0001 * A4) + 6 * (0.0001 * A3) - 7.5 * (0.0001 * A1) + 1))",
    );
    assert.deepEqual(bands, [4, 3, 1]);
  });

  it("omits the scale factor when it is 1 (ratio cancels it)", () => {
    const { expression } = buildSpectralIndexExpression({
      index: "ndvi",
      sensor: "sentinel2",
      scale: 1,
    });
    assert.ok(!expression.includes("*"), expression);
  });

  it("resolves bands from manual inputs with the custom sensor", () => {
    const { expression, bands } = buildSpectralIndexExpression({
      index: "ndvi",
      sensor: "custom",
      red: 1,
      nir: 2,
    });
    assert.equal(expression, "(A2 - A1) / (A2 + A1)");
    assert.deepEqual(bands, [2, 1]);
  });

  it("throws when a required band is missing in custom mode", () => {
    assert.throws(
      () => buildSpectralIndexExpression({ index: "ndvi", sensor: "custom", red: 1 }),
      /Band "nir" is required/,
    );
  });

  it("throws when the sensor preset lacks a required band (NAIP + NDMI)", () => {
    // NAIP carries only R/G/B/NIR, so a SWIR-dependent index can't resolve.
    assert.throws(
      () => buildSpectralIndexExpression({ index: "ndmi", sensor: "naip" }),
      /naip preset does not include the "swir1" band/i,
    );
  });

  it("rejects an unknown index id", () => {
    assert.throws(
      () => buildSpectralIndexExpression({ index: "nope", sensor: "sentinel2" }),
      /Unknown spectral index/,
    );
  });

  it("exposes a value range and colormap for every index", () => {
    for (const index of SPECTRAL_INDICES) {
      assert.ok(index.range[0] < index.range[1], index.id);
      assert.ok(index.colormap.length > 0, index.id);
    }
    assert.equal(getSpectralIndex("ndvi")?.name.startsWith("NDVI"), true);
  });
});

describe("spectral index client compute", () => {
  it("computes NDVI over a multiband raster", () => {
    // 4 bands; band 3 = red = 2000, band 4 = nir = 6000 → (6000-2000)/8000 = 0.5
    const raster = makeRaster([[0], [0], [2000], [6000]]);
    const { raster: out, messages } = runRasterToolClient("spectral-index", raster, {
      index: "ndvi",
      sensor: "sentinel2",
    });
    assert.equal(out.bands.length, 1);
    assert.ok(Math.abs(out.bands[0][0] - 0.5) < 1e-6);
    assert.ok(messages.some((m) => m.includes("(A4 - A3)")));
  });

  it("errors when the index needs a band the raster lacks", () => {
    const raster = makeRaster([[1], [2]]); // only 2 bands
    assert.throws(
      () =>
        runRasterToolClient("spectral-index", raster, {
          index: "ndvi",
          sensor: "sentinel2", // needs band 4
        }),
      /only 2 band/,
    );
  });
});
