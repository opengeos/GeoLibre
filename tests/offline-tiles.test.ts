import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Map as MapLibreMap } from "maplibre-gl";
import {
  clampZoomRange,
  collectOfflineUrls,
  countOfflineTiles,
  countStyleAssets,
  countTiles,
  enumerateTiles,
  expandTileUrl,
  lngLatToTile,
  planOfflineZoom,
  tileRangeForBbox,
  tileToQuadkey,
  warmUrls,
  type Bbox,
} from "../apps/geolibre-desktop/src/lib/offline-tiles";

describe("lngLatToTile", () => {
  it("maps the origin (0,0) to the center tile boundary", () => {
    // At z=1 the world is a 2x2 grid; lng/lat 0/0 sits at the seam → tile (1,1).
    assert.deepEqual(lngLatToTile(0, 0, 1), { x: 1, y: 1 });
  });

  it("maps the top-left of the world near (−180, 85) to tile (0,0)", () => {
    assert.deepEqual(lngLatToTile(-179.9, 85, 2), { x: 0, y: 0 });
  });

  it("clamps out-of-range latitudes to the Web Mercator limit", () => {
    // Beyond ~85.05° clamps to the top/bottom row rather than producing NaN.
    const z = 4;
    const top = lngLatToTile(0, 89, z);
    const bottom = lngLatToTile(0, -89, z);
    assert.equal(top.y, 0);
    assert.equal(bottom.y, 2 ** z - 1);
    assert.ok(Number.isFinite(top.x) && Number.isFinite(bottom.x));
  });

  it("clamps columns/rows to the valid range for the zoom", () => {
    const z = 3;
    const max = 2 ** z - 1;
    const t = lngLatToTile(180, -85, z);
    assert.ok(t.x <= max && t.y <= max && t.x >= 0 && t.y >= 0);
  });
});

describe("tileRangeForBbox", () => {
  it("orders min/max correctly regardless of corner ↔ tile-row inversion", () => {
    // Latitude increases northward but tile rows increase southward; the range
    // must still come back with minY <= maxY.
    const bbox: Bbox = [-10, -10, 10, 10];
    const r = tileRangeForBbox(bbox, 5);
    assert.ok(r.minX <= r.maxX);
    assert.ok(r.minY <= r.maxY);
  });

  it("covers a single tile for a tiny bbox", () => {
    const bbox: Bbox = [0.01, 0.01, 0.02, 0.02];
    const r = tileRangeForBbox(bbox, 4);
    assert.equal(r.minX, r.maxX);
    assert.equal(r.minY, r.maxY);
  });
});

describe("countTiles / enumerateTiles", () => {
  it("count matches the number enumerated", () => {
    const bbox: Bbox = [-5, -5, 5, 5];
    const min = 2;
    const max = 6;
    const enumerated = [...enumerateTiles(bbox, min, max)];
    assert.equal(countTiles(bbox, min, max), enumerated.length);
  });

  it("sums each zoom's rectangle", () => {
    const bbox: Bbox = [-5, -5, 5, 5];
    let expected = 0;
    for (let z = 3; z <= 5; z++) {
      const r = tileRangeForBbox(bbox, z);
      expected += (r.maxX - r.minX + 1) * (r.maxY - r.minY + 1);
    }
    assert.equal(countTiles(bbox, 3, 5), expected);
  });

  it("enumerated tiles all fall within the bbox tile ranges", () => {
    const bbox: Bbox = [-5, -5, 5, 5];
    for (const tile of enumerateTiles(bbox, 4, 5)) {
      const r = tileRangeForBbox(bbox, tile.z);
      assert.ok(tile.x >= r.minX && tile.x <= r.maxX);
      assert.ok(tile.y >= r.minY && tile.y <= r.maxY);
    }
  });
});

