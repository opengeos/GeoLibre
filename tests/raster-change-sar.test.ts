import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHANGE_NODATA,
  SAR_NODATA,
  approxTransformRow,
  bandDifference,
  dualPolRgb,
  floodMap,
  mosaicRasters,
  ndviChange,
  parseEpsgCode,
  polygonizeRaster,
  readRasterData,
  reprojectRaster,
  runRasterToolClientAsync,
  sarDbConvert,
  speckleFilter,
  transitionMatrix,
  type RasterData,
} from "@geolibre/processing";
import type { Polygon } from "geojson";

/** A north-up test raster in EPSG:32617 with 10 m pixels. */
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
    originX: 500000,
    originY: 4100000,
    resX: 10,
    resY: 10,
    nodata: null,
    geoKeys: {
      GTModelTypeGeoKey: 1,
      GTRasterTypeGeoKey: 1,
      ProjectedCSTypeGeoKey: 32617,
    },
    ...overrides,
  };
}

describe("change detection", () => {
  it("differences one band of two dates and propagates NoData", () => {
    const before = makeRaster([[1, 2, 3, -1]], 4, 1, { nodata: -1 });
    const after = makeRaster([[2, 2, 1, 5]], 4, 1);
    const { raster } = bandDifference(before, after, {});
    assert.deepEqual([...raster.bands[0]], [1, 0, -2, CHANGE_NODATA]);
  });

  it("computes percent, ratio and log-ratio change", () => {
    const before = makeRaster([[10, 0, 4]], 3, 1);
    const after = makeRaster([[15, 5, 0.4]], 3, 1);
    const pct = bandDifference(before, after, { mode: "percent" }).raster.bands[0];
    assert.equal(pct[0], 50);
    assert.equal(pct[1], CHANGE_NODATA); // divide by zero
    const ratio = bandDifference(before, after, { mode: "ratio" }).raster.bands[0];
    assert.ok(Math.abs(ratio[0] - 1.5) < 1e-6);
    const db = bandDifference(before, after, { mode: "log-ratio" }).raster.bands[0];
    assert.ok(Math.abs(db[2] - -10) < 1e-5);
  });

  it("classifies change beyond a threshold (a ratio is compared to 1)", () => {
    const before = makeRaster([[10, 10, 10]], 3, 1);
    const after = makeRaster([[13, 10.5, 6]], 3, 1);
    const diff = bandDifference(before, after, {
      output: "classified",
      threshold: 1,
    });
    assert.deepEqual([...diff.raster.bands[0]], [1, 0, -1]);
    const ratio = bandDifference(before, after, {
      mode: "ratio",
      output: "classified",
      threshold: 0.2,
    });
    assert.deepEqual([...ratio.raster.bands[0]], [1, 0, -1]);
    assert.match(diff.messages.join("\n"), /Increase: 1 px, decrease: 1 px, no change: 1 px/);
  });

  it("rejects rasters on different grids", () => {
    const a = makeRaster([[1, 2]], 2, 1);
    assert.throws(() => bandDifference(a, makeRaster([[1, 2, 3]], 3, 1), {}), /same grid/);
    assert.throws(
      () => bandDifference(a, makeRaster([[1, 2]], 2, 1, { originX: 500005 }), {}),
      /same pixel grid/,
    );
  });

  it("computes NDVI change with a sensor preset and classifies loss/gain", () => {
    // NAIP layout: red = band 1, NIR = band 4.
    const before = makeRaster([[0.1, 0.1], [0], [0], [0.5, 0.2]], 2, 1);
    const after = makeRaster([[0.4, 0.1], [0], [0], [0.4, 0.6]], 2, 1);
    const diff = ndviChange(before, after, {
      sensor: "naip",
      output: "difference",
    });
    const ndvi = (r: number, n: number) => (n - r) / (n + r);
    assert.ok(Math.abs(diff.raster.bands[0][0] - (ndvi(0.4, 0.4) - ndvi(0.1, 0.5))) < 1e-6);
    const cls = ndviChange(before, after, {
      sensor: "naip",
      output: "classified",
      threshold: 0.2,
    });
    assert.deepEqual([...cls.raster.bands[0]], [-1, 1]);
  });

  it("requires custom band numbers for the Custom sensor", () => {
    const r = makeRaster([[1], [2]], 1, 1);
    assert.throws(() => ndviChange(r, r, { sensor: "custom" }), /band number/);
    const ok = ndviChange(r, r, {
      sensor: "custom",
      red: 1,
      nir: 2,
      output: "difference",
    });
    assert.equal(ok.raster.bands[0][0], 0);
  });

  it("cross-tabulates a transition matrix and codes transitions", () => {
    const before = makeRaster([[1, 1, 2, 2, 3, 0]], 6, 1, { nodata: 0 });
    const after = makeRaster([[1, 2, 2, 3, 3, 1]], 6, 1);
    const { raster, matrix, messages } = transitionMatrix(before, after, {});
    assert.deepEqual(matrix.classes, [1, 2, 3]);
    assert.deepEqual(matrix.counts, [
      [1, 1, 0],
      [0, 1, 1],
      [0, 0, 1],
    ]);
    assert.equal(matrix.total, 5);
    assert.equal(matrix.multiplier, 10);
    assert.deepEqual([...raster.bands[0]], [11, 12, 22, 23, 33, CHANGE_NODATA]);
    assert.match(messages[0], /2 of 5 px changed class \(40\.00%\)/);
    assert.equal(messages[1], "from\\to,1,2,3");
  });

  it("widens the transition code for class values of 10 and above", () => {
    const before = makeRaster([[10, 3]], 2, 1);
    const after = makeRaster([[3, 12]], 2, 1);
    const { raster, matrix } = transitionMatrix(before, after, {});
    assert.equal(matrix.multiplier, 100);
    assert.deepEqual([...raster.bands[0]], [1003, 312]);
  });

  it("rejects non-integer classes in a transition matrix", () => {
    const a = makeRaster([[1.5]], 1, 1);
    assert.throws(() => transitionMatrix(a, a, {}), /integer class/);
  });
});

