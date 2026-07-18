import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_LAYER_STYLE,
  lineWidthValue,
  metersWidthExpression,
  type LayerStyle,
} from "@geolibre/core";
import { linePaint } from "../packages/map/src/style-mapper";

function style(patch: Partial<LayerStyle> = {}): LayerStyle {
  return { ...DEFAULT_LAYER_STYLE, ...patch };
}

// Ground resolution (m/px) at zoom 0 on the equator for the 512px Web Mercator
// world — must match the constant used inside style-mapper.
const METERS_PER_PIXEL_AT_ZOOM_0 = (2 * Math.PI * 6378137) / 512;

describe("strokeWidthUnit default", () => {
  it("defaults to pixels", () => {
    assert.equal(DEFAULT_LAYER_STYLE.strokeWidthUnit, "pixels");
  });
});

describe("linePaint with pixel stroke width (default)", () => {
  it("emits a constant numeric width", () => {
    assert.equal(linePaint(style({ strokeWidth: 4 }), 1)["line-width"], 4);
  });
});

describe("linePaint with meter stroke width", () => {
  it("emits a zoom-driven exponential interpolation", () => {
    const meters = 100;
    const paint = linePaint(style({ strokeWidth: meters, strokeWidthUnit: "meters" }), 1);
    const widthAtZoom0 = meters / METERS_PER_PIXEL_AT_ZOOM_0;
    assert.deepEqual(paint["line-width"], [
      "interpolate",
      ["exponential", 2],
      ["zoom"],
      0,
      widthAtZoom0,
      24,
      widthAtZoom0 * 2 ** 24,
    ]);
  });

  it("ignores per-feature simplestyle stroke-width in meters mode", () => {
    const paint = linePaint(
      style({ strokeWidth: 50, strokeWidthUnit: "meters", simpleStyleEnabled: true }),
      1,
    );
    // A pixel-based per-feature override would surface as a ["to-number", ...]
    // expression; meters mode must instead keep the scale-proportional one.
    assert.equal((paint["line-width"] as unknown[])[0], "interpolate");
  });
});

describe("lineWidthValue (shared by map + geo-editor plugin)", () => {
  it("returns a constant pixel width by default", () => {
    assert.equal(lineWidthValue(style({ strokeWidth: 3 })), 3);
  });

  it("returns the per-feature simplestyle override when enabled (pixels)", () => {
    assert.deepEqual(lineWidthValue(style({ strokeWidth: 3, simpleStyleEnabled: true })), [
      "to-number",
      ["get", "stroke-width"],
      3,
    ]);
  });

  it("returns the meters expression in meters mode, ignoring simplestyle", () => {
    const value = lineWidthValue(
      style({ strokeWidth: 80, strokeWidthUnit: "meters", simpleStyleEnabled: true }),
    ) as unknown[];
    assert.equal(value[0], "interpolate");
    assert.deepEqual(value, metersWidthExpression(80));
  });
});

describe("metersWidthExpression", () => {
  it("scales the width so it doubles each zoom level (Web Mercator)", () => {
    const expr = metersWidthExpression(METERS_PER_PIXEL_AT_ZOOM_0) as unknown[];
    // First stop: zoom level 0 (expr[3]) with a 1px width (expr[4]), because the
    // input meters == MERCATOR_METERS_PER_PIXEL_AT_ZOOM_0 by construction.
    assert.equal(expr[3], 0);
    assert.equal(expr[4], 1);
    // Last stop: zoom level 24 (expr[5]) with a 2^24 px width (expr[6]).
    assert.equal(expr[5], 24);
    assert.equal(expr[6], 2 ** 24);
  });
});
