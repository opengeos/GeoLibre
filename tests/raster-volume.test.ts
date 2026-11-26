/**
 * Cut-and-fill / surface volume (issue #3530).
 *
 * Every case has a hand-computed answer: uniform blocks of known depth over
 * cells of known area, a spherical-zone area for a degree cell, and unit
 * conversions with exact factors.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AUTHALIC_EARTH_RADIUS_METERS,
  cellAreasByRow,
  cutFill,
  projectedAreaScale,
  projectedMetersPerUnit,
} from "../packages/processing/src/raster-volume";
import { runRasterToolClientAsync, type RasterData } from "@geolibre/processing";

const near = (actual: number, expected: number, tolerance: number, label = "value") =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected} +/- ${tolerance}, got ${actual}`,
  );

/** A north-up raster in EPSG:32617 (UTM, metres) with 2 m cells. */
function utm(values: number[], width: number, height: number, extra: Partial<RasterData> = {}) {
  const raster: RasterData = {
    bands: [Float32Array.from(values)],
    width,
    height,
    originX: 500_000,
    originY: 4_100_000,
    resX: 2,
    resY: 2,
    nodata: null,
    geoKeys: { GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 1, ProjectedCSTypeGeoKey: 32617 },
    ...extra,
  };
  return raster;
}

/** 10 x 10: the left half at 12 m and the right half at 8 m. */
function halves(): RasterData {
  const values: number[] = [];
  for (let row = 0; row < 10; row += 1) {
    for (let col = 0; col < 10; col += 1) values.push(col < 5 ? 12 : 8);
  }
  return utm(values, 10, 10);
}

describe("cutFill against a plane", () => {
  it("balances two equal halves 2 m above and below grade", () => {
    // 50 cells x 4 m² x 2 m = 400 m³ each way, over 200 m² each.
    const { summary, raster } = cutFill(halves(), null, { plane_elevation: 10 });
    assert.equal(summary.cells, 100);
    near(summary.cutVolume, 400, 1e-9, "cut");
    near(summary.fillVolume, 400, 1e-9, "fill");
    near(summary.netVolume, 0, 1e-9, "net");
    near(summary.cutArea, 200, 1e-9, "cut area");
    near(summary.fillArea, 200, 1e-9, "fill area");
    near(summary.analysedArea, 400, 1e-9, "analysed area");
    assert.equal(summary.maxCutDepth, 2);
    assert.equal(summary.maxFillDepth, 2);
    assert.equal(raster.bands[0][0], 2, "existing - reference is positive in cut");
    assert.equal(raster.bands[0][9], -2, "and negative in fill");
  });

  it("is all fill below a high plane", () => {
    const { summary } = cutFill(halves(), null, { plane_elevation: 15 });
    // 50 cells x 4 m² x (3 + 7) m = 2000 m³.
    near(summary.fillVolume, 2000, 1e-9);
    assert.equal(summary.cutVolume, 0);
    near(summary.netVolume, -2000, 1e-9);
  });

  it("converts feet elevations and foot cells to cubic metres", () => {
    // A 1 ft deep cut over a 2 ft x 2 ft cell: 4 ft³ = 0.11326743 m³.
    const raster = utm([11], 1, 1);
    const { summary } = cutFill(raster, null, { plane_elevation: 10, z_units: "ft" }, 0.3048);
    near(summary.cutVolume, 4 * 0.3048 ** 3, 1e-12);
    near(summary.cutArea, 4 * 0.3048 ** 2, 1e-12);
  });

  it("skips NoData cells and fails when nothing is left", () => {
    const raster = utm([12, -9999, 8, -9999], 2, 2, { nodata: -9999 });
    const { summary, raster: out } = cutFill(raster, null, { plane_elevation: 10 });
    assert.equal(summary.cells, 2);
    assert.ok(Number.isNaN(out.bands[0][1]));
    assert.throws(
      () => cutFill(utm([-9999], 1, 1, { nodata: -9999 }), null, {}),
      /No cell has an elevation/,
    );
  });

  it("rejects a non-numeric plane", () => {
    assert.throws(
      () => cutFill(halves(), null, { plane_elevation: Number.NaN }),
      /must be a number/,
    );
  });
});

