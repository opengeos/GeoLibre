import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getVectorColorRamp } from "@geolibre/core";
import {
  colormapColors,
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
