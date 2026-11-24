import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  clipRasterByMask,
  contourRaster,
  interpolatePoints,
  mosaicRasters,
  polygonizeRaster,
  zonalStatistics,
  reprojectRaster,
  resampleRaster,
  type RasterData,
} from "@geolibre/processing";
import { rasterEpsg } from "../packages/processing/src/raster-geo";
import type { Feature, FeatureCollection, LineString, Polygon, Position } from "geojson";

/**
 * Parity between the in-browser raster engine and the rasterio sidecar.
 *
 * `tests/fixtures/raster-client-parity.json` is produced by
 * `scripts/gen-raster-parity-fixtures.py`, which runs the real sidecar workers
 * on small synthetic rasters. Each case is replayed through the client engine
 * here and compared to the sidecar's output.
 */

interface RasterRecord {
  width: number;
  height: number;
  originX: number;
  originY: number;
  resX: number;
  resY: number;
  epsg: number | null;
  nodata?: number | null;
  bands: (number | null)[][];
}

interface ParityCase {
  tool: string;
  input?: string;
  extra?: string[];
  params: Record<string, unknown>;
  vector?: unknown;
  expected: unknown;
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/raster-client-parity.json", import.meta.url), "utf8"),
) as { inputs: Record<string, RasterRecord>; cases: ParityCase[] };

function geoKeys(epsg: number): Record<string, unknown> {
  return epsg === 4326
    ? {
        GTModelTypeGeoKey: 2,
        GTRasterTypeGeoKey: 1,
        GeographicTypeGeoKey: 4326,
      }
    : {
        GTModelTypeGeoKey: 1,
        GTRasterTypeGeoKey: 1,
        ProjectedCSTypeGeoKey: epsg,
      };
}

function toRaster(name: string): RasterData {
  const rec = fixture.inputs[name];
  return {
    bands: rec.bands.map((b) => Float32Array.from(b as number[])),
    width: rec.width,
    height: rec.height,
    originX: rec.originX,
    originY: rec.originY,
    resX: rec.resX,
    resY: rec.resY,
    nodata: rec.nodata ?? null,
    geoKeys: geoKeys(rec.epsg ?? 4326),
  };
}

const close = (a: number, b: number, tol: number) =>
  Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

/** Compare geometry nesting exactly and positions within fixture rounding precision. */
function assertGeometryMatches(actual: unknown, expected: unknown): void {
  if (typeof expected === "number") {
    assert.equal(typeof actual, "number");
    assert.ok(close(actual as number, expected, 1e-9));
  } else if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual));
    assert.equal(actual.length, expected.length);
    expected.forEach((value, index) => assertGeometryMatches(actual[index], value));
  } else if (expected && typeof expected === "object") {
    assert.ok(actual && typeof actual === "object");
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
    for (const [key, value] of Object.entries(expected))
      assertGeometryMatches((actual as Record<string, unknown>)[key], value);
  } else assert.equal(actual, expected);
}

/** Compare a client raster to a sidecar output record. */
function assertRasterMatches(
  actual: RasterData,
  expected: RasterRecord,
  label: string,
  tol = 1e-5,
): void {
  assert.equal(actual.width, expected.width, `${label}: width`);
  assert.equal(actual.height, expected.height, `${label}: height`);
  assert.equal(rasterEpsg(actual), expected.epsg, `${label}: CRS`);
  assert.ok(close(actual.originX, expected.originX, 1e-9), `${label}: originX`);
  assert.ok(close(actual.originY, expected.originY, 1e-9), `${label}: originY`);
  assert.ok(close(actual.resX, expected.resX, 1e-9), `${label}: resX`);
  assert.ok(close(actual.resY, expected.resY, 1e-9), `${label}: resY`);
  assert.equal(actual.bands.length, expected.bands.length, `${label}: band count`);
  for (const band of actual.bands)
    assert.equal(band.length, actual.width * actual.height, `${label}: sample count`);
  expected.bands.forEach((band, b) => {
    const got = actual.bands[b];
    for (let i = 0; i < band.length; i += 1) {
      const want = band[i];
      const v = got[i];
      const isValid = Number.isFinite(v) && v !== actual.nodata;
      if (want == null) {
        assert.ok(!isValid, `${label}: pixel ${i} should be NoData, got ${v}`);
      } else {
        assert.ok(isValid, `${label}: pixel ${i} should be ${want}, got NoData`);
        assert.ok(close(v, want, tol), `${label}: pixel ${i} = ${v}, want ${want}`);
      }
    }
  });
}

