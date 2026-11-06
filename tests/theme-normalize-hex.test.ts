import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  foregroundForHex,
  normalizeHexColor,
  prefersLightForeground,
} from "../apps/geolibre-desktop/src/lib/theme-schemes";

describe("normalizeHexColor", () => {
  it("accepts 6-digit hex with or without a leading #", () => {
    assert.equal(normalizeHexColor("#D58400"), "#d58400");
    assert.equal(normalizeHexColor("D58400"), "#d58400");
  });

  it("expands 3-digit shorthand to its six lowercase digits", () => {
    assert.equal(normalizeHexColor("#0f0"), "#00ff00");
    assert.equal(normalizeHexColor("abc"), "#aabbcc");
    // Uppercase, no leading # — exercises both the case-insensitive match and
    // the lowercasing of the expanded result.
    assert.equal(normalizeHexColor("ABC"), "#aabbcc");
  });

  it("tolerates surrounding whitespace", () => {
    assert.equal(normalizeHexColor("  #3B82F6  "), "#3b82f6");
    // No leading # exercises the branch that prepends one after trimming.
    assert.equal(normalizeHexColor("  D58400  "), "#d58400");
  });

  it("returns null for anything that is not a valid 3- or 6-digit hex", () => {
    // `#1234` is the CSS Color 4 RGBA shorthand — valid in CSS, but this app
    // only renders 3- or 6-digit hex, so it must be rejected here.
    for (const bad of ["", "   ", "#", "nothex", "#12", "#1234", "#12345", "#1234567", "ggg"]) {
      assert.equal(normalizeHexColor(bad), null, `expected null for ${bad}`);
    }
  });
});

describe("prefersLightForeground", () => {
  it("wants light text on dark colours and dark text on light ones", () => {
    assert.equal(prefersLightForeground("#0d1b2a"), true);
    assert.equal(prefersLightForeground("#000"), true);
    assert.equal(prefersLightForeground("#ffffff"), false);
    assert.equal(prefersLightForeground("#e5e7eb"), false);
  });

  it("has no answer for a value that is not a hex colour", () => {
    assert.equal(prefersLightForeground("navy"), null);
    assert.equal(prefersLightForeground(""), null);
  });

  it("keeps foregroundForHex's answers, white for invalid input included", () => {
    assert.equal(foregroundForHex("#0d1b2a"), "0 0% 100%");
    assert.equal(foregroundForHex("#ffffff"), "222.2 47.4% 11.2%");
    assert.equal(foregroundForHex("navy"), "0 0% 100%");
  });
});
