import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as raster from "maplibre-gl-raster";
import * as mirror from "../apps/geolibre-desktop/src/lib/raster-picker-mirror";

// The style panels read the colormap list and the spectral index presets from a
// hand-kept copy so the maplibre-gl-raster chunk stays off the startup path.
// These compare the copy with the package, so a bump that changes either fails
// here instead of silently offering a stale picker.

describe("raster picker mirror", () => {
  it("matches the package's colormap options", () => {
    assert.deepEqual(mirror.COLORMAP_OPTIONS, raster.COLORMAP_OPTIONS);
  });

  it("matches the package's normalized-difference presets", () => {
    assert.deepEqual(mirror.NORMALIZED_DIFFERENCE_INDICES, raster.NORMALIZED_DIFFERENCE_INDICES);
    assert.deepEqual(mirror.CUSTOM_NORMALIZED_DIFFERENCE, raster.CUSTOM_NORMALIZED_DIFFERENCE);
  });

  it("looks presets up by id like the package", () => {
    for (const id of [undefined, "", "custom", "ndvi", "nbr", "ndsi", "unknown"]) {
      assert.deepEqual(mirror.indexById(id), raster.indexById(id), `id ${String(id)}`);
    }
  });

  it("guesses band roles like the package", () => {
    const bandSets: (Map<number, string> | null)[] = [
      null,
      new Map(),
      new Map([
        [1, "B02"],
        [2, "B03"],
        [3, "B04"],
        [4, "B08"],
        [5, "B11"],
        [6, "B12"],
      ]),
      new Map([
        [1, "Red"],
        [2, "Green"],
        [3, "Blue"],
        [4, "Near Infrared"],
        [5, "SWIR 1"],
        [6, "swir_2"],
      ]),
      new Map([
        [1, "band_1"],
        [2, "elevation"],
      ]),
    ];
    const roles = ["Red", "Green", "Blue", "NIR", "SWIR1", "SWIR2", "Band A", "elevation"];
    for (const bands of bandSets) {
      for (const role of roles) {
        assert.equal(
          mirror.guessBandForRole(role, bands),
          raster.guessBandForRole(role, bands),
          `role ${role} in ${JSON.stringify(bands ? [...bands] : bands)}`,
        );
      }
    }
  });
});
