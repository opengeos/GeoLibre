import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_LAYER_STYLE,
  hasSimpleStyleProperties,
  simpleStyleNumberValue,
  vectorCircleColorValue,
  vectorFillColorValue,
  vectorLineColorValue,
  type LayerStyle,
} from "@geolibre/core";
import { circlePaint, fillPaint, linePaint } from "../packages/map/src/style-mapper";

function style(patch: Partial<LayerStyle> = {}): LayerStyle {
  return { ...DEFAULT_LAYER_STYLE, ...patch };
}

function styledCollection(): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [0, 0] },
        properties: {
          fill: "#55ff00",
          "fill-opacity": 0.5,
          stroke: "#55ff00",
          "stroke-width": 5,
        },
      },
    ],
  };
}

describe("hasSimpleStyleProperties", () => {
  it("detects a valid hex color in a simplestyle key", () => {
    assert.equal(hasSimpleStyleProperties(styledCollection()), true);
  });

  it("detects a finite numeric simplestyle key", () => {
    assert.equal(
      hasSimpleStyleProperties({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [0, 0] },
            properties: { "stroke-width": 3 },
          },
        ],
      }),
      true,
    );
  });

  it("ignores non-color strings in color keys", () => {
    assert.equal(
      hasSimpleStyleProperties({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [0, 0] },
            properties: { fill: "not-a-color", stroke: "red-ish" },
          },
        ],
      }),
      false,
    );
  });

  it("returns false for an empty or undefined collection", () => {
    assert.equal(hasSimpleStyleProperties(undefined), false);
    assert.equal(hasSimpleStyleProperties({ type: "FeatureCollection", features: [] }), false);
  });
});

describe("simplestyle color values", () => {
  it("falls back to the flat layer color when disabled", () => {
    assert.equal(vectorFillColorValue(style()), DEFAULT_LAYER_STYLE.fillColor);
    assert.equal(vectorLineColorValue(style()), DEFAULT_LAYER_STYLE.strokeColor);
  });

  it("coalesces the per-feature property over the fallback when enabled", () => {
    assert.deepEqual(vectorFillColorValue(style({ simpleStyleEnabled: true })), [
      "coalesce",
      ["get", "fill"],
      DEFAULT_LAYER_STYLE.fillColor,
    ]);
    assert.deepEqual(vectorLineColorValue(style({ simpleStyleEnabled: true })), [
      "coalesce",
      ["get", "stroke"],
      DEFAULT_LAYER_STYLE.strokeColor,
    ]);
    assert.deepEqual(vectorCircleColorValue(style({ simpleStyleEnabled: true })), [
      "coalesce",
      ["get", "marker-color"],
      DEFAULT_LAYER_STYLE.fillColor,
    ]);
  });
});

describe("simpleStyleNumberValue", () => {
  it("returns the base number when disabled", () => {
    assert.equal(simpleStyleNumberValue(style(), "stroke-width", 2), 2);
  });

  it("returns a to-number expression with the base as fallback when enabled", () => {
    assert.deepEqual(
      simpleStyleNumberValue(style({ simpleStyleEnabled: true }), "stroke-width", 2),
      ["to-number", ["get", "stroke-width"], 2],
    );
  });
});

describe("paint with simplestyle enabled", () => {
  it("fillPaint reads per-feature fill and fill-opacity", () => {
    const paint = fillPaint(style({ simpleStyleEnabled: true }), 1);
    assert.deepEqual(paint["fill-color"], [
      "coalesce",
      ["get", "fill"],
      DEFAULT_LAYER_STYLE.fillColor,
    ]);
    assert.deepEqual(paint["fill-opacity"], [
      "*",
      ["to-number", ["get", "fill-opacity"], DEFAULT_LAYER_STYLE.fillOpacity],
      1,
    ]);
  });

  it("linePaint reads per-feature stroke and stroke-width", () => {
    const paint = linePaint(style({ simpleStyleEnabled: true }), 1);
    assert.deepEqual(paint["line-color"], [
      "coalesce",
      ["get", "stroke"],
      DEFAULT_LAYER_STYLE.strokeColor,
    ]);
    assert.deepEqual(paint["line-width"], [
      "to-number",
      ["get", "stroke-width"],
      DEFAULT_LAYER_STYLE.strokeWidth,
    ]);
  });

  it("circlePaint reads per-feature marker-color and marker-opacity", () => {
    const paint = circlePaint(style({ simpleStyleEnabled: true }), 1);
    assert.deepEqual(paint["circle-color"], [
      "coalesce",
      ["get", "marker-color"],
      DEFAULT_LAYER_STYLE.fillColor,
    ]);
    assert.deepEqual(paint["circle-opacity"], [
      "*",
      ["to-number", ["get", "marker-opacity"], DEFAULT_LAYER_STYLE.fillOpacity],
      1,
    ]);
  });

  it("keeps flat numeric paint when disabled", () => {
    const paint = fillPaint(style(), 0.5);
    assert.equal(paint["fill-opacity"], DEFAULT_LAYER_STYLE.fillOpacity * 0.5);
    assert.equal(linePaint(style(), 1)["line-width"], DEFAULT_LAYER_STYLE.strokeWidth);
    assert.equal(
      circlePaint(style(), 0.5)["circle-opacity"],
      DEFAULT_LAYER_STYLE.fillOpacity * 0.5,
    );
  });
});
