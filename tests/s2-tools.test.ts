import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  S2_AVG_AREA_KM2,
  S2_HARD_CAP,
  S2_MAX_TOOL_RES,
  binPointsToS2,
  compactS2Tokens,
  estimateS2CellCount,
  estimateS2ExpandCount,
  expandS2Tokens,
  s2CellAtLonLat,
  s2GridFromBbox,
  s2GridFromFeatureCollection,
  suggestS2Resolution,
} from "../packages/processing/src/s2-tools";
import { bboxAreaKm2 } from "../packages/processing/src/h3-tools";
import { s2 } from "s2js";

describe("s2 resolution math", () => {
  it("exposes 31 average-area entries (res 0..30), strictly decreasing", () => {
    assert.equal(S2_AVG_AREA_KM2.length, 31);
    assert.equal(S2_MAX_TOOL_RES, 30);
    for (let r = 1; r < 31; r += 1) {
      assert.ok(S2_AVG_AREA_KM2[r]! < S2_AVG_AREA_KM2[r - 1]!);
    }
  });

  it("suggests a coarser resolution for larger areas", () => {
    const big = bboxAreaKm2([-10, -10, 10, 10]);
    const tiny = bboxAreaKm2([0, 0, 0.001, 0.001]);
    const rBig = suggestS2Resolution(big);
    const rTiny = suggestS2Resolution(tiny);
    assert.ok(rBig < rTiny);
    assert.ok(estimateS2CellCount(big, rBig) <= 10_000);
    assert.ok(estimateS2CellCount(big, 30) > S2_HARD_CAP);
    assert.ok(Number.isFinite(estimateS2CellCount(big, 20)));
  });
});

describe("s2 compact / expand", () => {
  function fourSiblingsAtLevel(level: number): string[] {
    const leaf = s2.cellid.fromLatLng(s2.LatLng.fromDegrees(10, 10));
    const parent = s2.cellid.parent(leaf, level - 1);
    const kids: string[] = [];
    let id = s2.cellid.childBegin(parent);
    for (let i = 0; i < 4; i += 1) {
      kids.push(s2.cellid.toToken(id));
      id = s2.cellid.next(id);
    }
    return kids;
  }

  it("compacts four siblings into their parent", () => {
    const kids = fourSiblingsAtLevel(6);
    const compacted = compactS2Tokens(kids);
    assert.equal(compacted.length, 1);
    assert.equal(s2.cellid.level(s2.cellid.fromToken(compacted[0]!)), 5);
  });

  it("expands a parent back to four children at the target level", () => {
    const kids = fourSiblingsAtLevel(6);
    const [parent] = compactS2Tokens(kids);
    const expanded = expandS2Tokens([parent!], 6);
    assert.equal(expanded.length, 4);
    assert.equal(estimateS2ExpandCount([parent!], 6), 4);
    assert.deepEqual(new Set(expanded), new Set(kids));
  });

  it("optionally compacts a bbox grid after covering", () => {
    const plain = s2GridFromBbox([0, 0, 2, 2], 6);
    const compacted = s2GridFromBbox([0, 0, 2, 2], 6, { compact: true });
    assert.ok(compacted.features.length > 0);
    assert.ok(compacted.features.length <= plain.features.length);
  });
});

describe("s2 grid / bin", () => {
  it("covers a small bbox with polygon features carrying s2 tokens", () => {
    const fc = s2GridFromBbox([0, 0, 1, 1], 8);
    assert.ok(fc.features.length > 0);
    assert.ok(fc.features.length < 500);
    const expected = s2CellAtLonLat(0.5, 0.5, 8);
    assert.ok(fc.features.some((f) => f.properties?.s2 === expected));
    assert.equal(fc.features[0]!.geometry.type, "Polygon");
  });

  it("polyfills a polygon feature collection", () => {
    const fc = s2GridFromFeatureCollection(
      {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {},
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [0, 0],
                  [1, 0],
                  [1, 1],
                  [0, 1],
                  [0, 0],
                ],
              ],
            },
          },
        ],
      },
      8,
    );
    assert.ok(fc.features.length > 0);
  });

  it("bins points into S2 cells with count", () => {
    const fc = binPointsToS2(
      {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { pop: 10 },
            geometry: { type: "Point", coordinates: [0.5, 0.5] },
          },
          {
            type: "Feature",
            properties: { pop: 5 },
            geometry: { type: "Point", coordinates: [0.51, 0.51] },
          },
        ],
      },
      10,
      "sum",
      "pop",
    );
    assert.ok(fc.features.length >= 1);
    const total = fc.features.reduce((n, f) => n + Number(f.properties?.count ?? 0), 0);
    assert.equal(total, 2);
    const sum = fc.features.reduce((n, f) => n + Number(f.properties?.value ?? 0), 0);
    assert.equal(sum, 15);
  });
});
