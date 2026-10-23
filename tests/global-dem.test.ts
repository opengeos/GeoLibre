import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { writeRasterData } from "@geolibre/processing";
import {
  DOWNLOAD_GLOBAL_DEM_TOOL,
  buildGlobalDemRaster,
  downloadGlobalDem,
  globalDemTileRange,
  globalDemTileUrl,
  withGlobalDemTool,
} from "../apps/geolibre-desktop/src/lib/global-dem";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("global DEM from keyless terrain tiles", () => {
  it("registers a tool that does not request credentials", () => {
    assert.deepEqual(withGlobalDemTool([]), [DOWNLOAD_GLOBAL_DEM_TOOL]);
    assert.equal(withGlobalDemTool([DOWNLOAD_GLOBAL_DEM_TOOL]).length, 1);
    assert.ok(!DOWNLOAD_GLOBAL_DEM_TOOL.params?.some((param) => param.name === "api_key"));
    assert.match(DOWNLOAD_GLOBAL_DEM_TOOL.summary ?? "", /no API key/i);
  });

  it("builds public AWS Terrain Tiles URLs and caps mosaics", () => {
    assert.equal(
      globalDemTileUrl(12, 655, 1583),
      "https://s3.amazonaws.com/elevation-tiles-prod/geotiff/12/655/1583.tif",
    );
    const local = globalDemTileRange([-122.45, 37.72, -122.35, 37.82]);
    assert.equal(local.zoom, 12);
    const world = globalDemTileRange([-170, -80, 170, 80]);
    const count = (world.maxX - world.minX + 1) * (world.maxY - world.minY + 1);
    assert.ok(count <= 64);
  });

  it("downloads, mosaics, and crops DEM samples without a key", async () => {
    const tile = writeRasterData({
      bands: [new Float32Array(512 * 512).fill(123)],
      width: 512,
      height: 512,
      originX: 0,
      originY: 0,
      resX: 1,
      resY: 1,
      nodata: -32768,
      geoKeys: { ProjectedCSTypeGeoKey: 3857 },
    });
    const requested: string[] = [];
    globalThis.fetch = async (input) => {
      requested.push(String(input));
      return new Response(tile);
    };

    const result = await buildGlobalDemRaster({
      bbox: "-122.45,37.72,-122.44,37.73",
      bboxCrs: 4326,
    });
    assert.ok(requested.length > 0);
    assert.ok(requested.every((url) => url.startsWith("https://s3.amazonaws.com/")));
    assert.ok(result.width > 1 && result.height > 1);
    assert.equal(result.geoKeys.ProjectedCSTypeGeoKey, 3857);
    assert.ok(result.bands[0].every((value) => value === 123));
  });

  it("rejects invalid extents before making a request", async () => {
    globalThis.fetch = async () => assert.fail("fetch should not run");
    await assert.rejects(
      downloadGlobalDem({ bbox: "10,0,-10,1", bboxCrs: 4326 }),
      /valid WGS84 extent/,
    );
    await assert.rejects(
      downloadGlobalDem({ bbox: "10,,20,30", bboxCrs: 4326 }),
      /valid WGS84 extent/,
    );
  });
});
