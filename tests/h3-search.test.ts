import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseH3Cell } from "../apps/geolibre-desktop/src/lib/h3-search";

/** A resolution-9 cell over San Francisco, used across the cases below. */
const SF_HEX = "8928308280fffff";
/** The same cell written as an unsigned 64-bit integer. */
const SF_DECIMAL = "617700169958293503";
const SF_LAT = 37.7767;
const SF_LON = -122.4185;

describe("parseH3Cell — hexadecimal spelling", () => {
  it("resolves a cell index to its center and resolution", () => {
    const cell = parseH3Cell(SF_HEX);
    assert.ok(cell);
    assert.equal(cell.cell, SF_HEX);
    assert.equal(cell.resolution, 9);
    assert.ok(Math.abs(cell.lat - SF_LAT) < 1e-3);
    assert.ok(Math.abs(cell.lon - SF_LON) < 1e-3);
  });

  it("accepts surrounding whitespace, uppercase, and a 0x prefix", () => {
    for (const input of [`  ${SF_HEX}  `, SF_HEX.toUpperCase(), `0x${SF_HEX}`, `0X${SF_HEX}`]) {
      assert.equal(parseH3Cell(input)?.cell, SF_HEX, `failed for ${input}`);
    }
  });

  it("returns a closed boundary ring in [lon, lat] order", () => {
    const cell = parseH3Cell(SF_HEX);
    assert.ok(cell);
    // Seven positions: a hexagon's six vertices plus the repeated first one.
    assert.equal(cell.boundary.length, 7);
    assert.deepEqual(cell.boundary[0], cell.boundary[6]);
    for (const [lon, lat] of cell.boundary) {
      assert.ok(Math.abs(lon - SF_LON) < 0.01, `lon ${lon} far from the center`);
      assert.ok(Math.abs(lat - SF_LAT) < 0.01, `lat ${lat} far from the center`);
    }
  });

  it("resolves the coarsest and finest resolutions", () => {
    assert.equal(parseH3Cell("8029fffffffffff")?.resolution, 0);
    assert.equal(parseH3Cell("8f283090b366214")?.resolution, 15);
  });
});

describe("parseH3Cell — integer spelling", () => {
  it("resolves the unsigned 64-bit form to the same cell as the hex form", () => {
    const fromDecimal = parseH3Cell(SF_DECIMAL);
    assert.ok(fromDecimal);
    assert.deepEqual(fromDecimal, parseH3Cell(SF_HEX));
  });

  it("rejects an integer beyond the unsigned 64-bit range", () => {
    assert.equal(parseH3Cell("18446744073709551616"), null);
  });

  it("rejects zero and a plain small number", () => {
    assert.equal(parseH3Cell("0"), null);
    assert.equal(parseH3Cell("12345"), null);
  });
});

describe("parseH3Cell — rejections", () => {
  it("rejects empty and non-index text", () => {
    for (const input of ["", "   ", "San Francisco", "-1", "1.5", "8928308280ffffz"]) {
      assert.equal(parseH3Cell(input), null, `expected null for ${JSON.stringify(input)}`);
    }
  });

  it("rejects a lat/lon pair so the coordinate parser still owns it", () => {
    assert.equal(parseH3Cell("37.7767, -122.4185"), null);
  });

  it("rejects a valid-looking hex string that is not a cell index", () => {
    // A directed-edge index (mode 2), which is a real H3 index but not a cell.
    assert.equal(parseH3Cell("115283473fffffff"), null);
    // Right length, but the mode and reserved bits are wrong.
    assert.equal(parseH3Cell("000000000000000"), null);
  });

  it("does not read a 0x-prefixed string as a decimal integer", () => {
    assert.equal(parseH3Cell(`0x${SF_DECIMAL}`), null);
  });
});

describe("parseH3Cell — antimeridian", () => {
  it("returns a contiguous ring for a cell crossing the antimeridian", () => {
    // A resolution-5 cell centered on the antimeridian near the equator; its
    // raw h3-js ring spans nearly 360 degrees of longitude.
    const cell = parseH3Cell("857eb1c3fffffff");
    assert.ok(cell);
    const longitudes = cell.boundary.map(([lon]) => lon);
    const span = Math.max(...longitudes) - Math.min(...longitudes);
    assert.ok(span < 180, `ring wraps the world: span ${span}`);
  });
});
