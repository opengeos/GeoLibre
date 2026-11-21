import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatAttributeCellText,
  numericColumnSet,
} from "../apps/geolibre-desktop/src/lib/attribute-columns";

describe("formatAttributeCellText", () => {
  it("rounds float noise for display", () => {
    assert.equal(formatAttributeCellText(0.1 + 0.2, "en"), "0.3");
    assert.equal(formatAttributeCellText(1.1 * 3, "en"), "3.3");
    assert.equal(formatAttributeCellText(-42.5, "en"), "-42.5");
  });

  it("keeps meaningful small and long fractions", () => {
    assert.equal(formatAttributeCellText(0.0000025, "en"), "0.0000025");
    assert.equal(formatAttributeCellText(1 / 3, "en"), "0.333333333333333");
  });

  it("prints every digit of an integer", () => {
    assert.equal(formatAttributeCellText(0, "en"), "0");
    assert.equal(formatAttributeCellText(9007199254740991, "en"), "9007199254740991");
    assert.equal(formatAttributeCellText(1_000_000_000_000, "en"), "1000000000000");
  });

  it("does not group digits, so years and IDs read as stored", () => {
    assert.equal(formatAttributeCellText(2024, "en"), "2024");
    assert.equal(formatAttributeCellText(42001, "de"), "42001");
    assert.equal(formatAttributeCellText(1234567.891, "en"), "1234567.891");
  });

  it("uses the locale's decimal separator", () => {
    assert.equal(formatAttributeCellText(1234567.891, "de"), "1234567,891");
    assert.equal(formatAttributeCellText(1234.5, "fr"), "1234,5");
  });

  it("shows negative zero as 0", () => {
    assert.equal(formatAttributeCellText(-0, "en"), "0");
  });

  it("keeps the integer digits of fractional values from 1e15 up", () => {
    // 15 significant digits would print 1234567890123460.
    assert.equal(formatAttributeCellText(1234567890123456.7, "en"), "1234567890123457");
    assert.equal(formatAttributeCellText(-1234567890123456.7, "en"), "-1234567890123457");
    // Below 1e15 the fraction keeps whatever of the 15 digits are left.
    assert.equal(formatAttributeCellText(12345678901234.56, "en"), "12345678901234.6");
  });

  it("falls back to the default locale for an unknown tag", () => {
    assert.equal(
      formatAttributeCellText(1234.5, "cimode"),
      new Intl.NumberFormat(undefined, { useGrouping: false }).format(1234.5),
    );
  });

  it("returns null for null and missing values, but keeps an empty string", () => {
    assert.equal(formatAttributeCellText(null, "en"), null);
    assert.equal(formatAttributeCellText(undefined, "en"), null);
    assert.equal(formatAttributeCellText("", "en"), "");
  });

  it("passes non-numeric values through unchanged", () => {
    assert.equal(formatAttributeCellText("0.30000000000000004", "en"), "0.30000000000000004");
    assert.equal(formatAttributeCellText("1234567", "en"), "1234567");
    assert.equal(formatAttributeCellText(true, "en"), "true");
    assert.equal(formatAttributeCellText({ a: 1 }, "en"), '{"a":1}');
    assert.equal(formatAttributeCellText([1, 2], "en"), "[1,2]");
  });

  it("leaves non-finite numbers unformatted", () => {
    assert.equal(formatAttributeCellText(Number.NaN, "en"), "NaN");
    assert.equal(formatAttributeCellText(Number.POSITIVE_INFINITY, "en"), "Infinity");
  });
});

describe("numericColumnSet", () => {
  const rows = [
    { properties: { id: null, area: null, name: "Alpha", code: "00123", empty: null } },
    { properties: { id: 7, area: 0.5, name: "Beta", code: 42 } },
    { properties: { id: 8, name: null, code: "0042", empty: null } },
  ];

  it("types each column by its first non-null value", () => {
    assert.deepEqual(
      [...numericColumnSet(rows, ["id", "area", "name", "code", "empty", "missing"])].sort(),
      ["area", "id"],
    );
  });

  it("only looks at the requested columns", () => {
    assert.deepEqual([...numericColumnSet(rows, ["name", "area"])], ["area"]);
    assert.equal(numericColumnSet(rows, []).size, 0);
    assert.equal(numericColumnSet([], ["id"]).size, 0);
  });
});
