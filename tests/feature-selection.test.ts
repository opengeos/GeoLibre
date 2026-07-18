import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Feature } from "geojson";
import {
  applySelectionMode,
  featureSelectionId,
  invertSelection,
  matchFeaturesByExpression,
} from "@geolibre/core";
import { matchFeaturesByLocation } from "../packages/processing/src/vector-tools";

const point = (
  coords: [number, number],
  properties: Record<string, unknown> = {},
  id?: string | number,
): Feature => ({
  type: "Feature",
  ...(id !== undefined ? { id } : {}),
  properties,
  geometry: { type: "Point", coordinates: coords },
});

const polygon = (ring: [number, number][]): Feature => ({
  type: "Feature",
  properties: {},
  geometry: { type: "Polygon", coordinates: [ring] },
});

describe("featureSelectionId", () => {
  it("uses the feature id when present, else the array index", () => {
    assert.equal(featureSelectionId(point([0, 0], {}, "abc"), 3), "abc");
    assert.equal(featureSelectionId(point([0, 0], {}, 7), 3), "7");
    assert.equal(featureSelectionId(point([0, 0]), 3), "3");
  });
});

describe("applySelectionMode", () => {
  const current = ["a", "b", "c"];

  it("'new' replaces the selection with the matches", () => {
    assert.deepEqual(applySelectionMode(current, ["c", "d"], "new"), [
      "c",
      "d",
    ]);
  });

  it("'add' appends unseen matches after the current ids", () => {
    assert.deepEqual(applySelectionMode(current, ["c", "d"], "add"), [
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("'remove' drops matched ids from the current selection", () => {
    assert.deepEqual(applySelectionMode(current, ["b", "z"], "remove"), [
      "a",
      "c",
    ]);
  });

  it("'intersect' keeps only ids in both, preserving current order", () => {
    assert.deepEqual(
      applySelectionMode(current, ["c", "a", "z"], "intersect"),
      ["a", "c"],
    );
  });

  it("deduplicates repeated matches", () => {
    assert.deepEqual(applySelectionMode([], ["x", "x", "y"], "new"), [
      "x",
      "y",
    ]);
  });
});

describe("invertSelection", () => {
  it("selects the complement in layer order", () => {
    assert.deepEqual(invertSelection(["1", "2", "3", "4"], ["2", "4"]), [
      "1",
      "3",
    ]);
  });

  it("selects everything when nothing is selected", () => {
    assert.deepEqual(invertSelection(["1", "2"], []), ["1", "2"]);
  });
});

describe("matchFeaturesByExpression", () => {
  const features = [
    point([0, 0], { pop: 50 }, "small"),
    point([1, 1], { pop: 500 }, "big"),
    point([2, 2], { pop: 5000 }),
  ];

  it("returns the selection ids of matching features", () => {
    const result = matchFeaturesByExpression(
      features,
      '[">", ["get", "pop"], 100]',
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.ids, ["big", "2"]);
    assert.equal(result.errorCount, 0);
  });

  it("reports an empty source as not ok without errors", () => {
    const result = matchFeaturesByExpression(features, "   ");
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.ids, []);
  });

  it("reports compile failures with their messages", () => {
    const result = matchFeaturesByExpression(features, '["nope", 1]');
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
  });

  it("enforces a boolean result: non-boolean values fail per feature", () => {
    // The boolean property spec compiles a bare ["get", ...] with a runtime
    // assertion, so every non-boolean evaluation throws and is counted
    // instead of silently selecting truthy values.
    const result = matchFeaturesByExpression(features, '["get", "pop"]');
    assert.equal(result.ok, true);
    assert.deepEqual(result.ids, []);
    assert.equal(result.errorCount, features.length);
  });

  it("counts per-feature runtime failures as non-matches", () => {
    const mixed = [
      point([0, 0], { flag: true }, "yes"),
      point([1, 1], { flag: "not-a-boolean" }, "bad"),
    ];
    const result = matchFeaturesByExpression(
      mixed,
      '["boolean", ["get", "flag"]]',
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.ids, ["yes"]);
    assert.equal(result.errorCount, 1);
  });

  it("substitutes @ variables before compiling", () => {
    const result = matchFeaturesByExpression(
      features,
      '[">", ["get", "pop"], "@threshold"]',
      { variables: [{ token: "@threshold", value: 1000 }] },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.ids, ["2"]);
  });

  it("evaluates ['zoom'] at the given zoom", () => {
    const result = matchFeaturesByExpression(features, '[">", ["zoom"], 10]', {
      zoom: 12,
    });
    assert.equal(result.ok, true);
    assert.equal(result.ids.length, features.length);
  });
});

describe("matchFeaturesByLocation", () => {
  const box = polygon([
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
    [0, 0],
  ]);
  const inside = point([5, 5], {}, "inside");
  const outside = point([20, 20], {}, "outside");

  it("matches intersecting features against any filter feature", () => {
    const { matches, unevaluableDropped } = matchFeaturesByLocation(
      [inside, outside],
      [box],
      "intersects",
    );
    assert.deepEqual(matches, [true, false]);
    assert.equal(unevaluableDropped, 0);
  });

  it("supports within", () => {
    const { matches } = matchFeaturesByLocation(
      [inside, outside],
      [box],
      "within",
    );
    assert.deepEqual(matches, [true, false]);
  });

  it("disjoint is the complement of intersects", () => {
    const { matches } = matchFeaturesByLocation(
      [inside, outside],
      [box],
      "disjoint",
    );
    assert.deepEqual(matches, [false, true]);
  });

  it("never matches features without geometry", () => {
    const bare = { type: "Feature", properties: {}, geometry: null } as never;
    const { matches } = matchFeaturesByLocation([bare], [box], "intersects");
    assert.deepEqual(matches, [false]);
    const disjoint = matchFeaturesByLocation([bare], [box], "disjoint");
    assert.deepEqual(disjoint.matches, [false]);
  });

  it("with an empty filter layer, disjoint keeps everything and intersects nothing", () => {
    assert.deepEqual(
      matchFeaturesByLocation([inside], [], "intersects").matches,
      [false],
    );
    assert.deepEqual(matchFeaturesByLocation([inside], [], "disjoint").matches, [
      true,
    ]);
  });

  it("excludes unevaluable pairs from disjoint and counts them", () => {
    // A geometry type Turf cannot evaluate: the pair throws, so disjoint must
    // not claim "no intersection" for it.
    const weird = {
      type: "Feature",
      properties: {},
      geometry: { type: "Weird", coordinates: [5, 5] },
    } as never;
    const result = matchFeaturesByLocation([weird], [box], "disjoint");
    assert.deepEqual(result.matches, [false]);
    assert.equal(result.unevaluableDropped, 1);
  });
});
