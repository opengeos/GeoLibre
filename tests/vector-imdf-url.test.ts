import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { strToU8, zipSync } from "fflate";
import {
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

function serve(bytes: Uint8Array | null) {
  const fetched: string[] = [];
  globalThis.fetch = (async (url: string) => {
    fetched.push(String(url));
    if (!bytes) throw new TypeError("network down");
    return new Response(new Blob([bytes as BlobPart]));
  }) as typeof fetch;
  return fetched;
}

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
    // Only the plain zip was fetched to look inside; the others never were.
    assert.deepEqual(fetched, ["https://data.example.org/roads.zip"]);
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