describe("cutFill against a second surface", () => {
  it("measures a stockpile removed between two surveys", () => {
    // Before: a 3 x 3 pile, 1 m high around a 3 m peak. After: flat at 0.
    const before = utm([1, 1, 1, 1, 3, 1, 1, 1, 1], 3, 3);
    const after = utm(new Array(9).fill(0), 3, 3);
    const { summary } = cutFill(before, after, { reference: "surface" });
    // (8 x 1 + 3) m x 4 m² = 44 m³ removed.
    near(summary.cutVolume, 44, 1e-9);
    assert.equal(summary.fillVolume, 0);
  });

  it("requires the reference surface on the same grid", () => {
    assert.throws(() => cutFill(halves(), null, { reference: "surface" }), /reference surface/);
    const shifted = utm(new Array(100).fill(0), 10, 10, { originX: 500_001 });
    assert.throws(() => cutFill(halves(), shifted, { reference: "surface" }), /same pixel grid/);
  });
});

describe("cell areas", () => {
  it("uses the spherical zone area for degree cells", () => {
    // A 1 degree cell on the equator: R² · (π/180) · sin(1°) ≈ 12,363.7 km².
    const raster: RasterData = {
      bands: [new Float32Array(2)],
      width: 1,
      height: 2,
      originX: 0,
      originY: 1,
      resX: 1,
      resY: 1,
      nodata: null,
      geoKeys: { GTModelTypeGeoKey: 2, GeographicTypeGeoKey: 4326 },
    };
    const [north, south] = cellAreasByRow(raster, 1);
    const expected = AUTHALIC_EARTH_RADIUS_METERS ** 2 * (Math.PI / 180) * Math.sin(Math.PI / 180);
    near(north, expected, 1e-3, "row straddling 0-1N");
    near(south, expected, 1e-3, "row straddling 0-1S, by symmetry");
    near(north / 1e6, 12_363.7, 0.1, "km²");
  });

  it("shrinks degree cells toward the poles", () => {
    const raster: RasterData = {
      bands: [new Float32Array(1)],
      width: 1,
      height: 1,
      originX: 0,
      originY: 61,
      resX: 1,
      resY: 1,
      nodata: null,
      geoKeys: { GTModelTypeGeoKey: 2, GeographicTypeGeoKey: 4326 },
    };
    const [area] = cellAreasByRow(raster, 1);
    // About cos(60.5°) of the equatorial cell.
    near(area / 12_363.7e6, Math.cos((60.5 * Math.PI) / 180), 1e-3);
  });
});

describe("projectedMetersPerUnit", () => {
  it("reads the GeoKey, then the proj4 definition", () => {
    assert.equal(projectedMetersPerUnit({ geoKeys: { ProjLinearUnitsGeoKey: 9002 } }), 0.3048);
    assert.equal(projectedMetersPerUnit({ geoKeys: {} }, "+proj=utm +zone=17 +units=m"), 1);
    assert.equal(
      projectedMetersPerUnit({ geoKeys: {} }, "+proj=lcc +units=us-ft +no_defs"),
      1200 / 3937,
    );
    assert.equal(projectedMetersPerUnit({ geoKeys: {} }, "+proj=tmerc +to_meter=0.9144"), 0.9144);
    assert.equal(projectedMetersPerUnit({ geoKeys: {} }, null), null);
  });
});

describe("cut-fill through the browser dispatcher", () => {
  it("crops to a boundary polygon and reports in the log", async () => {
    // A polygon covering the five left (12 m) columns only.
    const boundary = {
      type: "FeatureCollection",
      crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::32617" } },
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [500_000, 4_100_000],
                [500_010, 4_100_000],
                [500_010, 4_099_980],
                [500_000, 4_099_980],
                [500_000, 4_100_000],
              ],
            ],
          },
        },
      ],
    };
    const run = await runRasterToolClientAsync(
      "cut-fill",
      { raster: halves(), vectors: { boundary_path: boundary } },
      { reference: "plane", plane_elevation: 10 },
    );
    assert.equal(run.kind, "raster");
    if (run.kind !== "raster") return;
    assert.equal(run.raster.width, 5, "cropped to the polygon");
    // 400 m³ of map volume, times UTM's 1/k² = 1.0008 at the central meridian.
    near(run.cutFill!.cutVolume, 400 / 0.9996 ** 2, 0.05);
    assert.equal(run.cutFill!.fillVolume, 0);
    assert.ok(run.detailMessages.some((line) => line.startsWith("Cut volume: 400.32 m³")));
  });

  it("reads the reference surface from the secondary inputs", async () => {
    const run = await runRasterToolClientAsync(
      "cut-fill",
      { raster: halves(), rasters: { surface_path: utm(new Array(100).fill(10), 10, 10) } },
      { reference: "surface" },
    );
    assert.equal(run.kind, "raster");
    if (run.kind === "raster") near(run.cutFill!.netVolume, 0, 1e-6);
  });
});

