import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_LAYER_STYLE,
  circleRadiusValue,
  effectiveVectorRules,
  lineWidthValue,
  ruleBasedColorExpression,
  ruleBasedVisibilityFilter,
  vectorColorExpression,
  mapZoomStepOutputs,
  vectorFillColorValue,
  vectorFillOpacityValue,
  vectorLineColorValue,
  vectorOutlineColorValue,
  vectorStrokeWidthValue,
  type LayerStyle,
  type VectorRule,
} from "@geolibre/core";
import { markerIconSizeValue } from "../packages/map/src/markers";

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
    // Optional extended fields (enabled, zoom range, nesting, symbol
    // overrides) pass through as given.
    ...patch,
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
    assert.deepEqual(result, ["case", [">", ["get", "pop"], 1000], "#ff0000", "#dddddd"]);
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

describe("vectorColorExpression with a transparent fallback", () => {
  it("single mode: passes 'transparent' through as a flat color", () => {
    assert.equal(
      vectorColorExpression(style({ vectorStyleMode: "single" }), "transparent"),
      "transparent",
    );
  });

  it("categorized mode: uses 'transparent' as the match fallback", () => {
    const result = vectorColorExpression(
      style({
        vectorStyleMode: "categorized",
        vectorStyleProperty: "TYPE",
        vectorStyleStops: [{ value: "park", color: "#00ff00" }],
      }),
      "transparent",
    );
    assert.deepEqual(result, [
      "match",
      ["to-string", ["get", "TYPE"]],
      "park",
      "#00ff00",
      "transparent",
    ]);
  });

  it("rule-based mode: uses 'transparent' as the else fallback", () => {
    assert.equal(
      vectorColorExpression(
        style({ vectorStyleMode: "rule-based", vectorRules: [] }),
        "transparent",
      ),
      "transparent",
    );
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

describe("markerIconSizeValue proportional sizing", () => {
  it("returns 1 when proportional sizing is disabled", () => {
    assert.equal(markerIconSizeValue(style({ markerEnabled: true })), 1);
  });

  it("scales the baked sprite so the icon width matches the circle diameter", () => {
    const result = markerIconSizeValue(
      style({
        markerEnabled: true,
        markerSize: 18,
        proportionalSizeEnabled: true,
        proportionalSizeProperty: "pop",
        proportionalSizeMinValue: 0,
        proportionalSizeMaxValue: 100,
        proportionalSizeMinRadius: 4,
        proportionalSizeMaxRadius: 24,
      }),
    );
    // The sprite bakes at the largest proportional diameter (48 px, above the
    // 18 px markerSize), so outputs are 2 * radius / 48: the max value maps to
    // exactly 1 (no upscaling) and the min value scales down.
    assert.deepEqual(result, [
      "interpolate",
      ["linear"],
      ["to-number", ["get", "pop"], 0],
      0,
      8 / 48,
      100,
      1,
    ]);
  });

  it("clamps the grown bake at the canvas-safety maximum (96 px)", () => {
    const result = markerIconSizeValue(
      style({
        markerEnabled: true,
        markerSize: 18,
        proportionalSizeEnabled: true,
        proportionalSizeProperty: "pop",
        proportionalSizeMinValue: 0,
        proportionalSizeMaxValue: 100,
        proportionalSizeMinRadius: 4,
        proportionalSizeMaxRadius: 100,
      }),
    );
    // 2 * 100 = 200 px diameter clamps to a 96 px bake, so the max output is a
    // mild ~2x upscale instead of ~11x on the raw 18 px sprite.
    assert.deepEqual(result, [
      "interpolate",
      ["linear"],
      ["to-number", ["get", "pop"], 0],
      0,
      8 / 96,
      100,
      200 / 96,
    ]);
  });

  it("returns 1 when the value range is degenerate", () => {
    const result = markerIconSizeValue(
      style({
        markerEnabled: true,
        proportionalSizeEnabled: true,
        proportionalSizeProperty: "pop",
        proportionalSizeMinValue: 50,
        proportionalSizeMaxValue: 50,
      }),
    );
    assert.equal(result, 1);
  });

  it("returns 1 when no field is chosen", () => {
    const result = markerIconSizeValue(
      style({
        markerEnabled: true,
        proportionalSizeEnabled: true,
        proportionalSizeProperty: "  ",
      }),
    );
    assert.equal(result, 1);
  });

  it("returns 1 when a radius output is non-finite", () => {
    const result = markerIconSizeValue(
      style({
        markerEnabled: true,
        proportionalSizeEnabled: true,
        proportionalSizeProperty: "pop",
        proportionalSizeMinValue: 0,
        proportionalSizeMaxValue: 100,
        proportionalSizeMinRadius: Number.NaN,
        proportionalSizeMaxRadius: 24,
      }),
    );
    assert.equal(result, 1);
  });

  it("clamps negative radii to zero instead of emitting a negative icon-size", () => {
    const result = markerIconSizeValue(
      style({
        markerEnabled: true,
        markerSize: 20,
        proportionalSizeEnabled: true,
        proportionalSizeProperty: "pop",
        proportionalSizeMinValue: 0,
        proportionalSizeMaxValue: 100,
        proportionalSizeMinRadius: -5,
        proportionalSizeMaxRadius: 10,
      }),
    );
    assert.deepEqual(result, [
      "interpolate",
      ["linear"],
      ["to-number", ["get", "pop"], 0],
      0,
      0,
      100,
      1,
    ]);
  });
});

describe("rule-based extensions (#1305)", () => {
  const parkFilter = '["==", ["get", "TYPE"], "park"]';
  const parkParsed = ["==", ["get", "TYPE"], "park"];
  const roadFilter = '["==", ["get", "class"], "road"]';
  const roadParsed = ["==", ["get", "class"], "road"];

  it("skips disabled rules", () => {
    const rules: VectorRule[] = [
      rule({ id: "1", filter: parkFilter, color: "#00ff00", enabled: false }),
      rule({ id: "2", filter: roadFilter, color: "#0000ff" }),
      rule({ id: "e", isElse: true, color: "#cccccc" }),
    ];
    assert.deepEqual(ruleBasedColorExpression(style({ vectorRules: rules }), "#000000"), [
      "case",
      roadParsed,
      "#0000ff",
      "#cccccc",
    ]);
  });

  it("a disabled group disables its whole subtree", () => {
    const rules: VectorRule[] = [
      rule({ id: "g", filter: roadFilter, color: "#111111", enabled: false }),
      rule({ id: "c", filter: parkFilter, color: "#00ff00", parentId: "g" }),
    ];
    assert.equal(ruleBasedColorExpression(style({ vectorRules: rules }), "#000000"), "#000000");
  });

  it("nested rules AND their ancestors' filters and only leaves draw", () => {
    const rules: VectorRule[] = [
      rule({ id: "g", filter: roadFilter, color: "#111111" }),
      rule({ id: "c", filter: parkFilter, color: "#00ff00", parentId: "g" }),
      rule({ id: "e", isElse: true, color: "#cccccc" }),
    ];
    assert.deepEqual(ruleBasedColorExpression(style({ vectorRules: rules }), "#000000"), [
      "case",
      ["all", roadParsed, parkParsed],
      "#00ff00",
      "#cccccc",
    ]);
  });

  it("a blank group filter adds no constraint", () => {
    const rules: VectorRule[] = [
      rule({ id: "g", filter: "", color: "#111111" }),
      rule({ id: "c", filter: parkFilter, color: "#00ff00", parentId: "g" }),
    ];
    assert.deepEqual(ruleBasedColorExpression(style({ vectorRules: rules }), "#000000"), [
      "case",
      parkParsed,
      "#00ff00",
      "#000000",
    ]);
  });

  it("drops rules trapped in a parentId cycle", () => {
    const rules: VectorRule[] = [
      rule({ id: "a", filter: parkFilter, color: "#00ff00", parentId: "b" }),
      rule({ id: "b", filter: roadFilter, color: "#0000ff", parentId: "a" }),
      // A drawable leaf under the cycle exercises the ancestor-walk guard:
      // its chain (a -> b -> a) never terminates at a root, so it is dropped.
      rule({ id: "c", filter: parkFilter, color: "#ff0000", parentId: "a" }),
    ];
    // The cycle members are groups and the leaf's ancestry is broken, so
    // nothing draws and the fallback color remains.
    assert.equal(ruleBasedColorExpression(style({ vectorRules: rules }), "#000000"), "#000000");
  });

  it("treats a self-referencing parentId as a top-level rule", () => {
    const rules: VectorRule[] = [
      rule({ id: "a", filter: parkFilter, color: "#00ff00", parentId: "a" }),
      rule({ id: "e", isElse: true, color: "#cccccc" }),
    ];
    // Mirrors the editor and the QML exporter: a rule naming itself as its
    // parent is a normal top-level rule, not its own (undrawable) group.
    assert.deepEqual(ruleBasedColorExpression(style({ vectorRules: rules }), "#000000"), [
      "case",
      parkParsed,
      "#00ff00",
      "#cccccc",
    ]);
  });

  it("walks past an ancestor whose parentId references itself", () => {
    const rules: VectorRule[] = [
      // The group's self-referencing parentId means "top-level", so its
      // child must still draw (with the group filter ANDed), not be dropped
      // by the cycle guard.
      rule({ id: "g", filter: roadFilter, color: "#111111", parentId: "g" }),
      rule({ id: "c", filter: parkFilter, color: "#00ff00", parentId: "g" }),
      rule({ id: "e", isElse: true, color: "#cccccc" }),
    ];
    assert.deepEqual(ruleBasedColorExpression(style({ vectorRules: rules }), "#000000"), [
      "case",
      ["all", roadParsed, parkParsed],
      "#00ff00",
      "#cccccc",
    ]);
  });

  it("intersects nested zoom ranges and drops empty intersections", () => {
    const rules: VectorRule[] = [
      rule({ id: "g", filter: roadFilter, color: "#111111", maxZoom: 10 }),
      rule({
        id: "c",
        filter: parkFilter,
        color: "#00ff00",
        parentId: "g",
        minZoom: 12,
      }),
    ];
    assert.equal(ruleBasedColorExpression(style({ vectorRules: rules }), "#000000"), "#000000");
  });

  it("wraps a zoom-ranged rule in a step-on-zoom expression", () => {
    const rules: VectorRule[] = [
      rule({ id: "1", filter: parkFilter, color: "#00ff00", minZoom: 10 }),
      rule({ id: "e", isElse: true, color: "#cccccc" }),
    ];
    assert.deepEqual(ruleBasedColorExpression(style({ vectorRules: rules }), "#000000"), [
      "step",
      ["zoom"],
      "#cccccc",
      10,
      ["case", parkParsed, "#00ff00", "#cccccc"],
    ]);
  });

  it("rebuilds the case per zoom segment for a bounded range", () => {
    const rules: VectorRule[] = [
      rule({
        id: "1",
        filter: parkFilter,
        color: "#00ff00",
        minZoom: 8,
        maxZoom: 12,
      }),
      rule({ id: "2", filter: roadFilter, color: "#0000ff" }),
      rule({ id: "e", isElse: true, color: "#cccccc" }),
    ];
    assert.deepEqual(ruleBasedColorExpression(style({ vectorRules: rules }), "#000000"), [
      "step",
      ["zoom"],
      ["case", roadParsed, "#0000ff", "#cccccc"],
      8,
      ["case", parkParsed, "#00ff00", roadParsed, "#0000ff", "#cccccc"],
      12,
      ["case", roadParsed, "#0000ff", "#cccccc"],
    ]);
  });

  it("compiles per-rule stroke widths with the layer width as fallback", () => {
    const rules: VectorRule[] = [
      rule({ id: "1", filter: parkFilter, color: "#00ff00", strokeWidth: 5 }),
      rule({ id: "2", filter: roadFilter, color: "#0000ff" }),
      rule({ id: "e", isElse: true, color: "#cccccc" }),
    ];
    assert.deepEqual(
      lineWidthValue(style({ vectorStyleMode: "rule-based", vectorRules: rules, strokeWidth: 2 })),
      ["case", parkParsed, 5, roadParsed, 2, 2],
    );
  });

  it("keeps the flat width when no rule overrides it", () => {
    const rules: VectorRule[] = [rule({ id: "1", filter: parkFilter, color: "#00ff00" })];
    assert.equal(
      lineWidthValue(style({ vectorStyleMode: "rule-based", vectorRules: rules, strokeWidth: 3 })),
      3,
    );
  });

  it("compiles per-rule outline colors for polygons and circle strokes", () => {
    const rules: VectorRule[] = [
      rule({
        id: "1",
        filter: parkFilter,
        color: "#00ff00",
        strokeColor: "#ff00ff",
      }),
      rule({ id: "e", isElse: true, color: "#cccccc" }),
    ];
    const styled = style({
      vectorStyleMode: "rule-based",
      vectorRules: rules,
      strokeColor: "#123456",
    });
    assert.deepEqual(vectorOutlineColorValue(styled), ["case", parkParsed, "#ff00ff", "#123456"]);
    // Without any strokeColor override the flat layer stroke is kept.
    assert.equal(
      vectorOutlineColorValue(
        style({
          vectorStyleMode: "rule-based",
          vectorRules: [rule({ id: "1", filter: parkFilter, color: "#00ff00" })],
          strokeColor: "#123456",
        }),
      ),
      "#123456",
    );
  });

  it("compiles per-rule fill opacity and honors an else-rule override", () => {
    const rules: VectorRule[] = [
      rule({ id: "1", filter: parkFilter, color: "#00ff00", fillOpacity: 0.2 }),
      rule({ id: "e", isElse: true, color: "#cccccc", fillOpacity: 0.9 }),
    ];
    assert.deepEqual(
      vectorFillOpacityValue(style({ vectorStyleMode: "rule-based", vectorRules: rules }), 0.6),
      ["case", parkParsed, 0.2, 0.9],
    );
  });

  it("compiles per-rule circle radii over the layer radius", () => {
    const rules: VectorRule[] = [
      rule({ id: "1", filter: parkFilter, color: "#00ff00", circleRadius: 12 }),
      rule({ id: "e", isElse: true, color: "#cccccc" }),
    ];
    assert.deepEqual(
      circleRadiusValue(
        style({
          vectorStyleMode: "rule-based",
          vectorRules: rules,
          circleRadius: 6,
        }),
      ),
      ["case", parkParsed, 12, 6],
    );
  });

  it("per-rule overrides only apply in rule-based mode", () => {
    const rules: VectorRule[] = [
      rule({ id: "1", filter: parkFilter, color: "#00ff00", strokeWidth: 9 }),
    ];
    assert.equal(
      vectorStrokeWidthValue(style({ vectorStyleMode: "single", vectorRules: rules }), 2),
      2,
    );
  });

  it("builds one shared zoom step for the line color's outline and color channels", () => {
    // Composing two independently zoom-stepped expressions in a single case
    // would nest ["zoom"] below the top level, which MapLibre rejects; the
    // line color must come out as a single top-level step.
    const rules: VectorRule[] = [
      rule({
        id: "1",
        filter: parkFilter,
        color: "#00ff00",
        strokeColor: "#ff00ff",
        minZoom: 10,
      }),
      rule({ id: "e", isElse: true, color: "#cccccc" }),
    ];
    const value = vectorLineColorValue(
      style({
        vectorStyleMode: "rule-based",
        vectorRules: rules,
        strokeColor: "#123456",
      }),
    );
    assert.deepEqual(value, [
      "step",
      ["zoom"],
      ["case", ["==", ["geometry-type"], "Polygon"], "#123456", "#cccccc"],
      10,
      [
        "case",
        ["==", ["geometry-type"], "Polygon"],
        ["case", parkParsed, "#ff00ff", "#123456"],
        ["case", parkParsed, "#00ff00", "#cccccc"],
      ],
    ]);
  });

  it("mapZoomStepOutputs transforms inside a zoom step and directly otherwise", () => {
    assert.deepEqual(
      mapZoomStepOutputs(["step", ["zoom"], 0.5, 10, ["case", parkParsed, 0.2, 0.5]], (output) =>
        typeof output === "number" ? output * 2 : ["*", output, 2],
      ),
      ["step", ["zoom"], 1, 10, ["*", ["case", parkParsed, 0.2, 0.5], 2]],
    );
    assert.equal(
      mapZoomStepOutputs(0.5, (output) => (output as number) * 2),
      1,
    );
  });

  it("meters-unit widths ignore per-rule pixel width overrides", () => {
    const rules: VectorRule[] = [
      rule({ id: "1", filter: parkFilter, color: "#00ff00", strokeWidth: 5 }),
    ];
    const value = lineWidthValue(
      style({
        vectorStyleMode: "rule-based",
        vectorRules: rules,
        strokeWidth: 2,
        strokeWidthUnit: "meters",
      }),
    );
    // The meters interpolation survives untouched (a zoom expression cannot
    // be nested inside a per-rule case).
    assert.ok(Array.isArray(value) && value[0] === "interpolate");
  });

  it("effectiveVectorRules resolves nesting, zoom, and overrides", () => {
    const rules: VectorRule[] = [
      rule({ id: "g", filter: roadFilter, color: "#111111", minZoom: 4, maxZoom: 14 }),
      rule({
        id: "c",
        filter: parkFilter,
        color: "#00ff00",
        parentId: "g",
        minZoom: 6,
        strokeWidth: 5,
      }),
      rule({ id: "e", isElse: true, color: "#cccccc" }),
    ];
    const { rules: effective, elseRule } = effectiveVectorRules(style({ vectorRules: rules }));
    assert.equal(effective.length, 1);
    assert.deepEqual(effective[0].filter, ["all", roadParsed, parkParsed]);
    assert.equal(effective[0].minZoom, 6);
    assert.equal(effective[0].maxZoom, 14);
    assert.equal(effective[0].strokeWidth, 5);
    assert.equal(elseRule?.id, "e");
  });
});

describe("ruleBasedVisibilityFilter (#1312 hide unmatched features)", () => {
  const parkRule = rule({
    id: "1",
    filter: '["==", ["get", "TYPE"], "park"]',
    color: "#00ff00",
  });
  const waterRule = rule({
    id: "2",
    filter: '["==", ["get", "TYPE"], "water"]',
    color: "#0000ff",
  });
  const disabledElse = rule({
    id: "e",
    isElse: true,
    color: "#cccccc",
    enabled: false,
  });

  it("returns null outside rule-based mode", () => {
    assert.equal(
      ruleBasedVisibilityFilter(
        style({ vectorStyleMode: "single", vectorRules: [parkRule, disabledElse] }),
      ),
      null,
    );
  });

  it("returns null when no else record exists (historical fallback rendering)", () => {
    assert.equal(
      ruleBasedVisibilityFilter(style({ vectorStyleMode: "rule-based", vectorRules: [parkRule] })),
      null,
    );
  });

  it("returns null while the else rule is enabled", () => {
    const enabledElse = rule({ id: "e", isElse: true, color: "#cccccc" });
    assert.equal(
      ruleBasedVisibilityFilter(
        style({ vectorStyleMode: "rule-based", vectorRules: [parkRule, enabledElse] }),
      ),
      null,
    );
  });

  it("keeps only features matched by a drawable rule when the else rule is off", () => {
    assert.deepEqual(
      ruleBasedVisibilityFilter(
        style({
          vectorStyleMode: "rule-based",
          vectorRules: [parkRule, waterRule, disabledElse],
        }),
      ),
      ["any", ["==", ["get", "TYPE"], "park"], ["==", ["get", "TYPE"], "water"]],
    );
  });

  it("skips disabled and invalid rules, like the paint compiler", () => {
    const disabledRule = rule({
      id: "off",
      filter: '["==", ["get", "TYPE"], "road"]',
      color: "#111111",
      enabled: false,
    });
    const invalidRule = rule({ id: "bad", filter: "not json", color: "#222222" });
    assert.deepEqual(
      ruleBasedVisibilityFilter(
        style({
          vectorStyleMode: "rule-based",
          vectorRules: [parkRule, disabledRule, invalidRule, disabledElse],
        }),
      ),
      ["any", ["==", ["get", "TYPE"], "park"]],
    );
  });

  it("hides everything (vacuous any) when no drawable rule exists", () => {
    assert.deepEqual(
      ruleBasedVisibilityFilter(
        style({ vectorStyleMode: "rule-based", vectorRules: [disabledElse] }),
      ),
      ["any"],
    );
  });

  it("folds per-rule scale ranges in as half-open zoom windows", () => {
    const zoomed = rule({
      id: "z",
      filter: '["==", ["get", "TYPE"], "park"]',
      color: "#00ff00",
      minZoom: 6,
      maxZoom: 12,
    });
    assert.deepEqual(
      ruleBasedVisibilityFilter(
        style({ vectorStyleMode: "rule-based", vectorRules: [zoomed, disabledElse] }),
      ),
      ["any", ["all", ["==", ["get", "TYPE"], "park"], [">=", ["zoom"], 6], ["<", ["zoom"], 12]]],
    );
  });
});
