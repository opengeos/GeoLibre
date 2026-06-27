import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { layerControlPaintToStyle } from "../packages/map/src/map-controller";

// The layer control's per-layer style editor edits MapLibre paint properties
// directly. layerControlPaintToStyle maps the raster color adjustments back to
// the store's LayerStyle so the floating editor and the right-hand Style
// sidebar stay in sync (issue #912). Vector paint is intentionally not mapped:
// GeoLibre renders vector layers through an expression-based style model, so
// the rendered values the control reports would not round-trip losslessly.
describe("layerControlPaintToStyle", () => {
  it("maps the raster color adjustments (the #912 case)", () => {
    assert.deepEqual(layerControlPaintToStyle("raster-brightness-min", -0.3), {
      rasterBrightnessMin: -0.3,
    });
    assert.deepEqual(layerControlPaintToStyle("raster-brightness-max", 0.4), {
      rasterBrightnessMax: 0.4,
    });
    assert.deepEqual(layerControlPaintToStyle("raster-saturation", 0.5), {
      rasterSaturation: 0.5,
    });
    assert.deepEqual(layerControlPaintToStyle("raster-contrast", -0.2), {
      rasterContrast: -0.2,
    });
    assert.deepEqual(layerControlPaintToStyle("raster-hue-rotate", 120), {
      rasterHueRotate: 120,
    });
  });

  it("returns null for raster-opacity (handled as layer-level opacity, not style)", () => {
    assert.equal(layerControlPaintToStyle("raster-opacity", 0.6), null);
  });

  it("returns null for vector paint (not round-tripped into the expression-based model)", () => {
    // Colors, widths/radii, and fill/circle opacity all depend on the layer's
    // style mode (vectorStyleMode, proportional sizing, meters width unit,
    // simplestyle, opacity scaling), so the rendered value is not the raw style
    // value. These are left to the sidebar Style panel.
    assert.equal(layerControlPaintToStyle("fill-color", "#ff0000"), null);
    assert.equal(layerControlPaintToStyle("line-color", "#0000ff"), null);
    assert.equal(layerControlPaintToStyle("circle-color", "#00ff00"), null);
    assert.equal(layerControlPaintToStyle("fill-opacity", 0.5), null);
    assert.equal(layerControlPaintToStyle("circle-opacity", 0.4), null);
    assert.equal(layerControlPaintToStyle("line-width", 3), null);
    assert.equal(layerControlPaintToStyle("circle-radius", 8), null);
    assert.equal(layerControlPaintToStyle("text-color", "#222222"), null);
  });

  it("returns null for unknown properties and non-numeric values", () => {
    assert.equal(layerControlPaintToStyle("unknown-prop", 1), null);
    assert.equal(layerControlPaintToStyle("line-blur", 2), null);
    // A raster slider property given a non-number is dropped rather than
    // written through with a bad value.
    assert.equal(layerControlPaintToStyle("raster-brightness-max", "0.4"), null);
  });
});