describe("Web Mercator cell areas", () => {
  it("scales map area by cos² of the row's latitude", () => {
    // A row centred on 60°N: y = R · ln(tan(45° + 30°)).
    const y = 6_378_137 * Math.log(Math.tan((75 * Math.PI) / 180));
    const raster: RasterData = {
      bands: [new Float32Array(1)],
      width: 1,
      height: 1,
      originX: 0,
      originY: y + 5,
      resX: 10,
      resY: 10,
      nodata: null,
      geoKeys: { GTModelTypeGeoKey: 1, ProjectedCSTypeGeoKey: 3857 },
    };
    const [area] = cellAreasByRow(raster, 1);
    // cos²(60°) = 0.25, so 100 map m² is 25 ground m².
    near(area, 25, 1e-9);
  });
});

describe("cutFill elevation units", () => {
  it("rejects an unknown unit instead of assuming metres", () => {
    assert.throws(
      () => cutFill(halves(), null, { z_units: "feet" }),
      /Unknown elevation unit "feet"/,
    );
  });
});

describe("projectedAreaScale", () => {
  it("recovers Web Mercator's cos² from the inverse projection", async () => {
    const { crsTransform, epsgDefinition } = await import("../packages/processing/src/raster-geo");
    const inverse = await crsTransform(await epsgDefinition(3857), "EPSG:4326");
    // A 10 m row centred on 60°N.
    const y = 6_378_137 * Math.log(Math.tan((75 * Math.PI) / 180));
    const raster: RasterData = {
      bands: [new Float32Array(1)],
      width: 1,
      height: 1,
      originX: 0,
      originY: y + 5,
      resX: 10,
      resY: 10,
      nodata: null,
      geoKeys: { GTModelTypeGeoKey: 1, ProjectedCSTypeGeoKey: 3857 },
    };
    // Spherical cos²(60°) is 0.25; on the ellipsoid the ground cell is a
    // little larger (M and N exceed the sphere's radius at 60°N).
    near(projectedAreaScale(raster, inverse, 1).scaleAt(0, 0), 0.25, 0.004);
  });

  it("applies UTM's point scale factor", async () => {
    const { crsTransform, epsgDefinition } = await import("../packages/processing/src/raster-geo");
    const inverse = await crsTransform(await epsgDefinition(32617), "EPSG:4326");
    const at = (easting: number) =>
      projectedAreaScale(
        utm([0], 1, 1, { originX: easting - 1, originY: 4_000_001 }),
        inverse,
        1,
      ).scaleAt(0, 0);
    // k = 0.9996 on the central meridian, so ground/map area = 1/k² = 1.0008.
    near(at(500_000), 1 / 0.9996 ** 2, 2e-4, "central meridian");
    // About 180 km off it, k ≈ 0.9996 · (1 + (180/6371)²/2) ≈ 1.0000: area ratio ≈ 1.
    near(at(680_000), 1, 3e-4, "near the secant line");
  });

  it("is used by the dispatcher for a projected raster", async () => {
    const run = await runRasterToolClientAsync(
      "cut-fill",
      { raster: halves() },
      { reference: "plane", plane_elevation: 10 },
    );
    assert.equal(run.kind, "raster");
    // The halves grid sits at easting 500 km in UTM 17N: 400 m³ x 1/k².
    if (run.kind === "raster") near(run.cutFill!.cutVolume, 400 / 0.9996 ** 2, 0.05);
  });

  it("refuses an untagged raster with degree-sized cells", async () => {
    for (const res of [0.0001, 0.008333]) {
      const raster = utm([12], 1, 1, {
        originX: -84,
        originY: 36,
        resX: res,
        resY: res,
        geoKeys: {},
      });
      await assert.rejects(
        runRasterToolClientAsync("cut-fill", { raster }, { plane_elevation: 10 }),
        /looks like degrees/,
        `cell ${res}`,
      );
    }
  });

  it("gives a south-up raster the same areas as its north-up twin", async () => {
    // Web Mercator rows at 40-41°N, once north-up and once flipped (south-up).
    const y = (lat: number) => 6_378_137 * Math.log(Math.tan(((45 + lat / 2) * Math.PI) / 180));
    const top = y(41);
    const bottom = y(40);
    const rows = 4;
    const res = (top - bottom) / rows;
    const values = [1, 2, 3, 4];
    const keys = { GTModelTypeGeoKey: 1, ProjectedCSTypeGeoKey: 3857 };
    const northUp = utm(values, 1, rows, {
      originX: 0,
      originY: top,
      resX: res,
      resY: res,
      geoKeys: keys,
    });
    const southUp = utm([...values].reverse(), 1, rows, {
      originX: 0,
      originY: bottom,
      resX: res,
      resY: res,
      flipY: true,
      geoKeys: keys,
    });
    const volume = async (raster: RasterData) => {
      const run = await runRasterToolClientAsync("cut-fill", { raster }, { plane_elevation: 0 });
      return run.kind === "raster" ? run.cutFill!.cutVolume : Number.NaN;
    };
    near(await volume(southUp), await volume(northUp), 1e-6 * (await volume(northUp)));
  });
});