describe("expandTileUrl", () => {
  it("substitutes z/x/y", () => {
    assert.equal(
      expandTileUrl("https://h/{z}/{x}/{y}.png", { z: 3, x: 2, y: 1 }),
      "https://h/3/2/1.png",
    );
  });

  it("computes TMS {-y}", () => {
    // z=3 → 8 rows; {-y} for y=1 is 8-1-1 = 6.
    assert.equal(
      expandTileUrl("https://h/{z}/{x}/{-y}.png", { z: 3, x: 2, y: 1 }),
      "https://h/3/2/6.png",
    );
  });

  it("computes {quadkey}", () => {
    assert.equal(
      expandTileUrl("https://h/{quadkey}", { z: 3, x: 3, y: 5 }),
      `https://h/${tileToQuadkey({ z: 3, x: 3, y: 5 })}`,
    );
  });

  it("resolves {s} to the first subdomain", () => {
    assert.equal(
      expandTileUrl("https://{s}.h/{z}/{x}/{y}", { z: 1, x: 0, y: 0 }, [
        "a",
        "b",
      ]),
      "https://a.h/1/0/0",
    );
  });
});

describe("tileToQuadkey", () => {
  it("matches the canonical Bing example", () => {
    // Bing docs: tile (3,5) at z=3 → "213".
    assert.equal(tileToQuadkey({ z: 3, x: 3, y: 5 }), "213");
  });

  it("produces a key of length z", () => {
    assert.equal(tileToQuadkey({ z: 7, x: 10, y: 20 }).length, 7);
  });
});

describe("clampZoomRange", () => {
  it("returns the full range when the source has no bounds", () => {
    assert.deepEqual(clampZoomRange(2, 10), { minZoom: 2, maxZoom: 10 });
  });

  it("clamps the upper bound to the source maxzoom", () => {
    // OpenFreeMap vector tiles stop at z14: a z2–18 request warms z2–14.
    assert.deepEqual(clampZoomRange(2, 18, undefined, 14), {
      minZoom: 2,
      maxZoom: 14,
    });
  });

  it("warms only the deepest level when over-zoomed past the source", () => {
    // ne2_shaded raster stops at z6; a z10–15 request warms just z6 (overzoom).
    assert.deepEqual(clampZoomRange(10, 15, 0, 6), { minZoom: 6, maxZoom: 6 });
  });

  it("raises the lower bound to the source minzoom", () => {
    assert.deepEqual(clampZoomRange(2, 10, 5, 14), { minZoom: 5, maxZoom: 10 });
  });

  it("returns null when the request is entirely below coverage", () => {
    assert.equal(clampZoomRange(2, 4, 6, 14), null);
  });
});

describe("warmUrls", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** A fetch that resolves after `delayMs`, but rejects early if aborted. */
  function deferredFetch(delayMs: number): typeof fetch {
    return ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;
        const timer = setTimeout(
          () => resolve(new Response("ok", { status: 200 })),
          delayMs,
        );
        const onAbort = () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort);
      })) as typeof fetch;
  }

  it("warms every URL when requests succeed", async () => {
    globalThis.fetch = deferredFetch(0);
    const result = await warmUrls(["a", "b", "c"], { concurrency: 2 });
    assert.equal(result.done, 3);
    assert.equal(result.failed, 0);
    assert.deepEqual(result.failedUrls, []);
  });

  it("counts a request exceeding timeoutMs as failed, not a cancel", async () => {
    // Requests take 1s but the timeout is 10ms, so every one times out.
    globalThis.fetch = deferredFetch(1000);
    const result = await warmUrls(["a", "b"], {
      concurrency: 2,
      timeoutMs: 10,
    });
    assert.equal(result.done, 2);
    assert.equal(result.failed, 2);
    assert.deepEqual(result.failedUrls.sort(), ["a", "b"]);
  });

  it("stops settling new work once the parent signal is aborted", async () => {
    globalThis.fetch = deferredFetch(1000);
    const controller = new AbortController();
    const promise = warmUrls(["a", "b", "c"], {
      concurrency: 1,
      signal: controller.signal,
    });
    controller.abort();
    const result = await promise;
    // An abort short-circuits counting, so nothing is recorded as done/failed.
    assert.equal(result.done, 0);
    assert.equal(result.failed, 0);
  });
});

