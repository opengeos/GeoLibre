import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, before, beforeEach, describe, it } from "node:test";
import {
  MAX_VECTOR_PMTILES_ZOOM,
  convertVectorWithWasm,
  initConvertTools,
  renderRasterToPmtiles,
  tileVectorToPmtiles,
} from "../packages/processing/src/wasm-convert";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));

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
        new URL("../node_modules/geolibre-wasm/geolibre_wasm_bg.wasm", import.meta.url),
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
        fileURLToPath(new URL("../node_modules/geolibre-wasm/geolibre-cli.wasm", import.meta.url)),
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
        convertVectorWithWasm({ name: "points.geojson", data: pointsGeoJson }, "points.pmtiles"),
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
        renderRasterToPmtiles({ name: "points.geojson", data: pointsGeoJson }, "points.pmtiles"),
        /unknown raster format/i,
      );
    });
  });

  describe("tileVectorToPmtiles", () => {
    it("tiles a vector layer into a PMTiles archive", async () => {
      const result = await tileVectorToPmtiles(
        { name: "points.geojson", data: pointsGeoJson },
        "points.pmtiles",
        { minZoom: 0, maxZoom: 6 },
      );
      assert.ok(
        hasMagic(result.data, PMTILES_MAGIC),
        "output should carry the PMTiles magic bytes",
      );
      assert.ok(result.messages.length > 0, "tool log lines should be surfaced");
    });

    // The dialog sends layerName on both runtimes so a style written against a
    // browser-tiled archive still matches a desktop-tiled one. The name is
    // inside the tiles, so it has to reach the tool rather than be dropped.
    it("names the tile layer", async () => {
      const result = await tileVectorToPmtiles(
        { name: "points.geojson", data: pointsGeoJson },
        "points.pmtiles",
        { minZoom: 0, maxZoom: 4, layerName: "roads" },
      );
      assert.ok(
        result.messages.some((line) => line.includes('"layer_name":"roads"')),
        `the tool should report the requested layer name, got: ${result.messages.join(" | ")}`,
      );
    });

    // A bare .shp has no geometry without its companions, so the dialog passes
    // the .dbf/.shx/.prj the user selected alongside it.
    it("reads a Shapefile from its siblings", async () => {
      // convertVectorWithWasm returns only the single output it was asked for,
      // so the multi-file fixture comes from the raw runner instead.
      const { runTool } = await import("geolibre-wasm/tools");
      const written = await runTool("vector_convert", {
        args: ["--input=/work/points.geojson", "--output=/work/points.shp"],
        input: { "points.geojson": pointsGeoJson },
      });
      const parts = Object.entries(written.files).map(([name, data]) => ({
        name,
        data,
      }));
      assert.ok(
        parts.length > 1,
        `the driver should write sidecars, got: ${parts.map((p) => p.name).join(", ")}`,
      );
      const main = parts.find((part) => part.name === "points.shp");
      assert.ok(main);
      const siblings = parts.filter((part) => part.name !== "points.shp");

      const result = await tileVectorToPmtiles(
        main,
        "points.pmtiles",
        { minZoom: 0, maxZoom: 4 },
        siblings,
      );
      assert.ok(hasMagic(result.data, PMTILES_MAGIC));

      // Without the sidecars the same .shp cannot be read, which is why the
      // dialog forwards the companion files the user selected.
      await assert.rejects(
        tileVectorToPmtiles(main, "alone.pmtiles", { minZoom: 0, maxZoom: 4 }),
        /failed reading input vector|No such file/i,
      );
    });

    // MAX_VECTOR_PMTILES_ZOOM is the cap the dialog validates against before it
    // runs; if the tool's own limit ever moved, that check would be wrong.
    it("accepts the documented maximum zoom and rejects one deeper", async () => {
      const atCap = await tileVectorToPmtiles(
        { name: "points.geojson", data: pointsGeoJson },
        "cap.pmtiles",
        { minZoom: MAX_VECTOR_PMTILES_ZOOM, maxZoom: MAX_VECTOR_PMTILES_ZOOM },
      );
      assert.ok(hasMagic(atCap.data, PMTILES_MAGIC));

      await assert.rejects(
        tileVectorToPmtiles({ name: "points.geojson", data: pointsGeoJson }, "over.pmtiles", {
          maxZoom: MAX_VECTOR_PMTILES_ZOOM + 1,
        }),
        /max_zoom must be <= 18/i,
      );
    });

    it("rejects a raster input, which the vector tiler cannot read", async () => {
      await assert.rejects(
        tileVectorToPmtiles({ name: "dem.tif", data: stripedTiff }, "dem.pmtiles"),
        /vector|unsupported|unknown/i,
      );
    });
  });

  // Every test above runs the tool inline, because node has no global `Worker`
  // and runToolInBackground falls back to the in-process path. In the browser it
  // takes the worker instead, so the message/error wiring that path depends on
  // is only covered here, by standing a fake Worker up in that global.
  // The timeout matters: these tests assert that a promise settles, so a
  // regression that drops a listener would hang forever on node's default
  // (infinite) timeout rather than failing. Every test here settles in under a
  // millisecond, so seconds is a generous ceiling.
  describe("tileVectorToPmtiles on a worker", { timeout: 5_000 }, () => {
    /** The listener/postMessage surface runToolOnWorker actually uses. */
    class FakeWorker {
      static instances: FakeWorker[] = [];
      /** When set, postMessage throws it, standing in for a DataCloneError. */
      static postMessageError: Error | null = null;
      readonly listeners = new Map<string, Array<(event: unknown) => void>>();
      readonly posted: unknown[] = [];
      terminated = false;

      constructor(
        readonly url: URL,
        readonly options: unknown,
      ) {
        FakeWorker.instances.push(this);
      }

      addEventListener(type: string, fn: (event: unknown) => void): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
      }

      postMessage(message: unknown): void {
        if (FakeWorker.postMessageError) throw FakeWorker.postMessageError;
        this.posted.push(message);
      }

      terminate(): void {
        this.terminated = true;
      }

      emit(type: string, event: unknown): void {
        for (const fn of this.listeners.get(type) ?? []) fn(event);
      }
    }

    const hadWorker = "Worker" in globalThis;

    beforeEach(() => {
      FakeWorker.instances = [];
      FakeWorker.postMessageError = null;
      (globalThis as { Worker?: unknown }).Worker = FakeWorker;
    });

    afterEach(() => {
      // Leaving the stub installed would push the inline tests above onto the
      // worker path, where `new URL("./wasm-convert.worker.ts")` cannot load.
      if (!hadWorker) delete (globalThis as { Worker?: unknown }).Worker;
    });

    /**
     * Start a tiling run and hand back the worker it spawned. The worker is
     * constructed synchronously inside runToolOnWorker's promise executor, so it
     * exists before the returned promise is awaited.
     */
    function startRun(options = { minZoom: 0, maxZoom: 4, layerName: "roads" }) {
      const promise = tileVectorToPmtiles(
        { name: "points.geojson", data: pointsGeoJson },
        "points.pmtiles",
        options,
      );
      // Keep the rejection paths from tripping node's unhandled-rejection guard
      // before each test gets to assert on them.
      promise.catch(() => {});
      const worker = FakeWorker.instances[0];
      assert.ok(worker, "a worker should have been spawned");
      return { promise, worker };
    }

    const okResult = {
      exitCode: 0,
      stdout: ["packing PMTiles archive"],
      files: { "points.pmtiles": Uint8Array.from(PMTILES_MAGIC) },
    };

    it("hands the tool, its args and its files to the worker", () => {
      const { worker } = startRun();
      assert.deepEqual(worker.posted, [
        {
          tool: "vector_to_pmtiles",
          args: [
            "--input=/work/points.geojson",
            "--output=/work/points.pmtiles",
            "--min_zoom=0",
            "--max_zoom=4",
            "--layer_name=roads",
          ],
          input: { "points.geojson": pointsGeoJson },
        },
      ]);
    });

    // Vite only bundles the worker when it can statically see this exact shape.
    it("loads the worker as an ES module", () => {
      const { worker } = startRun();
      assert.match(worker.url.href, /wasm-convert\.worker\.ts$/);
      assert.deepEqual(worker.options, { type: "module" });
    });

    it("resolves with the worker's result and terminates it", async () => {
      const { promise, worker } = startRun();
      worker.emit("message", { data: { ok: true, result: okResult } });
      const result = await promise;
      assert.deepEqual(result.data, Uint8Array.from(PMTILES_MAGIC));
      assert.deepEqual(result.messages, ["packing PMTiles archive"]);
      assert.equal(worker.terminated, true, "the worker should not leak");
    });

    it("rejects with the error the worker reports", async () => {
      const { promise, worker } = startRun();
      worker.emit("message", { data: { ok: false, error: "runner exploded" } });
      await assert.rejects(promise, /runner exploded/);
      assert.equal(worker.terminated, true);
    });

    it("rejects when the worker itself fails", async () => {
      const { promise, worker } = startRun();
      worker.emit("error", { message: "worker boom" });
      await assert.rejects(promise, /worker boom/);
      assert.equal(worker.terminated, true);
    });

    // `error` does not fire for an undeserializable message, so without its own
    // listener this promise would stay pending forever.
    it("rejects when the worker's message cannot be deserialized", async () => {
      const { promise, worker } = startRun();
      worker.emit("messageerror", {});
      await assert.rejects(promise, /undeserializable/i);
      assert.equal(worker.terminated, true);
    });

    it("terminates the worker when the message cannot be posted", async () => {
      FakeWorker.postMessageError = new Error("DataCloneError");
      const { promise, worker } = startRun();
      await assert.rejects(promise, /DataCloneError/);
      assert.equal(worker.terminated, true, "the worker should not leak");
    });
  });
});
