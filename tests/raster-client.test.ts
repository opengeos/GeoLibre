import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { writeArrayBuffer } from "geotiff";
import {
  aspect,
  clipByExtent,
  focalStatistics,
  hillshade,
  parseReclassTable,
  rasterCalc,
  readRasterData,
  reclassify,
  runRasterToolClient,
  slope,
  supportsClientRaster,
  writeRasterBands,
  TERRAIN_NODATA,
  type RasterData,
} from "@geolibre/processing";

/** Build a small in-memory raster for tests (top-left origin, 1-unit pixels). */
function makeRaster(
  bands: number[][],
  width: number,
  height: number,
  overrides: Partial<RasterData> = {},
): RasterData {
  return {
    bands: bands.map((b) => Float32Array.from(b)),
    width,
    height,
    originX: 0,
    originY: height, // top edge
    resX: 1,
    resY: 1,
    nodata: null,
    geoKeys: { GTModelTypeGeoKey: 2, GeographicTypeGeoKey: 4326 },
    ...overrides,
  };
}

describe("raster-client compute", () => {
  it("reports which tools have a client implementation", () => {
    assert.equal(supportsClientRaster("hillshade"), true);
    assert.equal(supportsClientRaster("focal"), true);
    assert.equal(supportsClientRaster("polygonize"), true);
    assert.equal(supportsClientRaster("reproject"), true);
    assert.equal(supportsClientRaster("flood-map"), true);
    assert.equal(supportsClientRaster("not-a-tool"), false);
  });

  it("parses reclassify rule tables with min/max bounds", () => {
    const rules = parseReclassTable("0:10:1, 10:max:2");
    assert.deepEqual(rules, [
      { min: 0, max: 10, value: 1 },
      { min: 10, max: Infinity, value: 2 },
    ]);
    assert.throws(() => parseReclassTable("bad"));
    assert.throws(() => parseReclassTable(""));
  });

  it("reclassifies values into half-open ranges", () => {
    const raster = makeRaster([[5, 10, 15, 25]], 4, 1);
    const out = reclassify(raster, {
      table: "0:10:1, 10:20:2",
      unmatched: "nodata",
    });
    // 5 -> 1, 10 -> 2 (half-open [10,20)), 15 -> 2, 25 -> unmatched (nodata)
    assert.equal(out.bands[0][0], 1);
    assert.equal(out.bands[0][1], 2);
    assert.equal(out.bands[0][2], 2);
    assert.equal(out.bands[0][3], TERRAIN_NODATA);
  });

  it("keeps original values for unmatched cells when requested", () => {
    const raster = makeRaster([[5, 99]], 2, 1);
    const out = reclassify(raster, { table: "0:10:1", unmatched: "original" });
    assert.equal(out.bands[0][0], 1);
    assert.equal(out.bands[0][1], 99);
  });

  it("computes zero slope on a flat surface", () => {
    const flat = makeRaster([Array(9).fill(7)], 3, 3);
    const out = slope(flat, { units: "degrees" });
    // The single interior pixel of a flat 3x3 has zero gradient.
    assert.equal(out.bands[0][4], 0);
  });

  it("computes a non-zero slope on an inclined surface", () => {
    // West-to-east ramp on a projected (metres) raster: each column one metre
    // higher than the last, so the gradient is exactly 1:1.
    const ramp = makeRaster([[0, 1, 2, 0, 1, 2, 0, 1, 2]], 3, 3, {
      geoKeys: { GTModelTypeGeoKey: 1, ProjectedCSTypeGeoKey: 32650 },
    });
    const deg = slope(ramp, { units: "degrees" }).bands[0][4];
    assert.ok(Math.abs(deg - 45) < 1e-9);
    // A 1:1 (45 degree-ish) gradient: percent form is gradient * 100.
    const pct = slope(ramp, { units: "percent" }).bands[0][4];
    assert.ok(Math.abs(pct - 100) < 1e-6);
  });

  it("scales gradients to metres for geographic-CRS (4326) DEMs", () => {
    // A 10 m rise per pixel on a ~30.87 m ground grid near the equator (a ~32%
    // grade, atan(10/30.87) ~ 17.9 deg). The cell size arrives in degrees
    // (30.87 / 111320), which the engine used to divide as if they were
    // metres, saturating the slope at 90 deg.
    const resDeg = 30.87 / 111320;
    const ramp = makeRaster([[0, 10, 20, 0, 10, 20, 0, 10, 20]], 3, 3, {
      resX: resDeg,
      resY: resDeg,
      originY: resDeg * 3, // top (northern) edge, so mid-latitude ~ equator
    });
    const deg = slope(ramp, { units: "degrees" }).bands[0][4];
    assert.ok(Math.abs(deg - (Math.atan(10 / 30.87) * 180) / Math.PI) < 0.01);
    const pct = slope(ramp, { units: "percent" }).bands[0][4];
    assert.ok(Math.abs(pct - (10 / 30.87) * 100) < 0.01);
  });

  it("does not skew east-west gradients at high latitude", () => {
    // Same 10 m rise per pixel in both axes at 60 N, where one degree of
    // longitude spans only ~55.7 km. Equal metre gradients must give equal
    // axis gradients (slope atan(sqrt(2) * 10/30.87) ~ 24.6 deg, downhill
    // toward north-west, aspect 315) instead of the ~1/cos(lat) skew toward
    // north-south that raw degree divisions produced.
    const resYDeg = 30.87 / 111320;
    const resXDeg = resYDeg / Math.cos((60 * Math.PI) / 180);
    const ramp = makeRaster([[0, 10, 20, 10, 20, 30, 20, 30, 40]], 3, 3, {
      resX: resXDeg,
      resY: resYDeg,
      originY: 60 + resYDeg * 3, // top edge just north of 60 N
    });
    const deg = slope(ramp, { units: "degrees" }).bands[0][4];
    assert.ok(Math.abs(deg - (Math.atan(Math.sqrt(2) * (10 / 30.87)) * 180) / Math.PI) < 0.05);
    const asp = aspect(ramp).bands[0][4];
    assert.ok(Math.abs(asp - 315) < 0.05);
  });

  it("computes the same terrain products for south-up geographic rasters", () => {
    // A one-degree-pixel grid centred on 60 N stored north-up vs south-up:
    // the south-up file puts originY on the southern edge, so the mid-latitude
    // sign must follow flipY (wrong sign computes cos(57 deg) instead of
    // cos(60 deg), an ~8% slope error on this grid).
    const band = [0, 5566, 11132, 0, 5566, 11132, 0, 5566, 11132];
    const resXDeg = 2; // 1 deg of longitude at 60 N ~ 55.66 km
    const resYDeg = 1;
    const northUp = makeRaster([band], 3, 3, {
      resX: resXDeg,
      resY: resYDeg,
      originY: 61.5, // northern edge
      flipY: false,
    });
    const southUp = makeRaster([band], 3, 3, {
      resX: resXDeg,
      resY: resYDeg,
      originY: 58.5, // southern edge
      flipY: true,
    });
    const deg = slope(southUp, { units: "degrees" }).bands[0][4];
    assert.equal(deg, slope(northUp, { units: "degrees" }).bands[0][4]);
    assert.ok(Math.abs(deg - (Math.atan(5566 / 111320) * 180) / Math.PI) < 1e-4);
  });

  it("honours GeoTIFF angular unit codes before scaling", () => {
    // The same ~30.87 m equator grid as above, expressed in each EPSG angular
    // unit. Per the GeoTIFF 1.0 unit table: 9101 radian, 9102 degree, 9103
    // arc-minute, 9104 arc-second; the key defaults to degrees when absent.
    const band = [0, 10, 20, 0, 10, 20, 0, 10, 20];
    const resDeg = 30.87 / 111320;
    const geoKeys = (unit: number | null) => ({
      GTModelTypeGeoKey: 2,
      GeographicTypeGeoKey: 4326,
      ...(unit == null ? {} : { GeogAngularUnitsGeoKey: unit }),
    });
    const degAtEquator = (Math.atan(10 / 30.87) * 180) / Math.PI;
    // A file that spells out the degree code explicitly must still scale —
    // treating 9102 as unsupported would silently reintroduce the raw-degree
    // bug for exactly the files that declare their units the standard way.
    const explicitDegree = makeRaster([band], 3, 3, {
      resX: resDeg,
      resY: resDeg,
      originY: resDeg * 3,
      geoKeys: geoKeys(9102),
    });
    assert.ok(
      Math.abs(slope(explicitDegree, { units: "degrees" }).bands[0][4] - degAtEquator) < 0.01,
    );
    // Arc-minutes are 1/60 of a degree, so the numeric cell size is 60x.
    const resArcMin = resDeg * 60;
    const arcMin = makeRaster([band], 3, 3, {
      resX: resArcMin,
      resY: resArcMin,
      originY: resArcMin * 3,
      geoKeys: geoKeys(9103),
    });
    assert.ok(Math.abs(slope(arcMin, { units: "degrees" }).bands[0][4] - degAtEquator) < 0.01);
    // Radians: resRad degrees * (PI / 180); the engine converts back via 180/PI.
    const resRad = resDeg * (Math.PI / 180);
    const radian = makeRaster([band], 3, 3, {
      resX: resRad,
      resY: resRad,
      originY: resRad * 3,
      geoKeys: geoKeys(9101),
    });
    assert.ok(Math.abs(slope(radian, { units: "degrees" }).bands[0][4] - degAtEquator) < 0.01);
    // Units we cannot convert (grads) fail loudly instead of returning
    // plausible-but-wrong terrain values built on unconverted cell sizes.
    const grads = makeRaster([band], 3, 3, {
      resX: resDeg * 0.9,
      resY: resDeg * 0.9,
      originY: resDeg * 0.9 * 3,
      geoKeys: geoKeys(9105),
    });
    assert.throws(() => slope(grads, { units: "degrees" }), /Unsupported geographic angular unit/);
    assert.throws(() => hillshade(grads, {}), /Unsupported geographic angular unit/);
  });

  it("renders the same hillshade for geographic and projected rasters of one terrain", () => {
    // Identical 30.87 m ground grid at 60 N, expressed in metres and in
    // degrees: hillshade and aspect must agree exactly. The old range-only
    // assertion (0-255) passed even with broken scaling, so pin the values.
    const band = [0, 10, 20, 10, 20, 30, 20, 30, 40];
    const projected = makeRaster([band], 3, 3, {
      resX: 30.87,
      resY: 30.87,
      geoKeys: { GTModelTypeGeoKey: 1, ProjectedCSTypeGeoKey: 32650 },
    });
    const resYDeg = 30.87 / 111320;
    const geographic = makeRaster([band], 3, 3, {
      resX: resYDeg / Math.cos((60 * Math.PI) / 180),
      resY: resYDeg,
      originY: 60 + 1.5 * resYDeg,
    });
    const sun = { azimuth: 315, altitude: 45, z_factor: 1 };
    assert.ok(
      Math.abs(hillshade(projected, sun).bands[0][4] - hillshade(geographic, sun).bands[0][4]) <
        1e-3,
    );
    assert.ok(Math.abs(aspect(projected).bands[0][4] - aspect(geographic).bands[0][4]) < 1e-3);
  });

  it("computes hillshade within 0-255 and aspect within range", () => {
    const ramp = makeRaster([[0, 1, 2, 0, 1, 2, 0, 1, 2]], 3, 3);
    const hs = hillshade(ramp, { azimuth: 315, altitude: 45, z_factor: 1 }).bands[0][4];
    assert.ok(hs >= 0 && hs <= 255);
    const asp = aspect(ramp).bands[0][4];
    assert.ok(asp >= 0 && asp <= 360);
  });

  it("emits NoData (not -1) for flat aspect cells", () => {
    const flat = makeRaster([Array(9).fill(7)], 3, 3);
    assert.equal(aspect(flat).bands[0][4], TERRAIN_NODATA);
  });

  it("computes correct aspect for north-south slopes", () => {
    // Top row (north) highest -> steepest descent points south -> aspect 180.
    const northHigh = makeRaster([[9, 9, 9, 5, 5, 5, 1, 1, 1]], 3, 3);
    assert.equal(aspect(northHigh).bands[0][4], 180);
    // Bottom row (south) highest -> descent points north -> aspect 0/360.
    const southHigh = makeRaster([[1, 1, 1, 5, 5, 5, 9, 9, 9]], 3, 3);
    const a = aspect(southHigh).bands[0][4];
    assert.ok(a === 0 || a === 360);
  });

  it("clips to a sub-window in CRS coordinates", () => {
    // 4x4 raster, values = row*4 + col, origin (0,4), 1-unit pixels.
    const values = Array.from({ length: 16 }, (_, i) => i);
    const raster = makeRaster([values], 4, 4);
    const clip = clipByExtent(raster, { minx: 1, miny: 1, maxx: 3, maxy: 3 });
    assert.equal(clip.width, 2);
    assert.equal(clip.height, 2);
    assert.equal(clip.originX, 1);
    assert.equal(clip.originY, 3);
    assert.throws(() => clipByExtent(raster, { minx: 10, miny: 10, maxx: 20, maxy: 20 }));
  });

  it("evaluates single-input band math (NDVI)", () => {
    // Two bands: A1 (red), A2 (nir).
    const raster = makeRaster(
      [
        [1, 2],
        [3, 6],
      ],
      2,
      1,
    );
    const out = rasterCalc(raster, { expression: "(A2 - A1) / (A2 + A1)" });
    assert.ok(Math.abs(out.bands[0][0] - (3 - 1) / (3 + 1)) < 1e-6);
    assert.ok(Math.abs(out.bands[0][1] - (6 - 2) / (6 + 2)) < 1e-6);
  });

  it("converts comparison results to a numeric raster mask", () => {
    const raster = makeRaster([[100, 200, 201, 300]], 4, 1);
    const out = rasterCalc(raster, { expression: "A > 200" });
    assert.deepEqual([...out.bands[0]], [0, 0, 1, 1]);
  });

  it("rejects unprovided secondary raster references in client band math", () => {
    const raster = makeRaster([[1, 2]], 2, 1);
    assert.throws(() => rasterCalc(raster, { expression: "A + B" }), /Raster B is referenced/);
  });

  it("evaluates multi-raster expressions across A, B, and C without eval or new Function", () => {
    const a = makeRaster(
      [
        [10, 20, 30, -9999],
        [2, 4, 6, 8],
      ],
      4,
      1,
      { nodata: -9999 },
    );
    const b = makeRaster([[1, 2, -9999, 4]], 4, 1, { nodata: -9999 });
    const c = makeRaster([[5, 5, 5, 5]], 4, 1, { nodata: -9999 });
    const out = rasterCalc(a, {
      expression: "where(A1 > 15, (A2 ** 2 + B) * C, A1 + B1)",
      additionalInputs: { B: b, C: c },
    });
    assert.equal(out.bands[0][0], 11); // A1=10 <= 15 -> 10 + 1
    assert.equal(out.bands[0][1], (16 + 2) * 5); // A1=20 > 15 -> (4**2 + 2) * 5 = 90
    assert.equal(out.bands[0][2], -9999); // B is nodata
    assert.equal(out.bands[0][3], -9999); // A1 is nodata

    // Dimension mismatch between A and B must be rejected cleanly.
    const wrongSize = makeRaster([[1, 2]], 2, 1);
    assert.throws(
      () =>
        rasterCalc(a, {
          expression: "A + B",
          additionalInputs: { B: wrongSize },
        }),
      /do not match/,
    );

    // Georeferencing mismatch (same size, different origin/resolution/registration/CRS/rotation) must be rejected.
    const shifted = { ...b, originX: b.originX + 10 };
    assert.throws(
      () =>
        rasterCalc(a, {
          expression: "A + B",
          additionalInputs: { B: shifted },
        }),
      /origin does not match/,
    );
    // Pixel-scaled origin tolerance: 25 cm pixels at 600,000 m shifted by 0.5 m (2 pixels) must reject.
    const fineA = { ...a, originX: 600_000, resX: 0.25, resY: 0.25 };
    const fineB = { ...b, originX: 600_000.5, resX: 0.25, resY: 0.25 };
    assert.throws(
      () =>
        rasterCalc(fineA, {
          expression: "A + B",
          additionalInputs: { B: fineB },
        }),
      /origin does not match/,
    );
    // Accumulated far-edge resolution drift across width must reject.
    const resDriftA = { ...a, resX: 0.00001, resY: 0.00001 };
    const resDriftB = { ...b, resX: 0.000015, resY: 0.00001 };
    assert.throws(
      () =>
        rasterCalc(resDriftA, {
          expression: "A + B",
          additionalInputs: { B: resDriftB },
        }),
      /pixel resolution does not match/,
    );
    const flipped = { ...b, flipY: true };
    assert.throws(
      () =>
        rasterCalc(a, {
          expression: "A + B",
          additionalInputs: { B: flipped },
        }),
      /axis orientation does not match/,
    );
    const rotatedB = { ...b, rotated: true };
    assert.throws(
      () =>
        rasterCalc(a, {
          expression: "A + B",
          additionalInputs: { B: rotatedB },
        }),
      /rotated or sheared/,
    );
    const pointRegB = { ...b, geoKeys: { GTRasterTypeGeoKey: 2 } };
    assert.throws(
      () =>
        rasterCalc(a, {
          expression: "A + B",
          additionalInputs: { B: pointRegB },
        }),
      /pixel registration/,
    );
    const userDefinedA = { ...a, geoKeys: { ProjectedCSTypeGeoKey: 32767 } };
    const userDefinedB = { ...b, geoKeys: { ProjectedCSTypeGeoKey: 32767 } };
    assert.throws(
      () =>
        rasterCalc(userDefinedA, {
          expression: "A + B",
          additionalInputs: { B: userDefinedB },
        }),
      /user-defined CRS/,
    );
    const otherCrs = { ...b, geoKeys: { ProjectedCSTypeGeoKey: 32617 } };
    const aWithCrs = { ...a, geoKeys: { ProjectedCSTypeGeoKey: 3857 } };
    assert.throws(
      () =>
        rasterCalc(aWithCrs, {
          expression: "A + B",
          additionalInputs: { B: otherCrs },
        }),
      /CRS .* does not match/,
    );

    // Duplicate normalized secondary raster keys must be rejected.
    assert.throws(
      () =>
        rasterCalc(a, {
          expression: "A + B",
          additionalInputs: { B: b, " b ": b },
        }),
      /Duplicate secondary raster key/,
    );
  });

  it("ignores NoData in unreferenced bands and propagates distinct NoData sentinels from B", () => {
    const a = makeRaster(
      [
        [10, 20, 30],
        [-9999, 5, 6], // A2 is NoData at pixel 0, but expression only reads A1 and B
      ],
      3,
      1,
      { nodata: -9999 },
    );
    const b = makeRaster([[1, -32768, 3]], 3, 1, { nodata: -32768 });
    const out = rasterCalc(a, {
      expression: "A + B",
      additionalInputs: { B: b },
    });
    assert.equal(out.bands[0][0], 11); // A2 NoData ignored
    assert.equal(out.bands[0][1], -9999); // B's -32768 NoData propagated to A's sentinel
    assert.equal(out.bands[0][2], 33);
  });

  it("preserves unary-power precedence, bitwise/logical JS semantics, and handles long flat sums", () => {
    const r = makeRaster([[0, 2, 3, 4]], 4, 1);
    // NumPy/Python precedence: -A ** 2 == -(A ** 2)
    assert.deepEqual(
      [...rasterCalc(r, { expression: "-A ** 2" }).bands[0]].map((v) => v + 0),
      [0, -4, -9, -16],
    );
    assert.deepEqual([...rasterCalc(r, { expression: "2 ** -1" }).bands[0]], [0.5, 0.5, 0.5, 0.5]);
    // JS-compatible logical && / || and bitwise & / |
    assert.deepEqual([...rasterCalc(r, { expression: "A && 5" }).bands[0]], [0, 5, 5, 5]);
    assert.deepEqual([...rasterCalc(r, { expression: "A || 5" }).bands[0]], [5, 2, 3, 4]);
    assert.deepEqual([...rasterCalc(r, { expression: "A | 2" }).bands[0]], [2, 2, 3, 6]);
    assert.deepEqual([...rasterCalc(r, { expression: "A & 4" }).bands[0]], [0, 0, 0, 4]);
    // Long flat sum (200 terms) must evaluate iteratively without stack overflow
    const longExpr = Array.from({ length: 200 }, () => "A").join(" + ");
    assert.deepEqual([...rasterCalc(r, { expression: longExpr }).bands[0]], [0, 400, 600, 800]);
    // Balanced binary tree of 2,047 function calls must hit MAX_NODES complexity budget
    let balanced = "A";
    for (let level = 0; level < 11; level += 1) {
      balanced = `minimum(${balanced}, ${balanced})`;
    }
    assert.throws(() => rasterCalc(r, { expression: balanced }), /too complex/);
  });

  it("rejects expressions that reach browser globals", () => {
    const raster = makeRaster([[1, 2]], 2, 1);
    assert.throws(
      () => rasterCalc(raster, { expression: "A + fetch('x')" }),
      /unsupported identifiers/,
    );
    assert.throws(
      () => rasterCalc(raster, { expression: "globalThis" }),
      /unsupported identifiers/,
    );
    // Letter-free "JSFuck"-style payloads must be blocked by the char allowlist.
    assert.throws(() => rasterCalc(raster, { expression: "[]+[]" }), /unsupported characters/);
    // Prototype properties must be rejected as unsupported identifiers, not treated as functions.
    assert.throws(
      () => rasterCalc(raster, { expression: "constructor(A)" }),
      /unsupported identifiers/,
    );
    assert.throws(
      () => rasterCalc(raster, { expression: "toString()" }),
      /unsupported identifiers/,
    );
    // where(NaN, a, b) must evaluate falsy (matching JS truthiness and &&/||/!).
    const neg = makeRaster([[-1, 4]], 2, 1);
    assert.deepEqual([...rasterCalc(neg, { expression: "where(sqrt(A), 1, 0)" }).bands[0]], [0, 1]);
  });

  it("allows numeric literals including leading-dot decimals and scientific notation", () => {
    const raster = makeRaster([[1, 2]], 2, 1);
    const out = rasterCalc(raster, { expression: "A * 1e3 + .5" });
    assert.equal(out.bands[0][0], 1 * 1e3 + 0.5);
    assert.equal(out.bands[0][1], 2 * 1e3 + 0.5);
  });

  it("rejects out-of-range band references before evaluating pixels", () => {
    const raster = makeRaster([[1, 2]], 2, 1);
    assert.throws(() => rasterCalc(raster, { expression: "A10 + 1" }), /out of range/);
    assert.throws(() => rasterCalc(raster, { expression: "A0 + 1" }), /out of range/);
  });

  it("computes a focal mean over a neighbourhood", () => {
    const raster = makeRaster([[1, 2, 3, 4, 5, 6, 7, 8, 9]], 3, 3);
    const out = focalStatistics(raster, { statistic: "mean", size: 3 });
    // Centre pixel mean of all nine values is 5.
    assert.equal(out.bands[0][4], 5);
  });

  it("propagates NoData through compute", () => {
    const raster = makeRaster([[1, -9999, 3, 4]], 4, 1, { nodata: -9999 });
    const out = reclassify(raster, { table: "0:100:1" });
    assert.equal(out.bands[0][1], -9999);
  });
});

