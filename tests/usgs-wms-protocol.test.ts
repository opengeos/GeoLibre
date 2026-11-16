import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  type EllipsoidId,
  PLANETARY_BASEMAPS,
  USGS_ASTRO_WMS_BASE,
  USGS_WMS_PROTOCOL,
} from "@geolibre/core";
import type { RequestParameters } from "maplibre-gl";
import { hasRegisteredProtocol } from "../packages/map/src/protocol-tiles";
import {
  clearUsgsWmsTileCache,
  ensureUsgsWmsProtocol,
  parseUsgsWmsTileUrl,
  usgsWmsGetMapUrl,
  usgsWmsProtocolHandler,
} from "../packages/map/src/usgs-wms-protocol";
import { remapRowsToMercator, tileGeoBounds } from "../packages/map/src/wms-reproject";

const wmsBasemaps = PLANETARY_BASEMAPS.filter((b) => b.wms);

describe("USGS WMS planetary basemaps", () => {
  it("covers every body that isn't Earth, the Moon, or Mars", () => {
    const bodies = new Set(wmsBasemaps.map((b) => b.ellipsoidId));
    const expected: EllipsoidId[] = [
      "mercury",
      "venus",
      "io",
      "europa",
      "ganymede",
      "callisto",
      "titan",
      "pluto",
      "charon",
    ];
    for (const id of expected) {
      assert.ok(bodies.has(id), `${id} should have a USGS WMS basemap`);
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
    // Deeper than the basemap's maxZoom (6 for Venus) would only waste a request.
    assert.equal(parseUsgsWmsTileUrl("usgs-wms://venus-magellan/7/0/0"), null);
    assert.ok(parseUsgsWmsTileUrl("usgs-wms://venus-magellan/6/0/0"));
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

describe("usgsWmsProtocolHandler", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    clearUsgsWmsTileCache();
  });

  const request = (url: string) => ({ url, type: "image" }) as RequestParameters;

  it("rejects an unknown tile URL without fetching", async () => {
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response();
    }) as typeof fetch;
    await assert.rejects(
      usgsWmsProtocolHandler(request("usgs-wms://nope/0/0/0"), new AbortController()),
      /Unknown USGS WMS tile/,
    );
    assert.equal(fetched, false);
  });

  it("throws on a WMS ServiceException instead of drawing a blank tile", async () => {
    // A misconfigured layer answers 200 with XML, which the old Worker turned
    // into a silent transparent tile.
    globalThis.fetch = (async () =>
      new Response("<ServiceExceptionReport/>", {
        status: 200,
        headers: { "content-type": "application/vnd.ogc.se_xml" },
      })) as typeof fetch;
    await assert.rejects(
      usgsWmsProtocolHandler(request("usgs-wms://venus-magellan/0/0/0"), new AbortController()),
      /USGS WMS venus-magellan 0\/0\/0: 200 application\/vnd\.ogc\.se_xml/,
    );
  });

  it("throws on an upstream block page", async () => {
    globalThis.fetch = (async () =>
      new Response("<html>blocked</html>", {
        status: 403,
        headers: { "content-type": "text/html" },
      })) as typeof fetch;
    await assert.rejects(
      usgsWmsProtocolHandler(request("usgs-wms://titan-cassini/1/0/0"), new AbortController()),
      /403 text\/html/,
    );
  });

  it("passes MapLibre's abort signal to the fetch", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | null | undefined;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      seen = init?.signal;
      throw new DOMException("aborted", "AbortError");
    }) as typeof fetch;
    controller.abort();
    await assert.rejects(
      usgsWmsProtocolHandler(request("usgs-wms://pluto-mosaic/0/0/0"), controller),
      /aborted/,
    );
    assert.equal(seen, controller.signal);
  });
});

// Deterministic doubles for the browser image pipeline. The "PNG" a stubbed
// fetch returns is raw RGBA; the bitmap double carries those bytes, and the
// canvas double copies pixels through drawImage/getImageData/putImageData and
// "encodes" by returning them as-is. So the handler's output bytes are exactly
// the warped pixels it produced.
const SIZE = 256;

class FakeContext {
  pixels = new Uint8ClampedArray(SIZE * SIZE * 4);
  drawImage(image: { bytes: Uint8Array }) {
    this.pixels = new Uint8ClampedArray(image.bytes);
  }
  getImageData() {
    return { data: new Uint8ClampedArray(this.pixels) };
  }
  createImageData(w: number, h: number) {
    return { data: new Uint8ClampedArray(w * h * 4) };
  }
  putImageData(image: { data: Uint8ClampedArray }) {
    this.pixels = new Uint8ClampedArray(image.data);
  }
}

