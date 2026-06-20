import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_LAYER_STYLE,
  circleRadiusValue,
  lineWidthValue,
  ruleBasedColorExpression,
  vectorColorExpression,
  vectorFillColorValue,
  type LayerStyle,
  type VectorRule,
} from "@geolibre/core";

function style(patch: Partial<LayerStyle> = {}): LayerStyle {
  return { ...DEFAULT_LAYER_STYLE, ...patch };
}

function rule(patch: Partial<VectorRule>): VectorRule {
  return {
    id: patch.id ?? "r",
    label: patch.label ?? "",
    filter: patch.filter ?? "",
    color: patch.color ?? "#3b82f6",
    isElse: patch.isElse ?? false,
  };
}

describe("new LayerStyle defaults", () => {
  it("seeds the symbology fields", () => {
    assert.deepEqual(DEFAULT_LAYER_STYLE.vectorRules, []);
    assert.equal(DEFAULT_LAYER_STYLE.proportionalSizeEnabled, false);
    assert.equal(DEFAULT_LAYER_STYLE.fillPattern, "none");
    assert.equal(DEFAULT_LAYER_STYLE.markerEnabled, false);
    assert.equal(DEFAULT_LAYER_STYLE.markerShape, "circle");
  });
});

describe("ruleBasedColorExpression", () => {
  it("compiles ordered rules into a case expression with an else fallback", () => {
    const rules: VectorRule[] = [
      rule({ id: "1", filter: '["==", ["get", "TYPE"], "park"]', color: "#00ff00" }),
      rule({ id: "2", filter: '["==", ["get", "TYPE"], "water"]', color: "#0000ff" }),
      rule({ id: "e", isElse: true, color: "#cccccc" }),
    ];
    assert.deepEqual(ruleBasedColorExpression(style({ vectorRules: rules }), "#000000"), [
      "case",
      ["==", ["get", "TYPE"], "park"],
      "#00ff00",
      ["==", ["get", "TYPE"], "water"],
      "#0000ff",
      "#cccccc",
    ]);
  });

  it("skips rules with invalid filter JSON or non-hex colors", () => {
    const rules: VectorRule[] = [
      rule({ id: "1", filter: "not json", color: "#00ff00" }),
      rule({ id: "2", filter: '["==", ["get", "x"], 1]', color: "red" }),
      rule({ id: "3", filter: '["==", ["get", "x"], 2]', color: "#112233" }),
    ];
    assert.deepEqual(ruleBasedColorExpression(style({ vectorRules: rules }), "#000000"), [
      "case",
      ["==", ["get", "x"], 2],
      "#112233",
      "#000000",
    ]);
  });

  it("falls back to the layer color when no usable rules exist", () => {
    assert.equal(ruleBasedColorExpression(style({ vectorRules: [] }), "#abcdef"), "#abcdef");
  });

  it("uses the else rule color as the fallback when present", () => {
    const rules: VectorRule[] = [rule({ id: "e", isElse: true, color: "#222222" })];
    assert.equal(ruleBasedColorExpression(style({ vectorRules: rules }), "#000000"), "#222222");
  });
});

describe("vectorColorExpression rule-based mode", () => {
  it("routes rule-based mode through the case compiler", () => {
    const rules: VectorRule[] = [
      rule({ id: "1", filter: '[">", ["get", "pop"], 1000]', color: "#ff0000" }),
      rule({ id: "e", isElse: true, color: "#dddddd" }),
    ];
    const result = vectorFillColorValue(
      style({ vectorStyleMode: "rule-based", vectorRules: rules }),
    );
    assert.deepEqual(result, [
      "case",
      [">", ["get", "pop"], 1000],
      "#ff0000",
      "#dddddd",
    ]);
  });

  it("ignores vectorStyleProperty (rules carry their own filters)", () => {
    // rule-based does not require a vectorStyleProperty, unlike graduated.
    const result = vectorColorExpression(
      style({ vectorStyleMode: "rule-based", vectorStyleProperty: "", vectorRules: [] }),
      "#101010",
    );
    assert.equal(result, "#101010");
  });
});

describe("circleRadiusValue proportional sizing", () => {
  it("returns the constant radius when disabled", () => {
    assert.equal(circleRadiusValue(style({ circleRadius: 7 })), 7);
  });

  it("returns an interpolate when enabled with a valid field and range", () => {
    const result = circleRadiusValue(
      style({
        proportionalSizeEnabled: true,
        proportionalSizeProperty: "pop",
        proportionalSizeMinValue: 0,
        proportionalSizeMaxValue: 100,
        proportionalSizeMinRadius: 4,
        proportionalSizeMaxRadius: 24,
      }),
    );
    assert.deepEqual(result, [
      "interpolate",
      ["linear"],
      ["to-number", ["get", "pop"], 0],
      0,
      4,
      100,
      24,
    ]);
  });

  it("falls back to the constant radius when the range is degenerate", () => {
    const result = circleRadiusValue(
      style({
        circleRadius: 5,
        proportionalSizeEnabled: true,
        proportionalSizeProperty: "pop",
        proportionalSizeMinValue: 50,
        proportionalSizeMaxValue: 50,
      }),
    );
    assert.equal(result, 5);
  });

  it("falls back to the constant radius when no field is chosen", () => {
    const result = circleRadiusValue(
      style({ circleRadius: 6, proportionalSizeEnabled: true, proportionalSizeProperty: "" }),
    );
    assert.equal(result, 6);
  });

  it("falls back to the constant radius when a radius output is non-finite", () => {
    // Simulate a hand-edited project with a non-numeric radius.
    const result = circleRadiusValue(
      style({
        circleRadius: 8,
        proportionalSizeEnabled: true,
        proportionalSizeProperty: "pop",
        proportionalSizeMinValue: 0,
        proportionalSizeMaxValue: 100,
        proportionalSizeMinRadius: Number.NaN,
        proportionalSizeMaxRadius: 24,
      }),
    );
    assert.equal(result, 8);
  });
});

describe("lineWidthValue proportional sizing", () => {
  it("sizes line width by a numeric field when proportional is enabled", () => {
    const result = lineWidthValue(
      style({
        proportionalSizeEnabled: true,
        proportionalSizeProperty: "flow",
        proportionalSizeMinValue: 0,
        proportionalSizeMaxValue: 10,
        proportionalSizeMinRadius: 1,
        proportionalSizeMaxRadius: 8,
      }),
    );
    assert.deepEqual(result, [
      "interpolate",
      ["linear"],
      ["to-number", ["get", "flow"], 0],
      0,
      1,
      10,
      8,
    ]);
  });

  it("keeps the constant pixel width when proportional is off", () => {
    assert.equal(lineWidthValue(style({ strokeWidth: 3 })), 3);
  });
});
