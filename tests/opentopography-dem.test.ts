import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  DOWNLOAD_GLOBAL_DEM_TOOL,
  downloadGlobalDem,
  withGlobalDemTool,
} from "../apps/geolibre-desktop/src/lib/opentopography-dem";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OpenTopography global DEM", () => {
  it("registers the built-in tool once", () => {
    assert.deepEqual(withGlobalDemTool([]), [DOWNLOAD_GLOBAL_DEM_TOOL]);
    assert.equal(withGlobalDemTool([DOWNLOAD_GLOBAL_DEM_TOOL]).length, 1);
    const dataset = DOWNLOAD_GLOBAL_DEM_TOOL.params?.find((param) => param.name === "dataset");
    assert.ok(dataset?.options?.includes("SRTMGL1"));
    assert.ok(!dataset?.options?.includes("SRTM_GL1"));
  });

  it("requests a clipped GeoTIFF with the selected dataset and bbox", async () => {
    let requested = "";
    globalThis.fetch = async (input) => {
      requested = String(input);
      return new Response(new Uint8Array([0x49, 0x49, 0x2a, 0x00]));
    };
    const bytes = await downloadGlobalDem({
      dataset: "COP30",
      bbox: "-84,35,-83,36",
      bboxCrs: 4326,
      apiKey: "test key",
    });

    const url = new URL(requested);
    assert.equal(url.origin + url.pathname, "https://portal.opentopography.org/API/globaldem");
    assert.equal(url.searchParams.get("demtype"), "COP30");
    assert.equal(url.searchParams.get("west"), "-84");
    assert.equal(url.searchParams.get("north"), "36");
    assert.equal(url.searchParams.get("outputFormat"), "GTiff");
    assert.equal(url.searchParams.get("API_Key"), "test key");
    assert.deepEqual([...bytes], [0x49, 0x49, 0x2a, 0x00]);
  });

  it("rejects invalid extents before making a request", async () => {
    globalThis.fetch = async () => assert.fail("fetch should not run");
    await assert.rejects(
      downloadGlobalDem({
        dataset: "COP30",
        bbox: "10,0,-10,1",
        bboxCrs: 4326,
        apiKey: "key",
      }),
      /valid WGS84 extent/,
    );
  });

  it("does not expose the API key in HTTP error messages", async () => {
    globalThis.fetch = async () =>
      new Response("invalid key super-secret/encoded or super-secret%2Fencoded", { status: 401 });
    await assert.rejects(
      downloadGlobalDem({
        dataset: "COP30",
        bbox: "-84,35,-83,36",
        bboxCrs: 4326,
        apiKey: "super-secret/encoded",
      }),
      (error: Error) =>
        !error.message.includes("super-secret/encoded") &&
        !error.message.includes("super-secret%2Fencoded") &&
        error.message.includes("401"),
    );
  });
});