describe("SAR utilities", () => {
  it("converts linear power to dB and back, masking non-positive values", () => {
    const linear = makeRaster([[1, 0.1, 0, 0.01]], 4, 1);
    const db = sarDbConvert(linear, { direction: "to-db" });
    assert.deepEqual(
      [...db.bands[0]].map((v) => Math.round(v * 1e4) / 1e4),
      [0, -10, SAR_NODATA, -20],
    );
    const back = sarDbConvert(makeRaster([[0, -10, -20]], 3, 1), {
      direction: "to-linear",
    });
    assert.ok(Math.abs(back.bands[0][1] - 0.1) < 1e-7);
    const amp = sarDbConvert(makeRaster([[0.1]], 1, 1), {
      quantity: "amplitude",
    });
    assert.ok(Math.abs(amp.bands[0][0] - -20) < 1e-5);
  });

  it("Lee filter leaves a constant image unchanged and smooths speckle", () => {
    const flat = makeRaster([Array(25).fill(0.2)], 5, 5);
    const out = speckleFilter(flat, { method: "lee", size: 3 }).raster.bands[0];
    for (const v of out) assert.ok(Math.abs(v - 0.2) < 1e-7);

    // Deterministic multiplicative speckle around 0.1 (unit-mean noise).
    const n = 31 * 31;
    let seed = 7;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const noisy = Array.from({ length: n }, () => 0.1 * -Math.log(1 - rand()));
    const raster = makeRaster([noisy], 31, 31);
    const variance = (a: ArrayLike<number>) => {
      let s = 0;
      let s2 = 0;
      for (let i = 0; i < a.length; i += 1) {
        s += a[i];
        s2 += a[i] * a[i];
      }
      const m = s / a.length;
      return s2 / a.length - m * m;
    };
    for (const method of ["lee", "refined-lee"]) {
      const filtered = speckleFilter(raster, { method, enl: 1 }).raster.bands[0];
      assert.ok(
        variance(filtered) < variance(noisy) / 3,
        `${method} should cut the speckle variance`,
      );
    }
  });

  it("refined Lee preserves a step edge better than a plain box mean", () => {
    // Left half 0.02 (water), right half 0.5 (land), no noise.
    const w = 14;
    const h = 9;
    const values = Array.from({ length: w * h }, (_, i) => (i % w < 7 ? 0.02 : 0.5));
    const out = speckleFilter(makeRaster([values], w, h), {
      method: "refined-lee",
      enl: 4.4,
    }).raster.bands[0];
    // Pixels next to the edge keep their own side's value.
    const row = 4;
    assert.ok(Math.abs(out[row * w + 6] - 0.02) < 1e-6, `left of edge: ${out[row * w + 6]}`);
    assert.ok(Math.abs(out[row * w + 7] - 0.5) < 1e-6, `right of edge: ${out[row * w + 7]}`);
  });

  it("speckle-filters dB input in linear space and returns dB", () => {
    const db = makeRaster([Array(9).fill(-10)], 3, 3);
    const out = speckleFilter(db, { method: "lee", size: 3, units: "db" }).raster.bands[0];
    for (const v of out) assert.ok(Math.abs(v - -10) < 1e-5);
  });

  it("builds a dual-pol RGB from VV/VH bands with dB stretches", () => {
    // VV = 0.1 (-10 dB), VH = 0.01 (-20 dB): ratio 10 dB.
    const vvvh = makeRaster(
      [
        [0.1, 0],
        [0.01, 0.01],
      ],
      2,
      1,
    );
    const { raster } = dualPolRgb(vvvh, null, {});
    const [r, g, b] = raster.bands;
    assert.equal(raster.nodata, 0);
    assert.equal(r[0], 1 + Math.round(((-10 + 25) / 25) * 254));
    assert.equal(g[0], 1 + Math.round(((-20 + 30) / 25) * 254));
    assert.equal(b[0], 1 + Math.round((10 / 15) * 254));
    // VV = 0 has no dB value: NoData in every channel.
    assert.deepEqual([r[1], g[1], b[1]], [0, 0, 0]);
  });

  it("takes VH from a separate raster and validates stretch ranges", () => {
    const vv = makeRaster([[-10]], 1, 1);
    const vh = makeRaster([[-20]], 1, 1);
    const { raster } = dualPolRgb(vv, vh, { units: "db" });
    assert.equal(raster.bands[1][0], 1 + Math.round((10 / 25) * 254));
    assert.throws(() => dualPolRgb(vv, vh, { units: "db", vv_min: 0, vv_max: -5 }), /max > min/);
  });

  it("maps water with a single-date threshold", () => {
    const post = makeRaster([[-25, -10, -18.5, SAR_NODATA]], 4, 1, {
      nodata: SAR_NODATA,
    });
    const { raster, messages } = floodMap(post, null, { units: "db" });
    assert.deepEqual([...raster.bands[0]], [1, 0, 1, 255]);
    assert.match(messages[1], /Water: 2 px/);
  });

  it("separates new flooding from permanent water with a pre-event image", () => {
    // dB values: permanent water, new flood, wet but barely darker, dry.
    const pre = makeRaster([[-22, -8, -17, -9]], 4, 1);
    const post = makeRaster([[-24, -21, -19, -9]], 4, 1);
    const { raster } = floodMap(post, pre, {
      units: "db",
      threshold_db: -18,
      change_db: 3,
    });
    assert.deepEqual([...raster.bands[0]], [1, 2, 0, 0]);
    // Linear input is converted to dB first: 0.001 = -30 dB.
    const lin = floodMap(makeRaster([[0.001, 0.5]], 2, 1), null, {});
    assert.deepEqual([...lin.raster.bands[0]], [1, 0]);
  });
});

