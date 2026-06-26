import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { layerControlPaintToStyle } from "../packages/map/src/map-controller";

// The layer control's per-layer style editor edits MapLibre paint properties
// directly. layerControlPaintToStyle maps those edits back to the store's
// LayerStyle so the floating editor and the right-hand Style sidebar stay in
// sync (issue #912).
describe("layerControlPaintToStyle", () => {
  it("maps the raster color adjustments (the primary #912 case)", () => {
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

  it("maps common vector paint properties to the flat style fields", () => {
    assert.deepEqual(layerControlPaintToStyle("fill-color", "#ff0000"), {
      fillColor: "#ff0000",
    });
    assert.deepEqual(layerControlPaintToStyle("circle-color", "#00ff00"), {
      fillColor: "#00ff00",
    });
    assert.deepEqual(layerControlPaintToStyle("fill-opacity", 0.5), {
      fillOpacity: 0.5,
    });
    // circle-opacity round-trips through fillOpacity (circlePaint derives it
    // from that field), same as fill-opacity.
    assert.deepEqual(layerControlPaintToStyle("circle-opacity", 0.4), {
      fillOpacity: 0.4,
    });
    assert.deepEqual(layerControlPaintToStyle("circle-radius", 8), {
      circleRadius: 8,
    });
    assert.deepEqual(layerControlPaintToStyle("text-color", "#222222"), {
      textColor: "#222222",
    });
  });

  it("maps every strokeColor / strokeWidth alias (switch fall-through)", () => {
    assert.deepEqual(layerControlPaintToStyle("line-color", "#0000ff"), {
      strokeColor: "#0000ff",
    });
    assert.deepEqual(layerControlPaintToStyle("fill-outline-color", "#0000ff"), {
      strokeColor: "#0000ff",
    });
    assert.deepEqual(
      layerControlPaintToStyle("circle-stroke-color", "#0000ff"),
      { strokeColor: "#0000ff" },
    );
    assert.deepEqual(layerControlPaintToStyle("line-width", 3), {
      strokeWidth: 3,
    });
    assert.deepEqual(layerControlPaintToStyle("circle-stroke-width", 2), {
      strokeWidth: 2,
    });
  });

  it("returns null for opacities applied as the layer-level opacity", () => {
    // raster/line/text/icon opacity equal layer.opacity in syncLayer, so they
    // are routed to setLayerOpacity by applyLayerControlStyleChange rather than
    // mapped to a LayerStyle field here.
    assert.equal(layerControlPaintToStyle("raster-opacity", 0.6), null);
    assert.equal(layerControlPaintToStyle("line-opacity", 0.6), null);
    assert.equal(layerControlPaintToStyle("text-opacity", 0.6), null);
    assert.equal(layerControlPaintToStyle("icon-opacity", 0.6), null);
  });

  it("returns null for properties GeoLibre's style model does not track", () => {
    assert.equal(layerControlPaintToStyle("line-blur", 2), null);
    assert.equal(layerControlPaintToStyle("unknown-prop", 1), null);
  });

  it("ignores values of the wrong type for a property", () => {
    // A numeric property given a string, or a color given a number, is dropped
    // rather than written through with a bad value.
    assert.equal(layerControlPaintToStyle("raster-brightness-max", "0.4"), null);
    assert.equal(layerControlPaintToStyle("fill-color", 1), null);
  });
});