describe("countStyleAssets / count consistency (#992)", () => {
  // A fake map exposing only what these functions read: a style with an inline
  // raster source (no TileJSON `url`, so no fetch), a sprite, glyphs, and a
  // labelled layer. This lets us assert the preview count equals the download
  // total without a real MapLibre instance or network.
  function fakeMap(): MapLibreMap {
    const style = {
      sources: {
        base: {
          type: "raster",
          tiles: ["https://tiles.example.com/{z}/{x}/{y}.png"],
          minzoom: 0,
          maxzoom: 19,
        },
      },
      sprite: "https://style.example.com/sprite",
      glyphs: "https://style.example.com/glyphs/{fontstack}/{range}.pbf",
      layers: [
        { id: "bg", type: "background" },
        {
          id: "labels",
          type: "symbol",
          layout: { "text-font": ["Noto Sans Regular"] },
        },
      ],
    };
    return { getStyle: () => style } as unknown as MapLibreMap;
  }

  it("counts the sprite (1x/2x json+png) and one glyph PBF per fontstack range", () => {
    // 4 sprite URLs + 1 fontstack * 2 default ranges = 6 assets.
    assert.equal(countStyleAssets(fakeMap()), 6);
  });

  it("preview total (tiles + assets) equals the download URL count", async () => {
    const map = fakeMap();
    const bbox: Bbox = [-122.5, 37.7, -122.3, 37.9];
    const minZoom = 8;
    const maxZoom = 11;
    const tiles = await countOfflineTiles(map, bbox, minZoom, maxZoom);
    const assets = countStyleAssets(map);
    const { urls } = await collectOfflineUrls(map, bbox, minZoom, maxZoom);
    // The "Resources to download" estimate must mirror the "Downloading N / M"
    // progress total exactly, with no asset-overhead drift. This identity
    // assumes tile URLs and style-asset URLs are disjoint (tiles and sprite/glyph
    // assets are served from different paths) — `collectOfflineUrls` would
    // otherwise de-duplicate an overlap into one URL while `tiles + assets`
    // counts it twice. The fixture uses separate hosts, mirroring real styles.
    assert.equal(tiles + assets, urls.length);
  });

  // A map with two sources sharing one tile template (overlapping zoom range).
  // The download de-duplicates these into a single URL; the estimate must do the
  // same, or it would over-count and drift from the live total again.
  function twoSourceFakeMap(): MapLibreMap {
    const style = {
      sources: {
        a: {
          type: "raster",
          tiles: ["https://tiles.example.com/{z}/{x}/{y}.png"],
          minzoom: 0,
          maxzoom: 19,
        },
        b: {
          type: "raster",
          tiles: ["https://tiles.example.com/{z}/{x}/{y}.png"],
          minzoom: 0,
          maxzoom: 19,
        },
      },
      sprite: "https://style.example.com/sprite",
      glyphs: "https://style.example.com/glyphs/{fontstack}/{range}.pbf",
      layers: [
        {
          id: "labels",
          type: "symbol",
          layout: { "text-font": ["Noto Sans Regular"] },
        },
      ],
    };
    return { getStyle: () => style } as unknown as MapLibreMap;
  }

  it("counts sprite URLs for a multi-sprite (array) style", () => {
    const map = {
      getStyle: () => ({
        sources: {},
        sprite: [
          { id: "icons", url: "https://style.example.com/icons" },
          { id: "extra", url: "https://style.example.com/extra" },
        ],
        glyphs: "https://style.example.com/glyphs/{fontstack}/{range}.pbf",
        layers: [],
      }),
    } as unknown as MapLibreMap;
    // 2 sprites × 4 URLs each (json/png at 1x/2x) = 8; no labelled layers → 0
    // glyph URLs.
    assert.equal(countStyleAssets(map), 8);
  });

  it("de-duplicates tiles across sources so the estimate still matches", async () => {
    const map = twoSourceFakeMap();
    const bbox: Bbox = [-122.5, 37.7, -122.3, 37.9];
    const minZoom = 8;
    const maxZoom = 11;
    const tiles = await countOfflineTiles(map, bbox, minZoom, maxZoom);
    const assets = countStyleAssets(map);
    const { urls } = await collectOfflineUrls(map, bbox, minZoom, maxZoom);
    assert.equal(tiles + assets, urls.length);
  });
});

