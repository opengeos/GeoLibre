import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { strToU8, zipSync } from "fflate";
import {
  routeImdfFileSelection,
  setKmlFileImportHandler,
  wireImdfUrlImports,
  type KmlFileImport,
} from "../packages/plugins/src/plugins/maplibre-vector";

const IMDF_URL = "https://data.example.org/venues/Museum.zip?v=2";

function imdfZip(): Uint8Array {
  return zipSync({
    "Museum/manifest.json": strToU8('{"version":"1.0.0","language":"en"}'),
    "Museum/venue.geojson": strToU8('{"type":"FeatureCollection","features":[]}'),
  });
}

/** A control whose addData records its calls, wrapped by wireImdfUrlImports. */
function wiredControl() {
  const calls: unknown[] = [];
  const control = {
    addData: async (source: unknown) => {
      calls.push(source);
      return { id: "control-layer", name: "x" };
    },
  };
  wireImdfUrlImports(control as never);
  return {
    control: control as unknown as { addData: (s: unknown, o?: object) => Promise<unknown> },
    calls,
  };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  setKmlFileImportHandler(null);
});

/**
 * Serve `bytes` like a static host: honour `Range` (206 with Content-Range)
 * unless `ranges` is false, in which case every request gets the whole file.
 * Records each request as "url" or "url [range]".
 */
function serve(bytes: Uint8Array | null, ranges = true) {
  const fetched: string[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const range = new Headers(init?.headers).get("range");
    fetched.push(range ? `${url} [${range}]` : String(url));
    if (!bytes) throw new TypeError("network down");
    if (!range || !ranges) return new Response(new Blob([bytes as BlobPart]), { status: 200 });
    const size = bytes.byteLength;
    const suffix = /^bytes=-(\d+)$/.exec(range);
    const span = /^bytes=(\d+)-(\d+)$/.exec(range);
    const start = suffix ? Math.max(0, size - Number(suffix[1])) : Number(span![1]);
    const end = suffix ? size - 1 : Math.min(size - 1, Number(span![2]));
    return new Response(new Blob([bytes.subarray(start, end + 1) as BlobPart]), {
      status: 206,
      headers: { "content-range": `bytes ${start}-${end}/${size}` },
    });
  }) as typeof fetch;
  return fetched;
}

const isFull = (request: string) => !request.includes("[");

describe("wireImdfUrlImports", () => {
  it("hands an IMDF zip URL to the host importer instead of the control", async () => {
    const imports: KmlFileImport[][] = [];
    setKmlFileImportHandler((files) => {
      imports.push(files);
    });
    serve(imdfZip());
    const { control, calls } = wiredControl();
    await control.addData(IMDF_URL, {});
    assert.equal(calls.length, 0);
    assert.equal(imports.length, 1);
    assert.equal(imports[0][0].file.name, "Museum.zip");
  });

  it("downloads an IMDF zip once from a server without range support", async () => {
    const imports: KmlFileImport[][] = [];
    setKmlFileImportHandler((files) => {
      imports.push(files);
    });
    const fetched = serve(imdfZip(), false);
    const { control } = wiredControl();
    await control.addData(IMDF_URL, {});
    assert.equal(imports.length, 1);
    assert.equal(fetched.length, 1);
  });

  it("passes an IMDF zip to the control when its download fails after the probe", async () => {
    const imports: KmlFileImport[][] = [];
    setKmlFileImportHandler((files) => {
      imports.push(files);
    });
    serve(imdfZip());
    const rangedFetch = globalThis.fetch;
    // The probe's range requests succeed; the full download then drops.
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (!new Headers(init?.headers).get("range")) throw new TypeError("connection reset");
      return rangedFetch(url, init);
    }) as typeof fetch;
    const { control, calls } = wiredControl();
    await control.addData(IMDF_URL, {});
    assert.deepEqual(calls, [IMDF_URL]);
    assert.equal(imports.length, 0);
  });

  it("passes any other zip, URL or restore replay to the control", async () => {
    const imports: KmlFileImport[][] = [];
    setKmlFileImportHandler((files) => {
      imports.push(files);
    });
    const fetched = serve(zipSync({ "roads.shp": strToU8("x") }));
    const { control, calls } = wiredControl();
    await control.addData("https://data.example.org/roads.zip", {});
    await control.addData("https://data.example.org/roads.geojson", {});
    await control.addData(IMDF_URL, { id: "restored-layer" });
    assert.equal(calls.length, 3);
    assert.equal(imports.length, 0);
    // Only the plain zip was probed, and only by range requests (the control
    // downloads it in full); the others were never fetched here.
    assert.ok(fetched.length > 0);
    assert.ok(
      fetched.every((request) => request.startsWith("https://data.example.org/roads.zip [")),
    );
    assert.ok(!fetched.some(isFull));
  });

  it("lets the control report a zip it cannot fetch", async () => {
    setKmlFileImportHandler(() => {});
    serve(null);
    const { control, calls } = wiredControl();
    await control.addData(IMDF_URL, {});
    assert.deepEqual(calls, [IMDF_URL]);
  });

  it("does nothing without a host importer", async () => {
    const fetched = serve(imdfZip());
    const { control, calls } = wiredControl();
    await control.addData(IMDF_URL, {});
    assert.deepEqual(calls, [IMDF_URL]);
    assert.deepEqual(fetched, []);
  });
});

describe("routeImdfFileSelection", () => {
  it("splits a mixed selection: IMDF to the importer, the rest back", async () => {
    const imports: KmlFileImport[][] = [];
    setKmlFileImportHandler((files) => {
      imports.push(files);
    });
    const venue = new File([imdfZip() as BlobPart], "Museum.zip");
    const roads = new File([zipSync({ "roads.shp": strToU8("x") }) as BlobPart], "roads.zip");
    const points = new File(["{}"], "points.geojson");
    const rest = await routeImdfFileSelection([{ file: roads }, { file: venue }, { file: points }]);
    assert.deepEqual(
      rest.map(({ file }) => file.name),
      ["roads.zip", "points.geojson"],
    );
    assert.deepEqual(
      imports.map((batch) => batch.map(({ file }) => file.name)),
      [["Museum.zip"]],
    );
  });

  it("keeps the rest loading when the importer fails", async () => {
    setKmlFileImportHandler(() => {
      throw new Error("import failed");
    });
    const venue = new File([imdfZip() as BlobPart], "Museum.zip");
    const roads = new File([zipSync({ "roads.shp": strToU8("x") }) as BlobPart], "roads.zip");
    const rest = await routeImdfFileSelection([{ file: venue }, { file: roads }]);
    assert.deepEqual(
      rest.map(({ file }) => file.name),
      ["roads.zip"],
    );
  });
});
