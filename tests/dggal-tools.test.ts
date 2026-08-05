import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DGGAL_GRID_TYPES,
  DGGAL_HARD_CAP,
  DGGAL_MAX_TOOL_RES,
  DGGAL_TYPES,
  DEFAULT_DGGAL_GRID_TYPE,
  binPointsToDggal,
  compactDggalTokens,
  dggalApproxGlobalCount,
  dggalGridFromBbox,
  estimateDggalCellCount,
  estimateDggalExpandCount,
  expandDggalTokens,
  maxResolutionForDggal,
  resolveDggalGridType,
  suggestDggalResolution,
  withDggalDggrs,
} from "../packages/processing/src/dggal-tools";
import { bboxAreaKm2 } from "../packages/processing/src/h3-tools";

describe("dggal type table", () => {
  it("exposes the documented DGGRS types with class names and max resolutions", () => {
    assert.equal(DEFAULT_DGGAL_GRID_TYPE, "isea3h");
    assert.equal(DGGAL_TYPES.isea3h.className, "ISEA3H");
    assert.equal(DGGAL_TYPES.isea3h.maxRes, 33);
    assert.equal(DGGAL_TYPES.gnosis.className, "GNOSISGlobalGrid");
    assert.equal(DGGAL_TYPES.gnosis.maxRes, 28);
    assert.equal(DGGAL_TYPES.healpix.className, "HEALPix");
    assert.equal(DGGAL_TYPES.rhealpix.className, "rHEALPix");
    assert.equal(DGGAL_MAX_TOOL_RES, 33);
    assert.equal(DGGAL_GRID_TYPES.length, 18);
    assert.equal(maxResolutionForDggal("isea4r"), 25);
    assert.equal(resolveDggalGridType("healpix"), "healpix");
    assert.equal(resolveDggalGridType("nope"), "isea3h");
  });

  it("suggests coarser resolutions for larger areas", () => {
    const big = bboxAreaKm2([-10, -10, 10, 10]);
    const tiny = bboxAreaKm2([0, 0, 0.001, 0.001]);
    const rBig = suggestDggalResolution(big, undefined, undefined, "isea3h");
    const rTiny = suggestDggalResolution(tiny, undefined, undefined, "isea3h");
    assert.ok(rBig < rTiny);
    assert.ok(estimateDggalCellCount(big, rBig, "isea3h") <= 10_000);
    assert.ok(dggalApproxGlobalCount(0, "isea3h") >= 10);
    assert.ok(estimateDggalCellCount(510_065_621.724, 25, "isea3h") > DGGAL_HARD_CAP);
  });
});

describe("dggal compact / expand (WASM)", () => {
  it("compacts four ISEA4R siblings into their parent and expands back", async () => {
    await withDggalDggrs("isea4r", (engine) => {
      const parent = engine.getZoneFromWGS84Centroid(3, {
        lat: (10 * Math.PI) / 180,
        lon: (10 * Math.PI) / 180,
      });
      const kids = [...engine.getSubZones(parent, 1)].map((z) => engine.getZoneTextID(z));
      assert.equal(kids.length, 4);
      const compacted = compactDggalTokens(engine, kids);
      assert.equal(compacted.length, 1);
      assert.equal(compacted[0], engine.getZoneTextID(parent));
      const expanded = expandDggalTokens(engine, compacted, 4);
      assert.equal(expanded.length, 4);
      assert.equal(estimateDggalExpandCount(engine, compacted, 4), 4);
      assert.deepEqual(new Set(expanded), new Set(kids));
    });
  });

  it("optionally compacts a bbox grid after listZones", async () => {
    await withDggalDggrs("isea4r", (engine) => {
      const plain = dggalGridFromBbox(engine, [-10, -10, 10, 10], 5);
      const compacted = dggalGridFromBbox(engine, [-10, -10, 10, 10], 5, DGGAL_HARD_CAP, {
        compact: true,
      });
      assert.ok(compacted.features.length > 0);
      assert.ok(compacted.features.length <= plain.features.length);
    });
  });
});

describe("dggal grid / bin (WASM)", () => {
  it("covers a small bbox and bins a point", async () => {
    await withDggalDggrs("isea3h", (engine) => {
      const fc = dggalGridFromBbox(engine, [0, 0, 1, 1], 4);
      assert.ok(fc.features.length > 0);
      assert.ok(fc.features.length < 5_000);
      assert.equal(fc.features[0]!.geometry.type, "Polygon");
      assert.ok(typeof fc.features[0]!.properties?.dggal === "string");

      const bins = binPointsToDggal(
        engine,
        {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: { pop: 3 },
              geometry: { type: "Point", coordinates: [0.5, 0.5] },
            },
          ],
        },
        5,
        "sum",
        "pop",
      );
      assert.equal(bins.features.length, 1);
      assert.equal(bins.features[0]!.properties?.count, 1);
      assert.equal(bins.features[0]!.properties?.value, 3);
    });
  });

  it("returns native contiguous rings for antimeridian-crossing bboxes", async () => {
    await withDggalDggrs("isea3h", (engine) => {
      const fc = dggalGridFromBbox(engine, [179.6, -0.3, 180.4, 0.3], 8);
      assert.ok(fc.features.length > 0);
      for (const feature of fc.features) {
        const lons = feature.geometry.coordinates[0]!.map(([lng]) => lng);
        assert.ok(lons.length >= 4, "DGGAL cell ring must contain a closed polygon");
        assert.ok(Math.max(...lons) - Math.min(...lons) < 180);
      }
    });
  });
});