describe("raster-client GeoTIFF round-trip", () => {
  it("writes and reads back a single-band raster preserving geo info", async () => {
    const raster = makeRaster([[1, 2, 3, 4, 5, 6]], 3, 2, {
      originX: 100,
      originY: 200,
      resX: 10,
      resY: 5,
      nodata: -1,
    });
    const bytes = writeRasterBands(raster);
    const back = await readRasterData(bytes);
    assert.equal(back.width, 3);
    assert.equal(back.height, 2);
    assert.equal(back.originX, 100);
    assert.equal(back.originY, 200);
    assert.equal(back.resX, 10);
    assert.equal(back.resY, 5);
    assert.equal(back.nodata, -1);
    assert.deepEqual(Array.from(back.bands[0]), [1, 2, 3, 4, 5, 6]);
  });

  it("preserves GeogAngularUnitsGeoKey across a write-read round trip", async () => {
    // Tool output written from a non-degree geographic raster must keep its
    // angular-unit tag: if the writer drops it, the next client tool that
    // reads the file assumes degrees and silently rescales by 60x (arc-min)
    // to 3600x (arc-sec) — the very bug the terrain scaling fixes.
    const resArcMin = (30.87 / 111320) * 60;
    const raster = makeRaster([[0, 10, 20, 0, 10, 20, 0, 10, 20]], 3, 3, {
      resX: resArcMin,
      resY: resArcMin,
      originY: resArcMin * 3,
      geoKeys: {
        GTModelTypeGeoKey: 2,
        GeographicTypeGeoKey: 4326,
        GeogAngularUnitsGeoKey: 9103,
      },
    });
    const back = await readRasterData(writeRasterBands(raster));
    assert.equal(back.geoKeys.GeogAngularUnitsGeoKey, 9103);
    const deg = slope(back, { units: "degrees" }).bands[0][4];
    assert.ok(Math.abs(deg - (Math.atan(10 / 30.87) * 180) / Math.PI) < 0.01);
  });

  it("writes and reads back a multi-band raster with correct interleaving", async () => {
    const raster = makeRaster(
      [
        [1, 2, 3, 4],
        [10, 20, 30, 40],
      ],
      2,
      2,
    );
    const back = await readRasterData(writeRasterBands(raster));
    assert.equal(back.bands.length, 2);
    assert.deepEqual(Array.from(back.bands[0]), [1, 2, 3, 4]);
    assert.deepEqual(Array.from(back.bands[1]), [10, 20, 30, 40]);
  });

  it("runs a tool end-to-end via the dispatcher and yields renderable bytes", async () => {
    const raster = makeRaster([[0, 1, 2, 0, 1, 2, 0, 1, 2]], 3, 3);
    const { bytes, messages } = runRasterToolClient("slope", raster, {
      units: "percent",
      z_factor: 1,
    });
    assert.ok(messages.length >= 2);
    const back = await readRasterData(bytes);
    assert.equal(back.width, 3);
    assert.equal(back.height, 3);
    // Verify semantic content, not just shape: the encoded slope carries the
    // terrain NoData and the interior pixel has a real (>0) slope.
    assert.equal(back.nodata, TERRAIN_NODATA);
    assert.ok(back.bands[0][4] > 0);
  });
});

