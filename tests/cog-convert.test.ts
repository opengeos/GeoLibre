import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { before, describe, it } from "node:test";
import { CogBuilder, GeoTiffReader } from "geolibre-wasm";
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

  it("keeps NoData out of the overviews of a processing result (#3255)", async () => {
    // An NDVI-like result (values in -1..1) with a 3-pixel -9999 NoData border:
    // big enough for overviews, and a border that does not line up with the
    // 2x2 / 4x4 overview blocks, so a block straddles NoData and valid pixels.
    const size = 1100;
    const border = 3;
    const nodata = -9999;
    const band = new Float32Array(size * size);
    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        const edge = row < border || col < border || row >= size - border || col >= size - border;
        band[row * size + col] = edge ? nodata : ((row + col) % 100) / 100 - 0.5;
      }
    }
    const raster = {
      bands: [band],
      width: size,
      height: size,
      originX: 432262.5,
      originY: 4605367.5,
      resX: 15,
      resY: 15,
      nodata,
      geoKeys: { GTModelTypeGeoKey: 1, ProjectedCSTypeGeoKey: 32617 },
    };
    // The default keeps the raster's own sentinel for COGs that feed tools.
    const plain = await readGeoTiffInfo(await convertRasterDataToCog(raster));
    assert.equal(plain.nodata, nodata);

    const cog = await convertRasterDataToCog(raster, { nanNodata: true });

    const { fromArrayBuffer } = await import("geotiff");
    const tiff = await fromArrayBuffer(
      cog.buffer.slice(cog.byteOffset, cog.byteOffset + cog.byteLength) as ArrayBuffer,
    );
    const count = await tiff.getImageCount();
    assert.ok(count > 1, "expected an overview pyramid");
    // Whatever sentinel the COG declares, every pixel is either NoData or a
    // valid value: no blend of the two.
    const declared = (await tiff.getImage(0)).getGDALNoData();
    assert.ok(declared !== null, "the COG declares NoData");
    const isNoData = (value: number) => Number.isNaN(value) || value === declared;

    for (let index = 0; index < count; index += 1) {
      const image = await tiff.getImage(index);
      const [values] = (await image.readRasters()) as unknown as Float32Array[];
      let masked = 0;
      let valid = 0;
      for (const value of values) {
        if (isNoData(value)) {
          masked += 1;
          continue;
        }
        valid += 1;
        // Before the fix the coarsest level held blends such as -9374 and
        // -624, and the renderer's auto stretch read them as data.
        assert.ok(value >= -0.5 && value <= 0.5, `level ${index} holds ${value}`);
      }
      assert.ok(masked > 0, `level ${index} keeps its NoData border`);
      assert.ok(valid > 0, `level ${index} keeps valid data`);
    }
  });

  it("matches a fractional NoData sentinel in Float32 precision under nanNodata", async () => {
    const cog = await convertRasterDataToCog(
      {
        bands: [Float32Array.from([-9999.9, 0.5])],
        width: 2,
        height: 1,
        originX: 0,
        originY: 1,
        resX: 1,
        resY: 1,
        nodata: -9999.9,
        geoKeys: { GTModelTypeGeoKey: 2, GeographicTypeGeoKey: 4326 },
      },
      { nanNodata: true },
    );
    const reader = new GeoTiffReader(cog);
    try {
      const band = reader.read_band_f32(0);
      assert.ok(Number.isNaN(band[0]));
      assert.equal(band[1], 0.5);
    } finally {
      reader.free();
    }
  });

  it("writes non-finite samples as NaN under nanNodata even without declared NoData", async () => {
    const cog = await convertRasterDataToCog(
      {
        bands: [Float32Array.from([0.25, Number.POSITIVE_INFINITY, -0.5, 0.75])],
        width: 4,
        height: 1,
        originX: 0,
        originY: 1,
        resX: 1,
        resY: 1,
        nodata: null,
        geoKeys: { GTModelTypeGeoKey: 2, GeographicTypeGeoKey: 4326 },
      },
      { nanNodata: true },
    );
    const reader = new GeoTiffReader(cog);
    try {
      const band = Array.from(reader.read_band_f32(0));
      assert.deepEqual([band[0], band[2], band[3]], [0.25, -0.5, 0.75]);
      assert.ok(Number.isNaN(band[1]));
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

  it("skips the overview pyramid when asked, for categorical rasters", async () => {
    const { fromArrayBuffer, writeArrayBuffer } = await import("geotiff");
    // 600 x 600 is large enough to get averaged overviews by default.
    const codes = new Uint8Array(600 * 600).map((_, i) => (i % 2 ? 1 : 3));
    const tiff = new Uint8Array(
      writeArrayBuffer(codes, {
        width: 600,
        height: 600,
        ModelPixelScale: [1, 1, 0],
        ModelTiepoint: [0, 0, 0, 500000, 4000000, 0],
        ProjectedCSTypeGeoKey: 32617,
        GTModelTypeGeoKey: 1,
      } as Parameters<typeof writeArrayBuffer>[1]) as ArrayBuffer,
    );
    const imageCount = async (bytes: Uint8Array) =>
      (
        await fromArrayBuffer(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        )
      ).getImageCount();
    assert.ok((await imageCount(await convertGeoTiffToCog(tiff))) > 1);
    const flat = await convertGeoTiffToCog(tiff, { overviews: false });
    assert.equal(await imageCount(flat), 1);
    assert.equal(await isTiledGeoTiff(flat), true);
  });

  it("keeps a user-defined projection that has no EPSG code (#3130)", async () => {
    // South Africa's Lo29 (ESRI:102567): GDAL tags it ProjectedCSType 32767 with
    // the datum's GeographicType 4148, which used to read back as EPSG:4148.
    const lo29 =
      "+proj=tmerc +lat_0=0 +lon_0=29 +k_0=1 +x_0=0 +y_0=0 +a=6378137 +rf=298.257223563 +units=m +no_defs";
    const builder = new CogBuilder(16, 16, 1);
    builder.set_proj_string(lo29);
    builder.set_origin(20000, -2800000, 10);
    builder.set_overview_levels(new Uint32Array());
    const source = builder.write_f32(new Float32Array(16 * 16).fill(1));
    builder.free();
    // CogBuilder writes the datum as user-defined (32767). Retag it as GDAL
    // does, GeographicTypeGeoKey (2048) = 4148, the case that was misread.
    const words = new Uint16Array(source.buffer, source.byteOffset, source.byteLength >> 1);
    const entry = words.findIndex(
      (w, i) => w === 2048 && words[i + 1] === 0 && words[i + 2] === 1 && words[i + 3] === 32767,
    );
    assert.ok(entry >= 0, "GeographicTypeGeoKey entry not found");
    words[entry + 3] = 4148;

    const reader = new GeoTiffReader(await convertGeoTiffToCog(source));
    try {
      assert.equal(reader.epsg, undefined);
      assert.equal(reader.proj_string, lo29);
    } finally {
      reader.free();
    }
  });

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
