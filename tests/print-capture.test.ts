import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isFullViewportMapCanvas } from "../apps/geolibre-desktop/src/lib/print-capture";

describe("isFullViewportMapCanvas", () => {
  const base = { width: 1920, height: 1080 };

  it("always keeps the base canvas itself", () => {
    assert.equal(isFullViewportMapCanvas(base, base), true);
  });

  it("keeps a full-size deck.gl overlay canvas", () => {
    assert.equal(
      isFullViewportMapCanvas({ width: 1920, height: 1080 }, base),
      true,
    );
  });

  it("keeps a canvas within the 90% size tolerance", () => {
    assert.equal(
      isFullViewportMapCanvas({ width: 1900, height: 1000 }, base),
      true,
    );
  });

  it("drops a small raster colorbar/colormap preview canvas", () => {
    // The raster control renders a horizontal colormap ramp into a small canvas
    // (createLinearGradient(0, 0, width, 0)); stretching it over the page was
    // the bug that filled the whole map with a rainbow gradient.
    assert.equal(
      isFullViewportMapCanvas({ width: 280, height: 24 }, base),
      false,
    );
  });

  it("drops a canvas that is wide but short", () => {
    assert.equal(
      isFullViewportMapCanvas({ width: 1920, height: 24 }, base),
      false,
    );
  });

  it("is permissive when the base size is unknown", () => {
    assert.equal(
      isFullViewportMapCanvas({ width: 280, height: 24 }, { width: 0, height: 0 }),
      true,
    );
  });
});
