import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { before, describe, it } from "node:test";
import { GeoTiffReader } from "geolibre-wasm";
import {
  COG_WASM_COMPRESSIONS,
  convertGeoTiffToCog,
  convertRasterDataToCog,
  initCogWasm,
  isTiledGeoTiff,
  readGeoTiffInfo,
} from "../packages/processing/src/cog-convert";
import { ensureWhiteboxRasterCog } from "../packages/processing/src/wasm-client";

// A tiny 32x32 Int16 GeoTIFF written striped (not tiled) by rasterio, the kind
// of file desktop GIS tools export and that the raster panel cannot render
// until it is converted to a tiled COG. See opengeos/GeoLibre#789.
const stripedTiff = new Uint8Array(
  readFileSync(fileURLToPath(new URL("./fixtures/striped.tif", import.meta.url))),
);

// In the browser wasm-bindgen fetches the bundled asset; under node:test we feed
// it the wasm bytes directly so the same converter code runs headless.
const wasmBytes = new Uint8Array(
  readFileSync(
    fileURLToPath(new URL("../node_modules/geolibre-wasm/geolibre_wasm_bg.wasm", import.meta.url)),
  ),
);

describe("convertGeoTiffToCog", () => {
  before(async () => {
    await initCogWasm(wasmBytes);
  });

  it("reads header-only metadata and reports the striped source as non-tiled", async () => {
    const info = await readGeoTiffInfo(stripedTiff);
    assert.equal(info.tiled, false);
    assert.equal(info.width, 32);
    assert.equal(info.height, 32);
    assert.equal(info.bands, 1);
    assert.equal(info.epsg, 4326);
    assert.equal(info.nodata, 0);
    assert.equal(await isTiledGeoTiff(stripedTiff), false);
  });

  it("re-encodes a striped GeoTIFF as a tiled COG, preserving georeferencing", async () => {
    const cog = await convertGeoTiffToCog(stripedTiff);
    const out = await readGeoTiffInfo(cog);
    // The whole point: the output is internally tiled, so the panel can stream it.
    assert.equal(out.tiled, true);
    assert.equal(await isTiledGeoTiff(cog), true);
    // Dimensions, band count, CRS, and nodata survive the round-trip.
    assert.equal(out.width, 32);
    assert.equal(out.height, 32);
    assert.equal(out.bands, 1);
    assert.equal(out.epsg, 4326);
    assert.equal(out.nodata, 0);

    // Pixel values survive (the fixture is row-major `(i % 500) - 11`).
    // read_band_f32 is used here to verify the written COG; the converter itself
    // decodes with read_all_f64 so it handles any source dtype.
    const reader = new GeoTiffReader(cog);
    try {
      const band = reader.read_band_f32(0);
      assert.equal(band.length, 32 * 32);
      assert.equal(band[0], -11);
      assert.equal(band[20], 9);
    } finally {
      reader.free();
    }
  });

  it("encodes in-memory Float32 processing results without corrupting sample bytes", async () => {
    const expected = Float32Array.from([0, 250.25, 282.2, 322.89]);
    const cog = await convertRasterDataToCog({
      bands: [expected],
      width: 4,
      height: 1,
      originX: 2.8,
      originY: 47.35,
      resX: 0.001,
      resY: 0.001,
      nodata: -99999,
      geoKeys: { GTModelTypeGeoKey: 2, GeographicTypeGeoKey: 4326 },
    });
    const reader = new GeoTiffReader(cog);
    try {
      assert.deepEqual(Array.from(reader.read_band_f32(0)), Array.from(expected));
      assert.equal(reader.epsg, 4326);
      assert.deepEqual(Array.from(reader.geo_transform()), [2.8, 0.001, 0, 47.35, 0, -0.001]);
    } finally {
      reader.free();
    }
  });

  for (const crsCode of [32767, 32768, 65535]) {
    it(`rejects user-defined or private CRS code ${crsCode}`, async () => {
      await assert.rejects(
        convertRasterDataToCog({
          bands: [Float32Array.from([1])],
          width: 1,
          height: 1,
          originX: 0,
          originY: 1,
          resX: 1,
          resY: 1,
          nodata: null,
          geoKeys: { GTModelTypeGeoKey: 1, ProjectedCSTypeGeoKey: crsCode },
        }),
        new RegExp(`cannot preserve user-defined or private CRS code ${crsCode}`),
      );
    });
  }

  // Raster to COG lets the user pick a codec on the web, so every advertised
  // choice has to survive an Int16 source — webp/jpeg/jpegxl do not (they reject
  // anything but 8-bit samples) and zstd/raw are not implemented at all, which
  // is why COG_WASM_COMPRESSIONS is narrower than the sidecar's rio-cogeo list.
  for (const compression of COG_WASM_COMPRESSIONS) {
    it(`encodes a valid tiled COG with ${compression} compression`, async () => {
      const cog = await convertGeoTiffToCog(stripedTiff, { compression });
      const out = await readGeoTiffInfo(cog);
      assert.equal(out.ok, true);
      assert.equal(out.tiled, true);
      assert.equal(out.width, 32);
      assert.equal(out.height, 32);

      const reader = new GeoTiffReader(cog);
      try {
        assert.equal(reader.read_band_f32(0)[0], -11);
      } finally {
        reader.free();
      }
    });
  }

  it("defaults to deflate, which compresses better than storing raw", async () => {
    const [deflate, none] = await Promise.all([
      convertGeoTiffToCog(stripedTiff),
      convertGeoTiffToCog(stripedTiff, { compression: "none" }),
    ]);
    assert.ok(
      deflate.byteLength < none.byteLength,
      `deflate (${deflate.byteLength}) should be smaller than none (${none.byteLength})`,
    );
  });

  it("normalizes every Whitebox WASM output because tiling alone does not prove COG conformance", async () => {
    assert.equal(await isTiledGeoTiff(stripedTiff), false);
    const converted = await ensureWhiteboxRasterCog(stripedTiff);

    assert.equal(await isTiledGeoTiff(converted), true);
    assert.notEqual(converted, stripedTiff);
    const revalidated = await ensureWhiteboxRasterCog(converted);
    assert.equal(await isTiledGeoTiff(revalidated), true);
    assert.notEqual(revalidated, converted);
  });
});
