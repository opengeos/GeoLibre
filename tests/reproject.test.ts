import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mercatorLatDeg,
  remapRowsToMercator,
  tileGeoBounds,
  wmsBboxFor,
} from "../workers/tiles/src/reproject";

// The Web-Mercator latitude clamp (the top/bottom of the tile pyramid).
const MERC_MAX_LAT = 85.0511287798066;

describe("mercatorLatDeg", () => {
  it("maps the vertical extremes to ±85.05° and the middle to the equator", () => {
    assert.ok(Math.abs(mercatorLatDeg(0) - MERC_MAX_LAT) < 1e-9);
    assert.ok(Math.abs(mercatorLatDeg(1) + MERC_MAX_LAT) < 1e-9);
    assert.ok(Math.abs(mercatorLatDeg(0.5)) < 1e-9);
  });

  it("is monotonically decreasing north→south", () => {
    let prev = Infinity;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const lat = mercatorLatDeg(t);
      assert.ok(lat < prev, `lat should decrease as t grows (t=${t})`);
      prev = lat;
    }
  });
});

describe("tileGeoBounds", () => {
  it("covers the whole world at z0", () => {
    const b = tileGeoBounds({ z: 0, x: 0, y: 0 });
    assert.equal(b.lonW, -180);
    assert.equal(b.lonE, 180);
    assert.ok(Math.abs(b.latN - MERC_MAX_LAT) < 1e-9);
    assert.ok(Math.abs(b.latS + MERC_MAX_LAT) < 1e-9);
  });

  it("splits longitude evenly and puts the equator on the z1 seam", () => {
    const nw = tileGeoBounds({ z: 1, x: 0, y: 0 });
    assert.equal(nw.lonW, -180);
    assert.equal(nw.lonE, 0);
    // The horizontal seam between the two z1 rows is the equator.
    assert.ok(Math.abs(nw.latS) < 1e-9);
    const se = tileGeoBounds({ z: 1, x: 1, y: 1 });
    assert.equal(se.lonW, 0);
    assert.equal(se.lonE, 180);
    assert.ok(Math.abs(se.latN) < 1e-9);
  });
});

describe("wmsBboxFor", () => {
  it("emits WMS 1.1.1 EPSG:4326 order (minLon,minLat,maxLon,maxLat)", () => {
    const bbox = wmsBboxFor({ lonW: -90, lonE: 0, latN: 66.5, latS: 0 });
    assert.equal(bbox, "-90,0,0,66.5");
  });
});

describe("remapRowsToMercator", () => {
  const SIZE = 8;

  // Build an equirectangular source whose red channel encodes the row index, so
  // we can assert which source row each output row was drawn from.
  function rowGradient(size: number): Uint8Array {
    const src = new Uint8Array(size * size * 4);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const i = (r * size + c) * 4;
        src[i] = r; // red = source row
        src[i + 1] = c; // green = column (must be preserved 1:1)
        src[i + 3] = 255;
      }
    }
    return src;
  }

  it("preserves columns 1:1 and keeps output rows within the source", () => {
    const tile = { z: 0, x: 0, y: 0 };
    const bounds = tileGeoBounds(tile);
    const out = remapRowsToMercator(rowGradient(SIZE), SIZE, tile, bounds);
    for (let py = 0; py < SIZE; py++) {
      for (let c = 0; c < SIZE; c++) {
        const i = (py * SIZE + c) * 4;
        assert.equal(out[i + 1], c, "column (green) must be untouched");
        assert.ok(out[i] >= 0 && out[i] < SIZE, "source row in range");
      }
    }
  });

  it("draws top output rows from top source rows (monotonic remap)", () => {
    const tile = { z: 0, x: 0, y: 0 };
    const bounds = tileGeoBounds(tile);
    const out = remapRowsToMercator(rowGradient(SIZE), SIZE, tile, bounds);
    let prev = -1;
    for (let py = 0; py < SIZE; py++) {
      const row = out[py * SIZE * 4]; // red = source row for column 0
      assert.ok(row >= prev, "source row index must not decrease downward");
      prev = row;
    }
    // First output row samples the northern edge, last samples the southern.
    assert.equal(out[0], 0);
    assert.equal(out[(SIZE - 1) * SIZE * 4], SIZE - 1);
  });

  it("pulls the equatorial band toward the tile centre under Mercator", () => {
    // A z0 tile stretches the poles, so the middle output rows come from source
    // rows near the middle — i.e. row remapping is non-identity at the extremes.
    const tile = { z: 0, x: 0, y: 0 };
    const bounds = tileGeoBounds(tile);
    const out = remapRowsToMercator(rowGradient(SIZE), SIZE, tile, bounds);
    const mid = SIZE / 2;
    const midSourceRow = out[mid * SIZE * 4];
    assert.ok(
      Math.abs(midSourceRow - mid) <= 1,
      "the tile centre maps to the source centre (the equator)",
    );
  });
});
