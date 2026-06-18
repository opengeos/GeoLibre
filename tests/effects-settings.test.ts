import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_EFFECTS_SETTINGS,
  HALO_EXTENT_MAX,
  HALO_EXTENT_MIN,
  HALO_OPACITY_MAX,
  HALO_OPACITY_MIN,
  normalizeEffectsSettings,
} from "../packages/plugins/src/plugins/maplibre-effects";

describe("normalizeEffectsSettings", () => {
  it("returns the defaults for undefined/empty input", () => {
    assert.deepEqual(normalizeEffectsSettings(undefined), DEFAULT_EFFECTS_SETTINGS);
    assert.deepEqual(normalizeEffectsSettings({}), DEFAULT_EFFECTS_SETTINGS);
  });

  it("prefixes a missing '#' and lowercases hex", () => {
    const result = normalizeEffectsSettings({
      haloColor: "ff0000",
      spaceColor: "#00FF00",
    });
    assert.equal(result.haloColor, "#ff0000");
    // Uppercase is lowercased so casing can't read as a non-default value.
    assert.equal(result.spaceColor, "#00ff00");
  });

  it("accepts shorthand 3-digit hex", () => {
    assert.equal(normalizeEffectsSettings({ haloColor: "#abc" }).haloColor, "#abc");
  });

  it("falls back to the base color on an invalid hex", () => {
    const result = normalizeEffectsSettings({ haloColor: "not-a-color" });
    assert.equal(result.haloColor, DEFAULT_EFFECTS_SETTINGS.haloColor);
  });

  it("clamps the halo extent and opacity into range", () => {
    assert.equal(normalizeEffectsSettings({ haloExtent: 99 }).haloExtent, HALO_EXTENT_MAX);
    assert.equal(normalizeEffectsSettings({ haloExtent: 0 }).haloExtent, HALO_EXTENT_MIN);
    assert.equal(normalizeEffectsSettings({ haloOpacity: 5 }).haloOpacity, HALO_OPACITY_MAX);
    assert.equal(normalizeEffectsSettings({ haloOpacity: -1 }).haloOpacity, HALO_OPACITY_MIN);
  });

  it("ignores non-finite numbers, keeping the base value", () => {
    const result = normalizeEffectsSettings({
      haloExtent: Number.NaN,
      haloOpacity: Infinity,
    });
    assert.equal(result.haloExtent, DEFAULT_EFFECTS_SETTINGS.haloExtent);
    assert.equal(result.haloOpacity, DEFAULT_EFFECTS_SETTINGS.haloOpacity);
  });

  it("merges onto a supplied base instead of the defaults", () => {
    const base = {
      haloColor: "#111111",
      haloExtent: 2,
      haloOpacity: 0.5,
      spaceColor: "#222222",
    };
    const result = normalizeEffectsSettings({ haloExtent: 3 }, base);
    assert.equal(result.haloExtent, 3);
    assert.equal(result.haloColor, "#111111");
    assert.equal(result.spaceColor, "#222222");
    assert.equal(result.haloOpacity, 0.5);
  });
});
