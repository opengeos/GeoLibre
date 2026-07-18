import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
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
