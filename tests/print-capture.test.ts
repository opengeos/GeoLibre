import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isFullViewportMapCanvas } from "../apps/geolibre-desktop/src/lib/print-capture";

describe("isFullViewportMapCanvas", () => {
  const base = { width: 1920, height: 1080 };

  it("always keeps the base canvas itself", () => {
    assert.equal(isFullViewportMapCanvas(base, base), true);
  });

  it("keeps a full-size deck.gl overlay canvas", () => {
    assert.equal(isFullViewportMapCanvas({ width: 1920, height: 1080 }, base), true);
  });

  it("keeps a canvas within the 90% size tolerance", () => {
    assert.equal(isFullViewportMapCanvas({ width: 1900, height: 1000 }, base), true);
  });

  it("keeps a canvas exactly at the 90% boundary", () => {
    // The threshold is inclusive (>=): 1920 * 0.9 = 1728, 1080 * 0.9 = 972.
    assert.equal(isFullViewportMapCanvas({ width: 1728, height: 972 }, base), true);
  });

  it("drops a canvas just below the 90% threshold in height", () => {
    // 1920 passes width; 971 < 972 (1080 * 0.9) fails height -> overall false.
    assert.equal(isFullViewportMapCanvas({ width: 1920, height: 971 }, base), false);
  });

  it("drops a small raster colorbar/colormap preview canvas", () => {
    // The raster control renders a horizontal colormap ramp into a small canvas
    // (createLinearGradient(0, 0, width, 0)); stretching it over the page was
    // the bug that filled the whole map with a rainbow gradient.
    assert.equal(isFullViewportMapCanvas({ width: 280, height: 24 }, base), false);
  });

  it("drops a canvas that is wide but short", () => {
    assert.equal(isFullViewportMapCanvas({ width: 1920, height: 24 }, base), false);
  });

  it("drops a canvas that is tall but narrow", () => {
    // 1727 < 1728 (1920 * 0.9) fails width; height passes -> overall false.
    assert.equal(isFullViewportMapCanvas({ width: 1727, height: 1080 }, base), false);
  });

  it("keeps only the base when the base size is unknown", () => {
    const unknownBase = { width: 0, height: 0 };
    // The base itself is still kept (by identity)...
    assert.equal(isFullViewportMapCanvas(unknownBase, unknownBase), true);
    // ...but other canvases are dropped, so a 0x0 base cannot reintroduce the
    // colorbar-clobbering bug.
    assert.equal(isFullViewportMapCanvas({ width: 280, height: 24 }, unknownBase), false);
  });
});
