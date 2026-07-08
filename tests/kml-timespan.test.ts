import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseKmlDate } from "../apps/geolibre-desktop/src/lib/kml";

describe("parseKmlDate", () => {
  it("parses a full dateTime to epoch ms", () => {
    assert.equal(parseKmlDate("2020-01-01T00:00:00Z"), Date.UTC(2020, 0, 1));
  });

  it("parses a plain date", () => {
    assert.equal(parseKmlDate("2020-01-02"), Date.parse("2020-01-02"));
  });

  it("normalizes a bare year to Jan 1 of that year", () => {
    // Without normalization some engines read "2020" as a millisecond count.
    assert.equal(parseKmlDate("2020"), Date.parse("2020-01-01"));
  });

  it("clamps Google Earth's YYYY-MM-00 month granularity to the 1st", () => {
    // Google Earth Pro exports month-level dates as `2011-01-00`, which is not
    // valid ISO and would otherwise parse to NaN (the Flood.kmz case).
    assert.equal(parseKmlDate("2011-01-00"), Date.parse("2011-01-01"));
    assert.equal(parseKmlDate("2011-07-00"), Date.parse("2011-07-01"));
    assert.equal(parseKmlDate("2011-00-00"), Date.parse("2011-01-01"));
  });

  it("parses a year-month value", () => {
    assert.equal(parseKmlDate("2011-07"), Date.parse("2011-07-01"));
  });

  it("trims surrounding whitespace", () => {
    assert.equal(parseKmlDate("  2020-01-02  "), Date.parse("2020-01-02"));
  });

  it("returns null for missing or unparseable input", () => {
    assert.equal(parseKmlDate(undefined), null);
    assert.equal(parseKmlDate(""), null);
    assert.equal(parseKmlDate("not-a-date"), null);
  });

  it("orders sequential frame dates ascending", () => {
    const a = parseKmlDate("2020-01-01");
    const b = parseKmlDate("2020-01-02");
    const c = parseKmlDate("2020-01-03");
    assert.ok(a !== null && b !== null && c !== null);
    assert.ok((a as number) < (b as number) && (b as number) < (c as number));
  });
});
