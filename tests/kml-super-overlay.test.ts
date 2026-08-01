import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeoLibreLayer } from "@geolibre/core";
import { config } from "maplibre-gl";
import {
  isKmlSuperOverlayUrl,
  parseTileUrl,
  pruneKmlSuperOverlays,
  registerKmlSuperOverlay,
  registerKmlSuperOverlayProtocol,
  setKmlSuperOverlayResolver,
  unregisterKmlSuperOverlay,
  type KmlSuperOverlayTile,
} from "../apps/geolibre-desktop/src/lib/kml-super-overlay";

const PROTOCOL = "geolibre-kml-super-overlay";

type ProtocolHandler = (
  params: { url: string },
  abort?: AbortController,
) => Promise<{ data: ArrayBuffer }>;

function protocolHandler(): ProtocolHandler {
  const handler = (config as { REGISTERED_PROTOCOLS?: Record<string, ProtocolHandler> })
    .REGISTERED_PROTOCOLS?.[PROTOCOL];
  assert.ok(handler, "the Super-Overlay protocol should be registered");
  return handler;
}

/** One pyramid tile covering `[west, south, east, north]` at `drawOrder`. */
function tile(bounds: [number, number, number, number], drawOrder: number): KmlSuperOverlayTile {
  const [west, south, east, north] = bounds;
  return {
    overlay: {
      href: `${drawOrder}/tile.png`,
      coordinates: [
        [west, north],
        [east, north],
        [east, south],
        [west, south],
      ],
      bounds,
      opacity: 1,
      drawOrder,
    },
    bytes: new Uint8Array([1, 2, 3]),
  };
}

/** A store layer pointing a raster source at `url`, as `addTileLayer` builds. */
function tileLayer(url: string): GeoLibreLayer {
  return {
    id: url,
    name: "pyramid",
    type: "xyz",
    source: { type: "raster", tiles: [url], tileSize: 256 },
  } as unknown as GeoLibreLayer;
}

// Runs first, before any registerKmlSuperOverlay call in this file, so it
// really asserts that no import is needed to teach MapLibre the scheme.
describe("registerKmlSuperOverlayProtocol", () => {
  it("registers the tile scheme without importing an archive", async () => {
    // A session that only reopens a saved project never imports a KMZ, and
    // MapLibre would fetch() the saved tile URLs instead of routing them here.
    await registerKmlSuperOverlayProtocol();

    protocolHandler();

    await registerKmlSuperOverlayProtocol();
    protocolHandler();
  });
});

describe("registerKmlSuperOverlay", () => {
  it("registers the protocol and reports the pyramid's extent and zoom range", async () => {
    const source = await registerKmlSuperOverlay(
      [tile([-180, -85, 0, 0], 2), tile([0, 0, 180, 85], 2), tile([-180, -85, 180, 85], 1)],
      { key: "/data/extent.kmz" },
    );

    protocolHandler();
    assert.equal(source.url, `${PROTOCOL}://${encodeURIComponent("/data/extent.kmz")}/{z}/{x}/{y}`);
    assert.deepEqual(source.bounds, [-180, -85, 180, 85]);
    assert.equal(source.minzoom, 1);
    assert.equal(source.maxzoom, 2);
    assert.equal(unregisterKmlSuperOverlay(source.url), true);
  });

  it("rejects an archive with no raster tiles", async () => {
    await assert.rejects(registerKmlSuperOverlay([]), /must contain raster tiles/);
  });

  it("derives the pyramid levels from tile size when drawOrder does not vary", async () => {
    // A generator that omits <drawOrder> leaves every overlay at the 0 default;
    // without the fallback the whole pyramid would collapse onto one level.
    const source = await registerKmlSuperOverlay(
      [tile([-180, -85, 0, 0], 0), tile([0, 0, 90, 45], 0), tile([0, 0, 45, 22.5], 0)],
      { key: "/data/no-draw-order.kmz" },
    );

    assert.equal(source.minzoom, 1);
    assert.equal(source.maxzoom, 3);
    unregisterKmlSuperOverlay(source.url);
  });

  it("replaces the archive when the same key is registered again", async () => {
    const first = await registerKmlSuperOverlay([tile([-10, -10, 10, 10], 4)], {
      key: "/data/same.kmz",
    });
    const second = await registerKmlSuperOverlay([tile([-20, -20, 20, 20], 5)], {
      key: "/data/same.kmz",
    });

    assert.equal(second.url, first.url);
    // One archive, not two: the second unregister finds nothing left to free.
    assert.equal(unregisterKmlSuperOverlay(first.url), true);
    assert.equal(unregisterKmlSuperOverlay(second.url), false);
  });

  it("gives a path-less source a session-only key", async () => {
    const source = await registerKmlSuperOverlay([tile([-10, -10, 10, 10], 3)]);

    assert.ok(isKmlSuperOverlayUrl(source.url));
    assert.match(source.url, /^geolibre-kml-super-overlay:\/\/[\w-]+\/\{z\}\/\{x\}\/\{y\}$/);
    assert.equal(unregisterKmlSuperOverlay(source.url), true);
  });
});

