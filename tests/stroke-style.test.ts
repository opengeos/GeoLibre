import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_LAYER_STYLE,
  STROKE_DASH_PRESETS,
  sanitizeLayerStylePatch,
  strokeDashPresetName,
  strokeDashValue,
  type LayerStyle,
} from "@geolibre/core";
import { circlePaint, fillPaint, linePaint } from "../packages/map/src/style-mapper";

function style(patch: Partial<LayerStyle> = {}): LayerStyle {
  return { ...DEFAULT_LAYER_STYLE, ...patch };
}

describe("line opacity, dashes and blur (#3350)", () => {
  it("draws a solid, sharp, opaque line by default and resets the dash with null", () => {
    const paint = linePaint(style(), 1);
    assert.equal(paint["line-opacity"], 1);
    assert.equal(paint["line-dasharray"], null);
    assert.equal(paint["line-blur"], 0);
  });

  it("folds the stroke opacity into the layer opacity and passes dashes and blur through", () => {
    const paint = linePaint(style({ strokeOpacity: 0.5, strokeDash: [4, 2], strokeBlur: 3 }), 0.8);
    assert.equal(paint["line-opacity"], 0.4);
    assert.deepEqual(paint["line-dasharray"], [4, 2]);
    assert.equal(paint["line-blur"], 3);
  });

  it("drops the fill's hairline outline under a dashed or translucent stroke", () => {
    assert.equal(fillPaint(style(), 1)["fill-outline-color"], DEFAULT_LAYER_STYLE.strokeColor);
    assert.equal(fillPaint(style({ strokeDash: [4, 2] }), 1)["fill-outline-color"], null);
    assert.equal(fillPaint(style({ strokeOpacity: 0.5 }), 1)["fill-outline-color"], null);
  });

  it("fades point outlines with the stroke opacity", () => {
    assert.equal(circlePaint(style({ strokeOpacity: 0.5 }), 0.5)["circle-stroke-opacity"], 0.25);
  });

  it("uses the stroke opacity as the base a simplestyle stroke-opacity replaces", () => {
    const paint = linePaint(style({ strokeOpacity: 0.3, simpleStyleEnabled: true }), 1);
    assert.deepEqual(paint["line-opacity"], [
      "*",
      ["to-number", ["coalesce", ["get", "stroke-opacity"], 0.3], 0.3],
      1,
    ]);
  });

  it("reads a project without the new fields, or with bad values, as before", () => {
    const legacy = { ...DEFAULT_LAYER_STYLE } as Partial<LayerStyle>;
    delete legacy.strokeOpacity;
    delete legacy.strokeDash;
    delete legacy.strokeBlur;
    const paint = linePaint(legacy as LayerStyle, 1);
    assert.equal(paint["line-opacity"], 1);
    assert.equal(paint["line-dasharray"], null);
    assert.equal(paint["line-blur"], 0);
    const bad = linePaint(style({ strokeOpacity: 4, strokeDash: [0, 0], strokeBlur: -2 }), 1);
    assert.equal(bad["line-opacity"], 1);
    assert.equal(bad["line-dasharray"], null);
    assert.equal(bad["line-blur"], 0);
  });

  it("names the preset a pattern matches", () => {
    for (const [name, pattern] of Object.entries(STROKE_DASH_PRESETS)) {
      assert.equal(strokeDashPresetName([...pattern]), name);
    }
    assert.equal(strokeDashPresetName([5, 1]), "custom");
    assert.equal(strokeDashPresetName(undefined), "solid");
    assert.equal(strokeDashValue(style({ strokeDash: [5, 1] }))?.join(), "5,1");
  });

  it("keeps a drawable dash pattern from a hand-edited file and drops a broken one", () => {
    assert.deepEqual(sanitizeLayerStylePatch({ strokeDash: [4, 2] }), { strokeDash: [4, 2] });
    assert.deepEqual(sanitizeLayerStylePatch({ strokeDash: [] }), { strokeDash: [] });
    for (const strokeDash of [[-1, 2], [0, 0], ["4", 2], "4 2"]) {
      assert.deepEqual(sanitizeLayerStylePatch({ strokeDash }), {}, JSON.stringify(strokeDash));
    }
    assert.deepEqual(sanitizeLayerStylePatch({ strokeOpacity: 0.5, strokeBlur: 2 }), {
      strokeOpacity: 0.5,
      strokeBlur: 2,
    });
  });
});
