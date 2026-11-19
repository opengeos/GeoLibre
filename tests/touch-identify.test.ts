import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildIdentifyQueryGeometry,
  isTouchIdentifyActive,
  sortIdentifyFeaturesByGeometryPriority,
  TOUCH_IDENTIFY_HIT_RADIUS_PX,
} from "../packages/map/src/touch-identify";

describe("touch identify hit-radius and geometry priority", () => {
  it("returns an exact point for mouse and a padded bounding box for touch", () => {
    const pt = { x: 120, y: 240 };
    assert.deepEqual(buildIdentifyQueryGeometry(pt, false), pt);
    assert.deepEqual(buildIdentifyQueryGeometry(pt, true), [
      [120 - TOUCH_IDENTIFY_HIT_RADIUS_PX, 240 - TOUCH_IDENTIFY_HIT_RADIUS_PX],
      [120 + TOUCH_IDENTIFY_HIT_RADIUS_PX, 240 + TOUCH_IDENTIFY_HIT_RADIUS_PX],
    ]);
  });

  it("prioritizes points over lines over polygons while preserving draw order within tiers", () => {
    const features = [
      { id: "poly-top", geometry: { type: "Polygon" } },
      { id: "line-top", geometry: { type: "LineString" } },
      { id: "poly-bottom", geometry: { type: "MultiPolygon" } },
      { id: "pt-top", geometry: { type: "Point" } },
      { id: "line-bottom", geometry: { type: "MultiLineString" } },
      { id: "pt-bottom", geometry: { type: "MultiPoint" } },
    ];
    const sorted = sortIdentifyFeaturesByGeometryPriority(features);
    assert.deepEqual(
      sorted.map((f) => f.id),
      ["pt-top", "pt-bottom", "line-top", "line-bottom", "poly-top", "poly-bottom"],
    );
  });

  it("respects explicit pointer types when deciding touch identify mode", () => {
    assert.equal(isTouchIdentifyActive("touch"), true);
    assert.equal(isTouchIdentifyActive("mouse"), false);
  });
});