class FakeOffscreenCanvas {
  ctx = new FakeContext();
  getContext() {
    return this.ctx;
  }
  async convertToBlob() {
    return new Blob([this.ctx.pixels]);
  }
}

/** A source image whose every pixel in row r is (r, r, r, 255). */
function rowCodedImage(): Uint8Array {
  const src = new Uint8Array(SIZE * SIZE * 4);
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) src.set([r, r, r, 255], (r * SIZE + c) * 4);
  }
  return src;
}

describe("usgsWmsProtocolHandler success path", () => {
  const g = globalThis as Record<string, unknown>;
  const real = {
    fetch: globalThis.fetch,
    createImageBitmap: g.createImageBitmap,
    OffscreenCanvas: g.OffscreenCanvas,
  };
  const src = rowCodedImage();
  let fetches: string[] = [];
  let failNext = false;

  beforeEach(() => {
    fetches = [];
    failNext = false;
    clearUsgsWmsTileCache();
    globalThis.fetch = (async (url: string) => {
      fetches.push(url);
      if (failNext) {
        failNext = false;
        return new Response("busy", { status: 503, headers: { "content-type": "text/plain" } });
      }
      return new Response(src.slice(), { headers: { "content-type": "image/png" } });
    }) as typeof fetch;
    g.createImageBitmap = async (blob: Blob) => ({
      bytes: new Uint8Array(await blob.arrayBuffer()),
      close() {},
    });
    g.OffscreenCanvas = FakeOffscreenCanvas;
  });

  afterEach(() => {
    globalThis.fetch = real.fetch;
    g.createImageBitmap = real.createImageBitmap;
    g.OffscreenCanvas = real.OffscreenCanvas;
    clearUsgsWmsTileCache();
  });

  const tileUrl = (z: number, x: number, y: number) => `usgs-wms://venus-magellan/${z}/${x}/${y}`;
  const get = (url: string) =>
    usgsWmsProtocolHandler({ url, type: "image" } as RequestParameters, new AbortController());

  it("returns the WMS window warped onto the Mercator rows", async () => {
    const tile = { z: 1, x: 0, y: 0 };
    const { data } = await get(tileUrl(1, 0, 0));
    const expected = remapRowsToMercator(src, SIZE, tile, tileGeoBounds(tile));
    assert.deepEqual(new Uint8Array(data), expected);
    // Sanity: the warp is not the identity at this zoom.
    assert.notDeepEqual(expected, src);
  });

  it("serves a repeat request from the cache as an independent buffer", async () => {
    const first = await get(tileUrl(2, 1, 1));
    new Uint8Array(first.data).fill(0); // a consumer mutating its copy
    structuredClone(first.data, { transfer: [first.data] }); // ...or transferring it
    const second = await get(tileUrl(2, 1, 1));
    assert.equal(fetches.length, 1);
    const tile = { z: 2, x: 1, y: 1 };
    assert.deepEqual(
      new Uint8Array(second.data),
      remapRowsToMercator(src, SIZE, tile, tileGeoBounds(tile)),
    );
  });

  it("does not cache a failed request", async () => {
    failNext = true;
    await assert.rejects(get(tileUrl(1, 1, 1)), /503/);
    await get(tileUrl(1, 1, 1));
    assert.equal(fetches.length, 2);
  });

  it("evicts the least recently used tile past 256 entries", async () => {
    // Tiles 0..255 of zoom 6 (64 tiles wide) fill the cache.
    const nth = (i: number) => tileUrl(6, i % 64, Math.floor(i / 64));
    for (let i = 0; i < 256; i++) await get(nth(i));
    assert.equal(fetches.length, 256);
    await get(nth(0)); // a hit refreshes tile 0's recency
    assert.equal(fetches.length, 256);
    await get(nth(256)); // the 257th tile evicts tile 1, not tile 0
    assert.equal(fetches.length, 257);
    await get(nth(0));
    assert.equal(fetches.length, 257);
    await get(nth(1));
    assert.equal(fetches.length, 258);
  });
});

describe("ensureUsgsWmsProtocol", () => {
  it("registers the usgs-wms protocol with MapLibre", () => {
    ensureUsgsWmsProtocol();
    assert.ok(hasRegisteredProtocol(USGS_WMS_PROTOCOL));
    ensureUsgsWmsProtocol(); // idempotent
    assert.ok(hasRegisteredProtocol(USGS_WMS_PROTOCOL));
  });
});