function casesFor(tool: string): ParityCase[] {
  return fixture.cases.filter((c) => c.tool === tool);
}

describe("raster client parity with the rasterio sidecar", () => {
  for (const c of casesFor("resample")) {
    it(`resample ${c.input} ${JSON.stringify(c.params)}`, () => {
      const out = resampleRaster(toRaster(c.input!), c.params as never);
      assertRasterMatches(out, c.expected as RasterRecord, `resample ${JSON.stringify(c.params)}`);
    });
  }

  for (const c of casesFor("reproject")) {
    it(`reproject ${c.input} ${JSON.stringify(c.params)}`, async () => {
      const out = await reprojectRaster(toRaster(c.input!), c.params as never);
      assertRasterMatches(
        out,
        c.expected as RasterRecord,
        `reproject ${JSON.stringify(c.params)}`,
        1e-4,
      );
    });
  }

  for (const c of casesFor("mosaic")) {
    it(`mosaic ${JSON.stringify(c.params)}`, () => {
      const rasters = [c.input!, ...(c.extra ?? [])].map(toRaster);
      const { raster } = mosaicRasters(rasters, c.params.method);
      assertRasterMatches(raster, c.expected as RasterRecord, `mosaic ${c.params.method}`);
    });
  }

  for (const c of casesFor("clip-mask")) {
    it(`clip-mask ${JSON.stringify(c.params)} (${geojsonCrsLabel(c.vector)})`, async () => {
      const { raster } = await clipRasterByMask(toRaster(c.input!), c.vector, c.params);
      assertRasterMatches(
        raster,
        c.expected as RasterRecord,
        `clip-mask ${JSON.stringify(c.params)}`,
      );
    });
  }

  for (const c of casesFor("interpolate")) {
    it(`interpolate ${JSON.stringify(c.params)}`, async () => {
      const { raster } = await interpolatePoints(c.vector, c.params as never);
      assertRasterMatches(
        raster,
        c.expected as RasterRecord,
        `interpolate ${c.params.method}`,
        1e-5,
      );
    });
  }

  for (const c of casesFor("zonal")) {
    it(`zonal ${JSON.stringify(c.params)}`, async () => {
      const { geojson } = await zonalStatistics(toRaster(c.input!), c.vector, c.params);
      const expected = c.expected as FeatureCollection;
      assert.deepEqual((geojson as { crs?: unknown }).crs, (expected as { crs?: unknown }).crs);
      assert.equal(geojson.features.length, expected.features.length);
      geojson.features.forEach((f, i) => {
        assertGeometryMatches(f.geometry, expected.features[i].geometry);
        const want = expected.features[i].properties!;
        const got = f.properties!;
        assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort(), `zone ${i} keys`);
        for (const [k, v] of Object.entries(want)) {
          if (typeof v === "number")
            assert.ok(close(got[k] as number, v, 1e-9), `zone ${i} ${k}: ${got[k]} vs ${v}`);
          else assert.equal(got[k], v, `zone ${i} ${k}`);
        }
      });
    });
  }

  for (const c of casesFor("polygonize")) {
    it(`polygonize ${JSON.stringify(c.params)}`, () => {
      const { geojson } = polygonizeRaster(toRaster(c.input!), c.params);
      const expected = c.expected as FeatureCollection;
      assert.deepEqual((geojson as { crs?: unknown }).crs, (expected as { crs?: unknown }).crs);
      const canon = (fc: FeatureCollection) =>
        fc.features
          .map((f) => {
            const poly = f.geometry as Polygon;
            const [outer, ...holes] = poly.coordinates.map((r) => ringKey(r));
            return `${f.properties!.value}|${outer}/${holes.sort().join("/")}`;
          })
          .sort();
      assert.deepEqual(canon(geojson), canon(expected));
      // Largest-first order: areas must be non-increasing like the sidecar's.
      const areas = geojson.features.map((f) =>
        Math.abs(shoelace((f.geometry as Polygon).coordinates[0])),
      );
      for (let i = 1; i < areas.length; i += 1) assert.ok(areas[i] <= areas[i - 1] + 1e-6);
    });
  }

  for (const c of casesFor("contour")) {
    it(`contour ${c.input} ${JSON.stringify(c.params)}`, () => {
      const { geojson } = contourRaster(toRaster(c.input!), c.params as never);
      const expected = c.expected as FeatureCollection;
      assert.deepEqual((geojson as { crs?: unknown }).crs, (expected as { crs?: unknown }).crs);
      // Lines match when they share a level and closedness and their vertices
      // pair up within a millimetre (start point and direction may differ).
      const lines = (fc: FeatureCollection) =>
        (fc.features as Feature<LineString>[]).map((f) => {
          const pts = f.geometry.coordinates;
          const a = pts[0];
          const b = pts[pts.length - 1];
          const closed = Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
          return {
            level: f.properties!.elev as number,
            closed,
            pts: closed ? pts.slice(0, -1) : pts,
          };
        });
      const same = (x: ReturnType<typeof lines>[number], y: ReturnType<typeof lines>[number]) =>
        x.level === y.level &&
        x.closed === y.closed &&
        x.pts.length === y.pts.length &&
        samePath(x.pts, y.pts, x.closed);
      const actual = lines(geojson);
      const want = lines(expected);
      assert.equal(actual.length, want.length, "line count");
      const used = new Set<number>();
      for (const w of want) {
        const k = actual.findIndex((a, i) => !used.has(i) && same(a, w));
        assert.ok(k !== -1, `no client line matches the sidecar's ${w.level} line`);
        used.add(k);
      }
    });
  }
});