describe("planOfflineZoom", () => {
  const HARD_MAX = 5;

  it("downloads the current view only when extra detail is off", () => {
    const plan = planOfflineZoom(10.4, 24, false, 3, HARD_MAX);
    assert.equal(plan.baseZoom, 10);
    assert.equal(plan.maxZoom, 10);
    assert.equal(plan.canIncludeExtra, true);
    assert.equal(plan.maxExtraLevels, HARD_MAX);
  });

  it("adds the chosen extra levels on top of the base zoom", () => {
    const plan = planOfflineZoom(10, 24, true, 3, HARD_MAX);
    assert.equal(plan.baseZoom, 10);
    assert.equal(plan.maxZoom, 13);
    assert.equal(plan.canIncludeExtra, true);
    assert.equal(plan.maxExtraLevels, HARD_MAX);
  });

  it("treats extraLevels below 1 as 1 when includeExtra is on", () => {
    const plan = planOfflineZoom(10, 24, true, 0, HARD_MAX);
    assert.equal(plan.baseZoom, 10);
    assert.equal(plan.maxZoom, 11); // Math.max(1, 0) → 1 extra level applied
    assert.equal(plan.canIncludeExtra, true);
  });

  it("caps the extra range at the map's max zoom rather than a fixed 22", () => {
    // baseZoom 22, map max 24 → only 2 levels are meaningful (22→24), and the
    // slider's upper bound reflects that so every step has an effect (#750).
    const plan = planOfflineZoom(22, 24, true, 5, HARD_MAX);
    assert.equal(plan.maxExtraLevels, 2);
    assert.equal(plan.maxZoom, 24);
  });

  it("caps maxExtraLevels to 1 when only one level separates base from ceiling", () => {
    const plan = planOfflineZoom(23, 24, true, 5, HARD_MAX);
    assert.equal(plan.maxExtraLevels, 1);
    assert.equal(plan.maxZoom, 24);
  });

  it("floors a fractional mapMaxZoom", () => {
    // getMaxZoom() can return a non-integer; floor(24.7) = 24.
    const plan = planOfflineZoom(10, 24.7, true, 3, HARD_MAX);
    assert.equal(plan.maxExtraLevels, HARD_MAX);
    assert.equal(plan.maxZoom, 13);
  });

  it("never produces an inverted range at the map's max zoom (#751)", () => {
    // At zoom 24 of a 24-max map there is nothing deeper to fetch: extra detail
    // is unavailable and the range stays at the base zoom, not a backwards
    // "24–22".
    const plan = planOfflineZoom(24, 24, true, 3, HARD_MAX);
    assert.equal(plan.canIncludeExtra, false);
    assert.equal(plan.baseZoom, 24);
    assert.equal(plan.maxZoom, 24);
    assert.equal(plan.maxExtraLevels, 0);
    assert.ok(plan.maxZoom >= plan.baseZoom);
  });

  it("clamps the base zoom to the map's max zoom", () => {
    // A view zoom above the configured max (shouldn't happen, but guard it)
    // still yields a sane, non-inverted plan.
    const plan = planOfflineZoom(30, 24, false, 1, HARD_MAX);
    assert.equal(plan.baseZoom, 24);
    assert.equal(plan.maxZoom, 24);
    assert.equal(plan.canIncludeExtra, false);
    assert.equal(plan.maxExtraLevels, 0); // no room for extra levels at the ceiling
  });

  it("respects the hard cap on extra levels below the map's max zoom", () => {
    const plan = planOfflineZoom(5, 24, true, 9, HARD_MAX);
    assert.equal(plan.maxExtraLevels, HARD_MAX);
    assert.equal(plan.maxZoom, 5 + HARD_MAX);
  });
});