describe("projectedAreaScale edge cases", () => {
  it("wraps longitude steps across the antimeridian and counts failed nodes", () => {
    const raster = utm([0], 1, 1, { originX: 0, originY: 10, resX: 1, resY: 1 });
    // A fake inverse whose cell straddles 180°, normalised the way proj4 does.
    const inverse = ([x, y]: [number, number]): [number, number] => {
      const lon = 179.999995 + x * 1e-5;
      return [lon >= 180 ? lon - 360 : lon, y * 1e-5];
    };
    const plain = projectedAreaScale(raster, ([x, y]) => [x * 1e-5, y * 1e-5], 1).scaleAt(0, 0);
    near(
      projectedAreaScale(raster, inverse, 1).scaleAt(0, 0),
      plain,
      plain * 1e-3,
      "no ±360° blow-up",
    );
    const failing = projectedAreaScale(raster, () => [Number.NaN, Number.NaN], 1);
    assert.equal(failing.scaleAt(0, 0), 1);
    assert.ok(failing.failedNodes > 0);
  });

  it("warns, rather than refuses, for coarser untagged sub-unit cells", async () => {
    const raster = utm([12], 1, 1, {
      originX: -84,
      originY: 36,
      resX: 0.1,
      resY: 0.1,
      geoKeys: {},
    });
    const run = await runRasterToolClientAsync("cut-fill", { raster }, { plane_elevation: 10 });
    assert.ok(run.detailMessages.some((line) => line.includes("may be degrees")));
  });
});

describe("cut-fill input checks", () => {
  it("rejects a band that is not a whole number of 1 or more", () => {
    for (const band of [0, -3, 1.5, Number.NaN]) {
      assert.throws(() => cutFill(halves(), null, { band }), /whole number/, `band ${band}`);
    }
  });

  it("clips both surfaces to the boundary", async () => {
    const boundary = {
      type: "FeatureCollection",
      crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::32617" } },
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [500_000, 4_100_000],
                [500_010, 4_100_000],
                [500_010, 4_099_980],
                [500_000, 4_099_980],
                [500_000, 4_100_000],
              ],
            ],
          },
        },
      ],
    };
    // Reference at 10 m: the 12 m left half inside the boundary is all cut.
    const run = await runRasterToolClientAsync(
      "cut-fill",
      {
        raster: halves(),
        rasters: { surface_path: utm(new Array(100).fill(10), 10, 10) },
        vectors: { boundary_path: boundary },
      },
      { reference: "surface" },
    );
    assert.equal(run.kind, "raster");
    if (run.kind !== "raster") return;
    assert.equal(run.raster.width, 5);
    near(run.cutFill!.cutVolume, 400 / 0.9996 ** 2, 0.05);
    assert.equal(run.cutFill!.fillVolume, 0);
  });

  it("stops when a projected CRS tag cannot be resolved", async () => {
    const raster = utm([12], 1, 1, {
      geoKeys: { GTModelTypeGeoKey: 1, ProjectedCSTypeGeoKey: 999_999 },
    });
    await assert.rejects(runRasterToolClientAsync("cut-fill", { raster }, { plane_elevation: 10 }));
  });
});