describe("readRasterData with a short SampleFormat tag", () => {
  it("decodes every band when SampleFormat holds one value for several samples", async () => {
    // Older geolibre-wasm COGs wrote a single SampleFormat value for a
    // multi-band image; geotiff.js alone throws on band 2.
    const values = Uint8Array.from({ length: 2 * 2 * 3 }, (_, i) => i);
    const bytes = writeArrayBuffer(values, {
      width: 2,
      height: 2,
      SampleFormat: [1],
      BitsPerSample: [8, 8, 8],
      ModelPixelScale: [1, 1, 0],
      ModelTiepoint: [0, 0, 0, 0, 0, 0],
    } as Parameters<typeof writeArrayBuffer>[1]) as ArrayBuffer;
    const raster = await readRasterData(bytes);
    assert.deepEqual(
      raster.bands.map((band) => Array.from(band)),
      [
        [0, 3, 6, 9],
        [1, 4, 7, 10],
        [2, 5, 8, 11],
      ],
    );
  });
});

describe("client-raster-inputs path parameters", () => {
  it("classifies raster and GeoJSON path parameters for the client engine", async () => {
    const { clientInputForParam, parseGeoJsonBytes } =
      await import("../apps/geolibre-desktop/src/lib/client-raster-inputs");
    const tif = [{ extensions: ["tif", "tiff"] }];
    const geojson = [{ extensions: ["geojson", "json"] }];
    assert.deepEqual(clientInputForParam({ id: "b_path", type: "path", fileFilters: tif }), {
      kind: "raster",
      key: "B",
    });
    assert.deepEqual(clientInputForParam({ id: "raster_2", type: "path", fileFilters: tif }), {
      kind: "raster",
      key: "raster_2",
    });
    assert.deepEqual(
      clientInputForParam({
        id: "mask_path",
        type: "path",
        fileFilters: geojson,
      }),
      {
        kind: "vector",
        key: "mask_path",
      },
    );
    assert.equal(clientInputForParam({ id: "band", type: "number" }), null);
    assert.equal(
      clientInputForParam({
        id: "x",
        type: "path",
        fileFilters: [{ extensions: ["csv"] }],
      }),
      null,
    );

    const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
    assert.deepEqual(parseGeoJsonBytes(enc('{"type":"FeatureCollection","features":[]}')), {
      type: "FeatureCollection",
      features: [],
    });
    assert.equal(parseGeoJsonBytes(enc("not json")), null);
    assert.equal(parseGeoJsonBytes(enc("42")), null);
  });
});

