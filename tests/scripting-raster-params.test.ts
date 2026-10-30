import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  base64ToBytes,
  cogOptionsFromParams,
  requireHttpUrl,
  tileOptionsFromParams,
} from "../apps/geolibre-desktop/src/lib/scripting/raster-params";

describe("scripting raster params", () => {
  it("accepts http(s) URLs and rejects other schemes", () => {
    assert.equal(requireHttpUrl("cmd", "https://x.test/a.tif"), "https://x.test/a.tif");
    assert.throws(() => requireHttpUrl("cmd", "javascript:alert(1)"), /cmd: url must be/);
    assert.throws(() => requireHttpUrl("cmd", undefined), /cmd: url must be/);
  });

  it("decodes base64 into the original bytes", () => {
    assert.deepEqual([...base64ToBytes("SUkqAP8=")], [0x49, 0x49, 0x2a, 0x00, 0xff]);
  });

  it("reports invalid base64 by command name", () => {
    assert.throws(() => base64ToBytes("not base64!"), /addRasterBytes: data is not valid base64/);
  });

  it("keeps tile options but never a source override", () => {
    assert.deepEqual(
      tileOptionsFromParams({
        tiles: ["javascript:alert(1)"],
        type: "wms",
        attribution: "Esri",
        minzoom: 5,
        bounds: [-1, -1, 1, 1],
      }),
      { attribution: "Esri", minzoom: 5, bounds: [-1, -1, 1, 1] },
    );
    assert.deepEqual(tileOptionsFromParams({ bounds: [0, 0], scheme: "other" }), {});
    assert.deepEqual(tileOptionsFromParams({ beforeLayerId: "a", metadata: { source: "x" } }), {
      beforeLayerId: "a",
      metadata: { source: "x" },
    });
  });

  it("keeps a known COG engine and drops an unknown one", () => {
    assert.deepEqual(cogOptionsFromParams({ engine: "titiler", beforeLayerId: "a" }), {
      engine: "titiler",
      beforeLayerId: "a",
    });
    assert.deepEqual(cogOptionsFromParams({ engine: "other" }), {});
  });

  it("keeps valid COG options and drops the rest", () => {
    assert.deepEqual(
      cogOptionsFromParams({
        colormap: "terrain",
        rescaleMin: 0,
        rescaleMax: "4000",
        nodata: Number.NaN,
        opacity: 0.5,
        zoomTo: false,
        unknown: 1,
      }),
      { colormap: "terrain", rescaleMin: 0, opacity: 0.5, zoomTo: false },
    );
    assert.deepEqual(cogOptionsFromParams(null), {});
    assert.deepEqual(cogOptionsFromParams([1]), {});
  });
});
