import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { before, describe, it } from "node:test";
import {
  convertVectorWithWasm,
  initConvertTools,
  renderRasterToPmtiles,
} from "../packages/processing/src/wasm-convert";

const fixture = (name: string) =>
  new Uint8Array(
    readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))),
  );

// The same tiny 32x32 Int16 GeoTIFF cog-convert.test.ts uses.
const stripedTiff = fixture("striped.tif");

/**
 * Build a small 3-band 8-bit RGB GeoTIFF in memory, so the band-selection test
 * has a multi-band source without checking another binary fixture into the repo.
 * Each band gets a distinct gradient, so rendering a different band must produce
 * different tiles.
 */
async function makeRgbTiff(): Promise<Uint8Array> {
  const initWasm = (await import("geolibre-wasm")).default;
  const { CogBuilder } = await import("geolibre-wasm");
  await initWasm({
    module_or_path: readFileSync(
      fileURLToPath(
        new URL(
          "../node_modules/geolibre-wasm/geolibre_wasm_bg.wasm",
          import.meta.url,
        ),
      ),
    ),
  });
  const width = 64;
  const height = 64;
  const bands = 3;
  const pixels = new Uint8Array(width * height * bands);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * bands;
      pixels[i] = x * 4;
      pixels[i + 1] = y * 4;
      pixels[i + 2] = 128;
    }
  }
  const builder = new CogBuilder(width, height, bands);
  try {
    builder.set_epsg(4326);
    builder.set_geo_transform(Float64Array.from([-83, 0.01, 0, 40, 0, -0.01]));
    builder.set_tile_size(512);
    builder.set_compression("deflate");
    return builder.write_u8(pixels);
  } finally {
    builder.free();
  }
}

let rgbTiff: Uint8Array;

const pointsGeoJson = new TextEncoder().encode(
  JSON.stringify({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { name: "a", rank: 1 },
        geometry: { type: "Point", coordinates: [-83.0, 40.0] },
      },
      {
        type: "Feature",
        properties: { name: "b", rank: 2 },
        geometry: { type: "Point", coordinates: [-82.5, 40.5] },
      },
    ],
  }),
);

/** Whether `bytes` starts with the given signature. */
function hasMagic(bytes: Uint8Array, magic: number[]): boolean {
  return magic.every((byte, index) => bytes[index] === byte);
}

const FLATGEOBUF_MAGIC = [0x66, 0x67, 0x62, 0x03]; // "fgb" + spec version 3
const PMTILES_MAGIC = [...new TextEncoder().encode("PMTiles")];