describe("raster warp and mosaic guards", () => {
  it("accepts EPSG codes only for client reprojection", () => {
    assert.equal(parseEpsgCode("EPSG:3857"), 3857);
    assert.equal(parseEpsgCode(" epsg : 4326 "), 4326);
    assert.equal(parseEpsgCode("32617"), 32617);
    assert.throws(() => parseEpsgCode("+proj=longlat"), /EPSG codes only/);
    assert.throws(() => parseEpsgCode(""), /required/);
  });

  it("refuses to reproject a raster without a CRS", async () => {
    const raster = makeRaster([[1, 2, 3, 4]], 2, 2, { geoKeys: {} });
    await assert.rejects(() => reprojectRaster(raster, { dst_crs: "EPSG:4326" }), /no CRS/);
  });

  it("interpolates exactly along a straight scanline in the approximate transformer", () => {
    const n = 40;
    const xs = Float64Array.from({ length: n }, (_, i) => i + 0.5);
    const ys = new Float64Array(n).fill(3.5);
    const exact = (x: Float64Array, y: Float64Array, ok: Uint8Array) => {
      for (let i = 0; i < x.length; i += 1) {
        x[i] = 2 * x[i] + 1;
        y[i] = y[i] - 1;
        ok[i] = 1;
      }
    };
    const ok = approxTransformRow(xs, ys, exact, 0.125);
    for (let i = 0; i < n; i += 1) {
      assert.equal(ok[i], 1);
      assert.ok(Math.abs(xs[i] - (2 * (i + 0.5) + 1)) < 1e-9);
      assert.ok(Math.abs(ys[i] - 2.5) < 1e-12);
    }
  });

  it("splits a curved scanline until the error is within tolerance", () => {
    const n = 101;
    const xs = Float64Array.from({ length: n }, (_, i) => i);
    const ys = new Float64Array(n);
    const f = (x: number) => (x * x) / 50;
    const exact = (x: Float64Array, y: Float64Array, ok: Uint8Array) => {
      for (let i = 0; i < x.length; i += 1) {
        y[i] = f(x[i]);
        ok[i] = 1;
      }
    };
    approxTransformRow(xs, ys, exact, 0.125);
    for (let i = 0; i < n; i += 1) assert.ok(Math.abs(ys[i] - f(i)) <= 0.125 + 1e-9);
  });

  it("rejects mosaic inputs off the first raster's pixel grid", () => {
    const a = makeRaster([[1, 2]], 2, 1);
    const shifted = makeRaster([[1, 2]], 2, 1, { originX: 500005 });
    assert.throws(() => mosaicRasters([a, shifted], "first"), /same pixel grid/);
    assert.throws(() => mosaicRasters([a], "first"), /at least two/);
    assert.throws(() => mosaicRasters([a, a], "mean"), /Unsupported merge method/);
  });
});

