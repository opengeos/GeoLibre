import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TRANSPARENT_COLOR, isTransparentColor } from "@geolibre/ui";

// The ColorField component itself is DOM-bound and cannot run in the
// node --test environment, but its transparent-value contract is pure: the
// store carries the `transparent` keyword and `isTransparentColor` is what
// every consumer (paint mapping, the swatch toggle) keys off of.
describe("isTransparentColor", () => {
  it("matches the TRANSPARENT_COLOR sentinel", () => {
    assert.equal(isTransparentColor(TRANSPARENT_COLOR), true);
  });

  it("is case-insensitive and ignores surrounding whitespace", () => {
    assert.equal(isTransparentColor("  Transparent "), true);
    assert.equal(isTransparentColor("TRANSPARENT"), true);
  });

  it("rejects opaque hex colors and empty values", () => {
    assert.equal(isTransparentColor("#3b82f6"), false);
    assert.equal(isTransparentColor("#000000"), false);
    assert.equal(isTransparentColor(""), false);
    // Not the CSS keyword, just a substring — must not match.
    assert.equal(isTransparentColor("semitransparent"), false);
  });
});
