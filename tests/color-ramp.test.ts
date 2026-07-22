import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createGraduatedClassBreaks,
  interpolateColors,
  normalizeHexColor,
  parseHexColorList,
} from "../packages/core/src/color-ramp";

describe("normalizeHexColor", () => {
  it("canonicalizes valid 3- and 6-digit hex, with or without #", () => {
    assert.equal(normalizeHexColor("#FF0000"), "#ff0000");
    assert.equal(normalizeHexColor("00ff00"), "#00ff00");
    assert.equal(normalizeHexColor("  #AaBbCc "), "#aabbcc");
    assert.equal(normalizeHexColor("#f00"), "#ff0000");
    assert.equal(normalizeHexColor("abc"), "#aabbcc");
  });

  it("returns null for malformed input", () => {
    assert.equal(normalizeHexColor(""), null);
    assert.equal(normalizeHexColor("#ff"), null);
    assert.equal(normalizeHexColor("#ggffaa"), null);
    assert.equal(normalizeHexColor("red"), null);
    assert.equal(normalizeHexColor("#12345"), null);
  });
});

describe("parseHexColorList", () => {
  it("splits on commas, semicolons, and whitespace and drops invalid tokens", () => {
    assert.deepEqual(parseHexColorList("#ff0000, #00ff00 #0000ff"), [
      "#ff0000",
      "#00ff00",
      "#0000ff",
    ]);
    assert.deepEqual(parseHexColorList("ff0000; not-a-color\n#0f0"), ["#ff0000", "#00ff00"]);
    assert.deepEqual(parseHexColorList("   "), []);
  });

  it("preserves order and keeps duplicates", () => {
    assert.deepEqual(parseHexColorList("#000, #000, #fff"), ["#000000", "#000000", "#ffffff"]);
  });
});

describe("interpolateColors", () => {
  it("returns the two endpoints and a midpoint for a 2-color ramp", () => {
    assert.deepEqual(interpolateColors(["#000000", "#ffffff"], 3), [
      "#000000",
      "#808080",
      "#ffffff",
    ]);
  });

  it("returns the last color when count <= 1", () => {
    assert.deepEqual(interpolateColors(["#111111", "#222222"], 1), ["#222222"]);
  });

  it("repeats a single anchor color across the requested count", () => {
    assert.deepEqual(interpolateColors(["#abcdef"], 3), ["#abcdef", "#abcdef", "#abcdef"]);
  });
});

describe("createGraduatedClassBreaks", () => {
  // The 13 `nb_dentist` values from the layer reported in discussion #1384.
  const DENTISTS = [262, 1157, 1331, 1404, 1977, 2040, 2815, 3621, 3643, 4166, 4409, 4983, 9133];

  it("puts quantile breaks at the class boundaries, not the ramp edges", () => {
    // 4 classes cut the sorted sample at the 0/25/50/75th percentiles. Breaks
    // spanning min..max instead (262, 1977, 3643, 9133) leave the top class
    // holding only the single largest feature.
    assert.deepEqual(createGraduatedClassBreaks(DENTISTS, 4, "quantile"), [262, 1404, 2815, 4166]);
  });

  it("splits the value range evenly for equal interval, leaving the top class open", () => {
    assert.deepEqual(createGraduatedClassBreaks([0, 100], 4, "equal-interval"), [0, 25, 50, 75]);
  });

  it("starts every scheme at the sample minimum", () => {
    for (const scheme of ["equal-interval", "quantile", "natural-breaks"] as const) {
      assert.equal(createGraduatedClassBreaks(DENTISTS, 5, scheme)[0], 262, scheme);
    }
  });

  it("groups natural breaks around the gaps in the data", () => {
    // Jenks isolates the 9133 outlier and keeps the three dense runs together.
    assert.deepEqual(
      createGraduatedClassBreaks(DENTISTS, 4, "natural-breaks"),
      [262, 1977, 3621, 9133],
    );
  });

  it("returns strictly ascending breaks so MapLibre accepts the step expression", () => {
    // A sample with fewer distinct values than classes would otherwise repeat a
    // break, which MapLibre rejects ("input values in strictly ascending order").
    for (const scheme of ["equal-interval", "quantile", "natural-breaks"] as const) {
      const breaks = createGraduatedClassBreaks([1, 1, 1, 5, 5], 6, scheme);
      assert.ok(breaks.length > 0, scheme);
      assert.ok(
        breaks.every((value, index) => index === 0 || value > breaks[index - 1]),
        `${scheme}: ${breaks.join(", ")}`,
      );
    }
  });

  it("returns nothing for an empty sample or a non-positive class count", () => {
    assert.deepEqual(createGraduatedClassBreaks([], 4, "quantile"), []);
    assert.deepEqual(createGraduatedClassBreaks([1, 2, 3], 0, "quantile"), []);
  });
});