function geojsonCrsLabel(v: unknown): string {
  return (v as { crs?: unknown }).crs ? "projected mask" : "WGS84 mask";
}

function shoelace(ring: Position[]): number {
  let total = 0;
  for (let i = 0; i + 1 < ring.length; i += 1) {
    total += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return total / 2;
}

/** A ring sequence without collinear points, independent of cyclic start and direction. */
function ringKey(ring: Position[]): string {
  assert.ok(ring.length >= 4, "polygon ring has at least four positions");
  assert.deepEqual(ring[0], ring.at(-1), "polygon ring is closed");
  const pts = ring.slice(0, -1);
  const n = pts.length;
  const kept = pts.filter((cur, i) => {
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];
    return !(
      (prev[0] === cur[0] && cur[0] === next[0]) ||
      (prev[1] === cur[1] && cur[1] === next[1])
    );
  });
  const tokens = kept.map((p) => `${p[0]},${p[1]}`);
  return (
    [tokens, [...tokens].reverse()]
      .flatMap((sequence) =>
        sequence.map((_, start) =>
          [...sequence.slice(start), ...sequence.slice(0, start)].join(";"),
        ),
      )
      .sort()[0] ?? ""
  );
}

/** Compare contour edges in order, allowing reversal and cyclic starts for rings. */
function samePath(a: Position[], b: Position[], closed: boolean): boolean {
  if (a.length !== b.length) return false;
  const n = a.length;
  for (const direction of [1, -1]) {
    const starts = closed ? Array.from({ length: n }, (_, i) => i) : [direction === 1 ? 0 : n - 1];
    for (const start of starts)
      if (
        a.every((point, i) => {
          const other = b[(start + direction * i + n) % n];
          return Math.abs(point[0] - other[0]) < 1e-3 && Math.abs(point[1] - other[1]) < 1e-3;
        })
      )
        return true;
  }
  return false;
}
