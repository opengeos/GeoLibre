import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PLANETARY_BASEMAPS, USGS_ASTRO_WMS_BASE, USGS_WMS_PROTOCOL } from "@geolibre/core";
import { parseUsgsWmsTileUrl, usgsWmsGetMapUrl } from "../packages/map/src/usgs-wms-protocol";

const wmsBasemaps = PLANETARY_BASEMAPS.filter((b) => b.wms);

describe("USGS WMS planetary basemaps", () => {
  it("covers every body that isn't Earth, the Moon, or Mars", () => {
    const bodies = new Set(wmsBasemaps.map((b) => b.ellipsoidId));
    for (const id of [
      "mercury",
      "venus",
      "io",
      "europa",
      "ganymede",
      "callisto",
      "titan",
      "pluto",
      "charon",
    ]) {
      assert.ok(bodies.has(id as never), `${id} should have a USGS WMS basemap`);
    }
  });

  it("reads tiles through the browser protocol, never the tiles Worker", () => {
    // The tiles.geolibre.app/wms proxy got a 403 from USGS's Cloudflare bot
    // protection, so every tile came back blank.
    for (const basemap of PLANETARY_BASEMAPS) {
      assert.ok(!basemap.tileUrl.includes("tiles.geolibre.app/wms"), basemap.id);
      const viaProtocol = basemap.tileUrl.startsWith(`${USGS_WMS_PROTOCOL}://`);
      assert.equal(viaProtocol, Boolean(basemap.wms), basemap.id);
    }
  });

  it("parses each catalog tile URL back to its WMS layer", () => {
    for (const basemap of wmsBasemaps) {
      const url = basemap.tileUrl.replace("{z}", "2").replace("{x}", "3").replace("{y}", "1");
      const tile = parseUsgsWmsTileUrl(url);
      assert.ok(tile, basemap.id);
      assert.deepEqual(tile, { basemapId: basemap.id, wms: basemap.wms, z: 2, x: 3, y: 1 });
    }
  });

  it("rejects unknown basemaps, non-WMS basemaps and out-of-pyramid tiles", () => {
    assert.equal(parseUsgsWmsTileUrl("usgs-wms://nope/0/0/0"), null);
    assert.equal(parseUsgsWmsTileUrl("usgs-wms://mars-hillshade/0/0/0"), null);
    assert.equal(parseUsgsWmsTileUrl("usgs-wms://constructor/0/0/0"), null);
    assert.equal(parseUsgsWmsTileUrl("usgs-wms://venus-magellan/1/2/0"), null);
    assert.equal(parseUsgsWmsTileUrl("https://example.com/venus-magellan/0/0/0"), null);
  });

  it("requests the EPSG:4326 window matching the tile", () => {
    const url = new URL(
      usgsWmsGetMapUrl(
        { map: "/maps/venus/venus_simp_cyl.map", layer: "MAGELLAN" },
        { z: 1, x: 1, y: 0 },
      ),
    );
    assert.equal(`${url.origin}${url.pathname}`, USGS_ASTRO_WMS_BASE);
    assert.equal(url.searchParams.get("map"), "/maps/venus/venus_simp_cyl.map");
    assert.equal(url.searchParams.get("LAYERS"), "MAGELLAN");
    assert.equal(url.searchParams.get("SRS"), "EPSG:4326");
    assert.equal(url.searchParams.get("WIDTH"), "256");
    const [w, s, e, n] = url.searchParams.get("BBOX")!.split(",").map(Number);
    assert.equal(w, 0);
    assert.equal(e, 180);
    assert.equal(s, 0);
    assert.ok(Math.abs(n - 85.0511287798066) < 1e-9);
  });
});