describe("client-raster-inputs helper", () => {
  it("reserves all RGB and preserved output bands even without secondary files", async () => {
    const { loadClientAdditionalRasters, clientRasterOutputBands } =
      await import("../apps/geolibre-desktop/src/lib/client-raster-inputs");
    const primary = { width: 4096, height: 8192, bands: [new Float32Array(0)] };
    let reads = 0;
    const deps = {
      outputBands: 3,
      estimateBytes: async () => 4096 * 8192 * 4,
      readRaster: async () => {
        reads += 1;
        return makeRaster([[1]], 1, 1);
      },
    };
    await assert.rejects(
      loadClientAdditionalRasters(
        primary,
        { vh_path: { name: "vh.tif", bytes: new ArrayBuffer(0) } },
        deps,
      ),
      /COMBINED_TOO_LARGE/,
    );
    await assert.rejects(
      loadClientAdditionalRasters(
        { ...primary, bands: [...primary.bands, ...primary.bands] },
        {},
        deps,
      ),
      /COMBINED_TOO_LARGE/,
    );
    assert.equal(reads, 0);
    assert.equal(clientRasterOutputBands("sar-rgb", 2), 3);
    assert.equal(clientRasterOutputBands("speckle-filter", 4), 4);
    assert.equal(clientRasterOutputBands("raster-calc", 4), 1);
  });
  it("maps secondary parameter ids, omits cleared inputs, and enforces combined memory budget", async () => {
    const {
      ClientRasterInputError,
      loadClientAdditionalRasters,
      omitClientSecondaryInput,
      secondaryRasterLetterForParam,
    } = await import("../apps/geolibre-desktop/src/lib/client-raster-inputs");

    assert.equal(secondaryRasterLetterForParam("b_path"), "B");
    assert.equal(secondaryRasterLetterForParam("c_path"), "C");
    assert.equal(secondaryRasterLetterForParam("expression"), null);

    const dummyBuf = new ArrayBuffer(8);
    const inputs = {
      B: { name: "b.tif", bytes: dummyBuf },
      C: { name: "c.tif", bytes: dummyBuf },
    };
    const withoutB = omitClientSecondaryInput(inputs, "B");
    assert.deepEqual(Object.keys(withoutB), ["C"]);
    assert.equal(omitClientSecondaryInput(withoutB, "B"), withoutB);

    const primary = makeRaster([[1, 2, 3, 4]], 2, 2);
    let readCalls = 0;
    await assert.rejects(
      () =>
        loadClientAdditionalRasters(primary, inputs, {
          maxBytes: 100,
          estimateBytes: async () => 80,
          readRaster: async () => {
            readCalls += 1;
            return primary;
          },
        }),
      (err: unknown) => err instanceof ClientRasterInputError && err.code === "COMBINED_TOO_LARGE",
    );
    assert.equal(readCalls, 0, "must reject oversized combined inputs before decoding bytes");

    const decoded = await loadClientAdditionalRasters(
      primary,
      { B: inputs.B },
      {
        maxBytes: 1024,
        estimateBytes: async () => 16,
        readRaster: async () => primary,
      },
    );
    assert.deepEqual(Object.keys(decoded ?? {}), ["B"]);

    // Unused secondary inputs (not referenced by the expression) must be skipped
    // without estimating or decoding them.
    let skippedEstimateCalls = 0;
    const skipped = await loadClientAdditionalRasters(primary, inputs, {
      expression: "A * 2",
      maxBytes: 100,
      estimateBytes: async () => {
        skippedEstimateCalls += 1;
        return 10_000;
      },
      readRaster: async () => primary,
    });
    assert.equal(skipped, undefined);
    assert.equal(skippedEstimateCalls, 0);
  });

  it("compiles standalone raster expressions via raster-expr module", async () => {
    const { compileRasterExpression } = await import("../packages/processing/src/raster-expr");
    const compiled = compileRasterExpression("where(A, A + 1, 0)", {
      A: [new Float32Array([2, Number.NaN])],
    });
    assert.equal(compiled.evaluate(0), 3);
    assert.equal(compiled.evaluate(1), 0);
  });
});
