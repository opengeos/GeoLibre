import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatAttributeCellText } from "../apps/geolibre-desktop/src/lib/attribute-columns";

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
    assert.equal(formatAttributeCellText(9007199254740991, "en"), "9,007,199,254,740,991");
    assert.equal(formatAttributeCellText(1_000_000_000_000, "en"), "1,000,000,000,000");
  });

  it("groups and separates with the given locale", () => {
    assert.equal(formatAttributeCellText(1234567.891, "en"), "1,234,567.891");
    assert.equal(formatAttributeCellText(1234567.891, "de"), "1.234.567,891");
    // French groups with a narrow no-break space.
    assert.equal(formatAttributeCellText(1234.5, "fr"), "1 234,5");
  });

  it("falls back to the default locale for an unknown tag", () => {
    assert.equal(
      formatAttributeCellText(1234.5, "cimode"),
      new Intl.NumberFormat(undefined).format(1234.5),
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