describe("polygonize topology", () => {
  it("separates diagonal pixels with 4-connectivity and joins them with 8", () => {
    const raster = makeRaster([[1, 0, 0, 1]], 2, 2, { nodata: 0 });
    const four = polygonizeRaster(raster, { connectivity: "4" }).geojson.features;
    const eight = polygonizeRaster(raster, { connectivity: "8" }).geojson.features;
    assert.equal(four.length, 2);
    assert.equal(eight.length, 1);
  });

  it("emits counter-clockwise exteriors and the field name requested", () => {
    const raster = makeRaster([[5, 5, 5, 5, 7, 5, 5, 5, 5]], 3, 3);
    const { geojson } = polygonizeRaster(raster, { field: "cls" });
    const outer = geojson.features[0];
    assert.equal(outer.properties!.cls, 5);
    const ring = (outer.geometry as Polygon).coordinates[0];
    let area = 0;
    for (let i = 0; i + 1 < ring.length; i += 1) {
      area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    }
    assert.ok(area > 0, "exterior ring should be counter-clockwise");
    assert.equal((outer.geometry as Polygon).coordinates.length, 2, "has the 7-pixel hole");
  });
});

describe("runRasterToolClientAsync", () => {
  it("returns vector results in the source CRS and in WGS84", async () => {
    const raster = makeRaster([[1, 1, 2, 2]], 2, 2);
    const result = await runRasterToolClientAsync("polygonize", { raster }, { connectivity: "4" });
    assert.equal(result.kind, "vector");
    if (result.kind !== "vector") return;
    assert.deepEqual((result.geojson as { crs?: unknown }).crs, {
      type: "name",
      properties: { name: "urn:ogc:def:crs:EPSG::32617" },
    });
    const [lon, lat] = (result.wgs84.features[0].geometry as Polygon).coordinates[0][0];
    assert.ok(lon > -81.1 && lon < -80.9, `lon ${lon}`);
    assert.ok(lat > 37 && lat < 37.1, `lat ${lat}`);
  });

  it("routes change tools to their secondary raster and returns the matrix", async () => {
    const before = makeRaster([[1, 2]], 2, 1);
    const after = makeRaster([[2, 2]], 2, 1);
    const result = await runRasterToolClientAsync(
      "transition-matrix",
      { raster: before, rasters: { after_path: after } },
      {},
    );
    assert.equal(result.kind, "raster");
    if (result.kind !== "raster") return;
    assert.deepEqual(result.matrix?.counts, [
      [0, 1],
      [0, 1],
    ]);
    // The encoded GeoTIFF round-trips.
    const decoded = await readRasterData(result.bytes);
    assert.deepEqual([...decoded.bands[0]], [12, 22]);
  });

  it("explains a missing secondary input", async () => {
    const raster = makeRaster([[1]], 1, 1);
    await assert.rejects(
      () => runRasterToolClientAsync("ndvi-change", { raster }, {}),
      /Choose the after raster/,
    );
    await assert.rejects(
      () => runRasterToolClientAsync("zonal", { raster }, {}),
      /Choose the zones GeoJSON/,
    );
  });

  it("runs interpolation from a point layer without a raster", async () => {
    const points = {
      type: "FeatureCollection",
      features: [
        [0, 0, 1],
        [1, 0, 2],
        [0, 1, 3],
        [1, 1, 4],
      ].map(([x, y, z]) => ({
        type: "Feature",
        properties: { v: z },
        geometry: { type: "Point", coordinates: [x, y] },
      })),
    };
    const result = await runRasterToolClientAsync(
      "interpolate",
      { vectors: { input: points } },
      { field: "v", method: "idw", resolution: 0.5 },
    );
    assert.equal(result.kind, "raster");
    if (result.kind !== "raster") return;
    assert.equal(result.raster.width, 2);
    assert.equal(result.raster.height, 2);
    assert.equal(result.raster.geoKeys.GeographicTypeGeoKey, 4326);
  });
});