describe("wasm-convert", () => {
  before(async () => {
    // In the browser the WASI runner resolves its own bundled asset; under
    // node:test we feed it the wasm bytes directly. A file:// URL is not an
    // option here — initTools fetches what it is given, and node's fetch has no
    // file scheme.
    await initConvertTools(
      readFileSync(
        fileURLToPath(
          new URL(
            "../node_modules/geolibre-wasm/geolibre-cli.wasm",
            import.meta.url,
          ),
        ),
      ),
    );
    rgbTiff = await makeRgbTiff();
  });

  describe("convertVectorWithWasm", () => {
    it("writes a FlatGeobuf the browser's JS writers cannot produce", async () => {
      const result = await convertVectorWithWasm(
        { name: "points.geojson", data: pointsGeoJson },
        "points.fgb",
      );
      assert.ok(
        hasMagic(result.data, FLATGEOBUF_MAGIC),
        "output should carry the FlatGeobuf magic bytes",
      );
      assert.ok(result.data.byteLength > 0);
      assert.ok(result.messages.length > 0, "tool log lines should be surfaced");
    });

    it("round-trips back to GeoJSON with the features intact", async () => {
      const fgb = await convertVectorWithWasm(
        { name: "points.geojson", data: pointsGeoJson },
        "points.fgb",
      );
      const back = await convertVectorWithWasm(
        { name: "points.fgb", data: fgb.data },
        "back.geojson",
      );
      const parsed = JSON.parse(new TextDecoder().decode(back.data));
      assert.equal(parsed.features.length, 2);
      assert.deepEqual(
        parsed.features.map((f: { properties: { name: string } }) => f.properties.name),
        ["a", "b"],
      );
    });

    // The driver comes purely from the output extension, which is why the
    // fixed-format Vector to FlatGeobuf tool forces .fgb on the name it passes
    // rather than trusting whatever the user typed.
    it("picks the driver from the output extension, not the input", async () => {
      const result = await convertVectorWithWasm(
        { name: "points.geojson", data: pointsGeoJson },
        "points.gpkg",
      );
      assert.equal(
        new TextDecoder().decode(result.data.subarray(0, 15)),
        "SQLite format 3",
        "a .gpkg output name should yield a GeoPackage",
      );
    });

    // The tools report failures via exit code + a trailing stdout line rather
    // than by throwing, so the wrapper has to turn that into a real Error.
    it("surfaces the tool's own message when the output format is unsupported", async () => {
      await assert.rejects(
        convertVectorWithWasm(
          { name: "points.geojson", data: pointsGeoJson },
          "points.pmtiles",
        ),
        /unsupported output path|unsupported vector format/i,
      );
    });
  });

  describe("renderRasterToPmtiles", () => {
    it("renders a raster into a PMTiles archive", async () => {
      const result = await renderRasterToPmtiles(
        { name: "dem.tif", data: stripedTiff },
        "dem.pmtiles",
        { minZoom: 0, maxZoom: 4, colormap: "terrain", method: "nearest" },
      );
      assert.ok(
        hasMagic(result.data, PMTILES_MAGIC),
        "output should carry the PMTiles magic bytes",
      );
      assert.ok(result.messages.length > 0);
    });

    // Colormap is optional in the dialog: leaving it unset omits the flag so the
    // tool applies its own default, rather than the UI pinning one of its own.
    it("omits optional flags, matching the tool's own defaults", async () => {
      const [omitted, explicit] = await Promise.all([
        renderRasterToPmtiles({ name: "dem.tif", data: stripedTiff }, "a.pmtiles", {
          minZoom: 0,
          maxZoom: 3,
        }),
        renderRasterToPmtiles({ name: "dem.tif", data: stripedTiff }, "b.pmtiles", {
          minZoom: 0,
          maxZoom: 3,
          colormap: "viridis",
          method: "bilinear",
        }),
      ]);
      assert.deepEqual(
        omitted.data,
        explicit.data,
        "omitting colormap/method should equal the tool's documented defaults",
      );
    });

    it("honours an explicit colormap", async () => {
      const [viridis, magma] = await Promise.all([
        renderRasterToPmtiles({ name: "dem.tif", data: stripedTiff }, "v.pmtiles", {
          minZoom: 0,
          maxZoom: 3,
          colormap: "viridis",
        }),
        renderRasterToPmtiles({ name: "dem.tif", data: stripedTiff }, "m.pmtiles", {
          minZoom: 0,
          maxZoom: 3,
          colormap: "magma",
        }),
      ]);
      assert.notDeepEqual(
        viridis.data,
        magma.data,
        "a different colormap should change the rendered tiles",
      );
    });

    // Raster to PMTiles leaves the zoom inputs blank by default so the tool
    // renders a single native zoom for the raster's resolution, instead of the
    // dialog forcing the 0-14 pyramid Vector to PMTiles uses.
    it("renders the native zoom when the range is omitted", async () => {
      const native = await renderRasterToPmtiles(
        { name: "dem.tif", data: stripedTiff },
        "native.pmtiles",
        {},
      );
      assert.ok(hasMagic(native.data, PMTILES_MAGIC));

      const pyramid = await renderRasterToPmtiles(
        { name: "dem.tif", data: stripedTiff },
        "pyramid.pmtiles",
        { minZoom: 0, maxZoom: 14 },
      );
      assert.ok(
        native.data.byteLength < pyramid.data.byteLength,
        `native (${native.data.byteLength}) should be smaller than a forced 0-14 pyramid (${pyramid.data.byteLength})`,
      );
    });

    // The dialog exposes a band selector, so band has to actually reach the tool
    // rather than being pinned to 1.
    it("renders the requested band of a multi-band raster", async () => {
      const [first, second] = await Promise.all([
        renderRasterToPmtiles({ name: "rgb.tif", data: rgbTiff }, "b1.pmtiles", {
          minZoom: 0,
          maxZoom: 3,
          band: 1,
        }),
        renderRasterToPmtiles({ name: "rgb.tif", data: rgbTiff }, "b2.pmtiles", {
          minZoom: 0,
          maxZoom: 3,
          band: 2,
        }),
      ]);
      assert.ok(hasMagic(first.data, PMTILES_MAGIC));
      assert.notDeepEqual(
        first.data,
        second.data,
        "a different band should change the rendered tiles",
      );
    });

    it("rejects a vector input, which write_pmtiles cannot render", async () => {
      await assert.rejects(
        renderRasterToPmtiles(
          { name: "points.geojson", data: pointsGeoJson },
          "points.pmtiles",
        ),
        /unknown raster format/i,
      );
    });
  });
});
