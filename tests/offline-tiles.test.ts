import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  countTiles,
  enumerateTiles,
  expandTileUrl,
  lngLatToTile,
  tileRangeForBbox,
  tileToQuadkey,
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
