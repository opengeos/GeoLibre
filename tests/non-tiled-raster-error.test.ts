import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isNonTiledRasterError,
  isRecoverableNonTiledRasterError,
} from "../packages/plugins/src/plugins/non-tiled-raster-error";

describe("non-tiled raster error detection", () => {
  it("matches the upstream striped-GeoTIFF message", () => {
    assert.equal(isNonTiledRasterError(new Error("COG is not tiled")), true);
    // The control has been observed to vary the casing around the phrase.
    assert.equal(isNonTiledRasterError(new Error("Image is NOT TILED")), true);
  });

  it("does not match unrelated raster failures", () => {
    assert.equal(isNonTiledRasterError(new Error("Failed to fetch")), false);
    assert.equal(isNonTiledRasterError(new Error("Unsupported compression")), false);
    assert.equal(isNonTiledRasterError(null), false);
    assert.equal(isNonTiledRasterError(undefined), false);
  });

  it("treats only a non-tiled Error rejection as recoverable", () => {
    // A striped GeoTIFF keeps its layer: the non-tiled handler converts it to a
    // COG, so the project importers must not roll it back or warn about it.
    assert.equal(isRecoverableNonTiledRasterError(new Error("not tiled")), true);
    // Anything else is a real failure, so the importer rolls the layer back and
    // reports it -- otherwise the layer list and the warning dialog disagree
    // (GeoLibre#1637: NLCD rasters listed as unsupported while still on the map).
    assert.equal(isRecoverableNonTiledRasterError(new Error("Failed to fetch")), false);
  });

  it("ignores non-Error rejections that merely contain the phrase", () => {
    // A bare string cannot carry the control's error contract, so it is not
    // assumed to be the recoverable case.
    assert.equal(isRecoverableNonTiledRasterError("not tiled"), false);
    assert.equal(isRecoverableNonTiledRasterError(undefined), false);
  });
});