describe("parseTileUrl", () => {
  it("reads the archive id and tile coordinates back out of a tile URL", () => {
    assert.deepEqual(parseTileUrl(`${PROTOCOL}://${encodeURIComponent("/a b.kmz")}/5/6/7`), {
      id: "/a b.kmz",
      z: 5,
      x: 6,
      y: 7,
    });
  });

  it("rejects a foreign protocol or a malformed coordinate", () => {
    assert.equal(parseTileUrl("pmtiles://basemap/1/2/3"), null);
    assert.equal(parseTileUrl(`${PROTOCOL}://archive`), null);
    assert.equal(parseTileUrl(`${PROTOCOL}://archive/1/x/3`), null);
  });

  it("rejects invalid percent-encoding instead of throwing", () => {
    // Reached from the store subscription, where a URIError would break every
    // later store update.
    assert.equal(parseTileUrl(`${PROTOCOL}://%E0%A4%A/1/2/3`), null);
    assert.doesNotThrow(() => {
      pruneKmlSuperOverlays([tileLayer(`${PROTOCOL}://100%/{z}/{x}/{y}`)]);
    });
  });
});

describe("pruneKmlSuperOverlays", () => {
  it("frees archives no live layer still points at", async () => {
    const kept = await registerKmlSuperOverlay([tile([-10, -10, 10, 10], 2)], {
      key: "/data/kept.kmz",
    });
    const dropped = await registerKmlSuperOverlay([tile([-10, -10, 10, 10], 2)], {
      key: "/data/dropped.kmz",
    });

    pruneKmlSuperOverlays([tileLayer(kept.url), tileLayer(dropped.url)]);
    pruneKmlSuperOverlays([tileLayer(kept.url)]);

    assert.equal(unregisterKmlSuperOverlay(dropped.url), false);
    assert.equal(unregisterKmlSuperOverlay(kept.url), true);
  });

  it("leaves a freshly registered archive alone until its layer appears", async () => {
    // The importer registers the archive, then adds the tile layer; a store
    // change in between must not free a pyramid that has no path to re-read.
    const source = await registerKmlSuperOverlay([tile([-10, -10, 10, 10], 2)]);

    pruneKmlSuperOverlays([]);

    assert.equal(unregisterKmlSuperOverlay(source.url), true);
  });
});

describe("the tile protocol", () => {
  it("re-reads an archive this session never registered", async () => {
    // Only the tile URL persists into a project, so a reopened project has to
    // rebuild the pyramid from its source file on the first tile request.
    const url = `${PROTOCOL}://${encodeURIComponent("/data/reopened.kmz")}/1/0/0`;
    let reads = 0;
    setKmlSuperOverlayResolver(async (key) => {
      reads += 1;
      assert.equal(key, "/data/reopened.kmz");
      // Bounds outside the requested tile, so nothing is composited (no canvas
      // in Node) but the archive still registers.
      return [tile([170, 80, 180, 85], 1)];
    });

    try {
      const [first, second] = await Promise.all([
        protocolHandler()({ url }),
        protocolHandler()({ url }),
      ]);

      assert.equal(first.data.byteLength, 0);
      assert.equal(second.data.byteLength, 0);
      assert.equal(reads, 1, "concurrent tile requests should share one read");
      assert.equal(unregisterKmlSuperOverlay(url), true);
    } finally {
      unregisterKmlSuperOverlay(url);
      setKmlSuperOverlayResolver(null);
    }
  });

  it("re-reads a missing archive once, not on every tile request", async () => {
    let reads = 0;
    setKmlSuperOverlayResolver(async () => {
      reads += 1;
      throw new Error("the KMZ moved");
    });

    try {
      const url = `${PROTOCOL}://${encodeURIComponent("/data/moved.kmz")}/1/0/0`;
      assert.equal((await protocolHandler()({ url })).data.byteLength, 0);
      assert.equal((await protocolHandler()({ url })).data.byteLength, 0);
      assert.equal(reads, 1, "a failed re-read should not repeat for every tile");
    } finally {
      setKmlSuperOverlayResolver(null);
    }
  });

  it("answers with an empty tile when the archive cannot be re-read", async () => {
    setKmlSuperOverlayResolver(async () => null);

    try {
      const result = await protocolHandler()({ url: `${PROTOCOL}://missing/1/0/0` });

      assert.equal(result.data.byteLength, 0);
    } finally {
      setKmlSuperOverlayResolver(null);
    }
  });
});
