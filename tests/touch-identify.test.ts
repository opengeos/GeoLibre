import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildIdentifyQueryGeometry,
  isTouchIdentifyActive,
  queryIdentifyFeatures,
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

  it("queryIdentifyFeatures scopes padded box and geometry sort to touch, preserves mouse order, honors desktop radius, and skips empty layer lists", () => {
    const raw = [
      { id: "poly", geometry: { type: "Polygon" } },
      { id: "point", geometry: { type: "Point" } },
    ];
    const calls: Array<{ geometry: unknown; layers: string[] }> = [];
    const queryRendered = (geometry: unknown, options: { layers: string[] }) => {
      calls.push({ geometry, layers: options.layers });
      return raw;
    };

    // Empty layer list short-circuits without querying.
    assert.deepEqual(queryIdentifyFeatures(queryRendered, { x: 50, y: 60 }, [], "touch"), []);
    assert.equal(calls.length, 0);

    // Default mouse query passes exact point and preserves raw draw order.
    const mouseHits = queryIdentifyFeatures(queryRendered, { x: 50, y: 60 }, ["layer-a"], "mouse");
    assert.deepEqual(calls.at(-1)?.geometry, { x: 50, y: 60 });
    assert.deepEqual(
      mouseHits.map((f) => f.id),
      ["poly", "point"],
    );

    // Desktop selection with 4px radius passes 4px box and keeps draw order.
    const desktopRadiusHits = queryIdentifyFeatures(
      queryRendered,
      { x: 50, y: 60 },
      ["layer-a"],
      "mouse",
      4,
    );
    assert.deepEqual(calls.at(-1)?.geometry, [
      [46, 56],
      [54, 64],
    ]);
    assert.deepEqual(
      desktopRadiusHits.map((f) => f.id),
      ["poly", "point"],
    );

    // Touch query uses TOUCH_IDENTIFY_HIT_RADIUS_PX box and prioritizes Point over Polygon.
    const touchHits = queryIdentifyFeatures(
      queryRendered,
      { x: 50, y: 60 },
      ["layer-a"],
      "touch",
      4,
    );
    assert.deepEqual(calls.at(-1)?.geometry, [
      [50 - TOUCH_IDENTIFY_HIT_RADIUS_PX, 60 - TOUCH_IDENTIFY_HIT_RADIUS_PX],
      [50 + TOUCH_IDENTIFY_HIT_RADIUS_PX, 60 + TOUCH_IDENTIFY_HIT_RADIUS_PX],
    ]);
    assert.deepEqual(
      touchHits.map((f) => f.id),
      ["point", "poly"],
    );
  });
});
