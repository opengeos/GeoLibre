import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getVectorColorRamp } from "@geolibre/core";
import {
  colormapColors,
  normalizeRampColor,
  warmColormapColors,
} from "../packages/plugins/src/plugins/colormap-colors";

describe("colormapColors", () => {
  it("returns a built-in ramp's exact colors synchronously", () => {
    assert.deepEqual(colormapColors("viridis"), getVectorColorRamp("viridis").colors);
  });

  it("returns null for a sprite colormap that has not been sampled", () => {
    // 'ylorbr' is a renderer sprite colormap, not one of GeoLibre's built-ins.
    assert.equal(colormapColors("ylorbr"), null);
  });
});

describe("warmColormapColors", () => {
  it("resolves a built-in ramp immediately to its colors", async () => {
    assert.deepEqual(await warmColormapColors("plasma"), getVectorColorRamp("plasma").colors);
  });

  it("yields null when sampling is unavailable (no DOM canvas)", async () => {
    // Under node --test there is no document, so sprite sampling returns [].
    assert.equal(await warmColormapColors("ylorbr"), null);
  });
});

describe("normalizeRampColor", () => {
  it("converts the sprite sampler's rgb() stops to hex", () => {
    // What `sampleColormapStops` actually returns for a sprite colormap. Left as
    // rgb() it parses to black in every hex-based consumer.
    assert.equal(normalizeRampColor("rgb(0, 128, 255)"), "#0080ff");
    assert.equal(normalizeRampColor("rgb(255,255,255)"), "#ffffff");
  });

  it("reads an rgba() stop, dropping the alpha", () => {
    assert.equal(normalizeRampColor("rgba(17, 34, 51, 0.5)"), "#112233");
  });

  it("clamps out-of-range and rounds fractional channels", () => {
    assert.equal(normalizeRampColor("rgb(-5, 127.6, 300)"), "#0080ff");
  });

  it("passes a hex stop through untouched", () => {
    assert.equal(normalizeRampColor("#440154"), "#440154");
  });

  it("passes a malformed numeric channel through rather than emitting #NaN", () => {
    assert.equal(normalizeRampColor("rgb(., 0, 0)"), "rgb(., 0, 0)");
    assert.equal(normalizeRampColor("rgb(1..2, 0, 0)"), "rgb(1..2, 0, 0)");
  });

  it("passes an unrecognized stop through rather than blanking it", () => {
    assert.equal(normalizeRampColor("rebeccapurple"), "rebeccapurple");
  });
});
