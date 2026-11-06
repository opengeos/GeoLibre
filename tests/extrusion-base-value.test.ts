import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_LAYER_STYLE,
  extrusionBaseValue,
  extrusionHeightValue,
  type LayerStyle,
} from "@geolibre/core";
import { fillExtrusionPaint } from "../packages/map/src/style-mapper";

function style(patch: Partial<LayerStyle> = {}): LayerStyle {
  return { ...DEFAULT_LAYER_STYLE, extrusionEnabled: true, ...patch };
}

describe("extrusionBaseValue", () => {
  it("keeps the flat base when no base property is set", () => {
    assert.equal(extrusionBaseValue(style()), 0);
    assert.equal(extrusionBaseValue(style({ extrusionBase: 4 })), 4);
  });

  it("stacks floors from the base property times the scale", () => {
    assert.deepEqual(
      extrusionBaseValue(style({ extrusionBaseProperty: " level ", extrusionBaseScale: 3.5 })),
      ["*", ["to-number", ["get", "level"], 0], 3.5],
    );
  });

  it("adds the flat base as an offset to the property", () => {
    assert.deepEqual(
      extrusionBaseValue(
        style({ extrusionBase: 2, extrusionBaseProperty: "level", extrusionBaseScale: 3 }),
      ),
      ["+", ["*", ["to-number", ["get", "level"], 0], 3], 2],
    );
  });

  it("lets a valid advanced expression win, but only in advanced mode", () => {
    const expression = ["match", ["get", "floor"], "B1", 0, 10];
    const advanced = {
      extrusionBaseExpression: JSON.stringify(expression),
      extrusionBaseProperty: "level",
    };
    assert.deepEqual(
      extrusionBaseValue(style({ ...advanced, extrusionAdvancedStyleEnabled: true })),
      expression,
    );
    assert.deepEqual(extrusionBaseValue(style(advanced)), [
      "*",
      ["to-number", ["get", "level"], 0],
      1,
    ]);
    // A half-typed expression falls back to the property rather than erroring.
    assert.deepEqual(
      extrusionBaseValue(
        style({
          extrusionAdvancedStyleEnabled: true,
          extrusionBaseExpression: "[",
          extrusionBase: 5,
        }),
      ),
      5,
    );
  });

  it("tolerates a project saved before the base fields existed", () => {
    const legacy = { ...style({ extrusionBase: 3 }) } as Partial<LayerStyle>;
    delete legacy.extrusionBaseProperty;
    delete legacy.extrusionBaseScale;
    delete legacy.extrusionBaseExpression;
    assert.equal(extrusionBaseValue(legacy as LayerStyle), 3);
  });

  it("feeds fill-extrusion-base on the 2D map", () => {
    assert.deepEqual(
      fillExtrusionPaint(style({ extrusionBaseProperty: "level", extrusionBaseScale: 3.5 }), 1)[
        "fill-extrusion-base"
      ],
      ["*", ["to-number", ["get", "level"], 0], 3.5],
    );
    assert.equal(fillExtrusionPaint(style({ extrusionBase: 7 }), 1)["fill-extrusion-base"], 7);
  });
});

describe("extrusionHeightValue with a floor height", () => {
  it("puts the roof a floor height above a data-driven base, clamped to the ground", () => {
    assert.deepEqual(
      extrusionHeightValue(
        style({
          extrusionBase: 5,
          extrusionBaseProperty: "level",
          extrusionBaseScale: 5,
          extrusionFloorHeight: 4,
          // Ignored while a floor height is set.
          extrusionHeightProperty: "height",
          extrusionAdvancedStyleEnabled: true,
          extrusionHeightExpression: '["get", "top"]',
        }),
      ),
      ["+", ["max", 0, ["+", ["*", ["to-number", ["get", "level"], 0], 5], 5]], 4],
    );
  });

  it("adds the floor height to a flat base", () => {
    assert.equal(extrusionHeightValue(style({ extrusionBase: 6, extrusionFloorHeight: 3 })), 9);
    assert.equal(extrusionHeightValue(style({ extrusionBase: -2, extrusionFloorHeight: 3 })), 3);
  });

  it("keeps the height settings when the floor height is 0 or missing", () => {
    const heightStyle = style({ extrusionHeightProperty: "height", extrusionHeightScale: 2 });
    const expected = ["*", ["to-number", ["get", "height"], 0], 2];
    assert.deepEqual(extrusionHeightValue(heightStyle), expected);
    const legacy = { ...heightStyle } as Partial<LayerStyle>;
    delete legacy.extrusionFloorHeight;
    assert.deepEqual(extrusionHeightValue(legacy as LayerStyle), expected);
    assert.deepEqual(extrusionHeightValue({ ...heightStyle, extrusionFloorHeight: -1 }), expected);
  });
});
