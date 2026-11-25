import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fromArrayBuffer } from "geotiff";
import { initCogWasm, convertGeoTiffToCog } from "../packages/processing/src/cog-convert";
import {
  parseCoverageJson,
  coverageGridTiff,
  CoverageError,
} from "../apps/geolibre-desktop/src/lib/coverage-json";

const sample = () =>
  JSON.parse(
    readFileSync(
      new URL("./fixtures/ogc-coverages/gdps-temperature.json", import.meta.url),
      "utf8",
    ),
  );
function grid() {
  return {
    type: "Coverage",
    domain: {
      type: "Domain",
      domainType: "Grid",
      axes: { x: { values: [10, 11] }, y: { values: [21, 20] } },
      referencing: [
        {
          coordinates: ["x", "y"],
          system: {
            type: "GeographicCRS",
            id: "http://www.opengis.net/def/crs/OGC/1.3/CRS84",
          },
        },
      ],
    },
    ranges: {
      t: {
        type: "NdArray",
        dataType: "float",
        axisNames: ["y", "x"],
        shape: [2, 2],
        values: [1, 2, 3, null] as (number | null)[],
      },
    },
  };
}

test("preserves all real GDPS values and center coordinates through GeoTIFF encoding", async () => {
  const doc = sample(),
    parsed = parseCoverageJson(doc);
  assert.equal(parsed.width, 7);
  assert.equal(parsed.height, 7);
  assert.deepEqual(Array.from(parsed.bands[0]), doc.ranges.TMP.values);
  assert.equal(parsed.west, -80);
  assert.equal(parsed.north, 44);
  const image = await (await fromArrayBuffer(coverageGridTiff(parsed))).getImage();
  const keys = image.getGeoKeys();
  assert.ok(keys);
  assert.equal(keys.GeographicTypeGeoKey, 4326);
  const bbox = image.getBoundingBox();
  assert.ok(Math.abs(bbox[0] + 80 + 1 / 12) < 1e-10);
  assert.ok(Math.abs(bbox[3] - 44 - 1 / 12) < 1e-10);
  const values = await image.readRasters({ interleave: true });
  assert.deepEqual(Array.from(values), doc.ranges.TMP.values);
});

test("retains Float64 GDPS values and NaN NoData in the renderable COG", async () => {
  await initCogWasm(
    new Uint8Array(
      readFileSync(new URL("../node_modules/geolibre-wasm/geolibre_wasm_bg.wasm", import.meta.url)),
    ),
  );
  const doc = sample();
  doc.ranges.TMP.values[0] = null;
  const input = new Uint8Array(coverageGridTiff(parseCoverageJson(doc)));
  const cog = await convertGeoTiffToCog(input, { float64: true });
  const image = await (await fromArrayBuffer(Uint8Array.from(cog).buffer)).getImage();
  assert.equal(image.getBitsPerSample(), 64);
  assert.ok(Number.isNaN(image.getGDALNoData()!));
  assert.deepEqual(
    Array.from(await image.readRasters({ interleave: true })),
    doc.ranges.TMP.values.map((v: number | null) => (v === null ? NaN : v)),
  );
});

test("transposes ranges and flips ascending y and descending x to north-up", () => {
  const doc = grid();
  doc.domain.axes.x.values = [11, 10];
  doc.domain.axes.y.values = [20, 21];
  doc.ranges.t.axisNames = ["x", "y"];
  doc.ranges.t.values = [4, 2, 3, 1];
  assert.deepEqual(Array.from(parseCoverageJson(doc).bands[0]), [1, 2, 3, 4]);
});

test("encodes null cells as NoData and preserves independent bands", async () => {
  const doc = grid();
  const parsed = parseCoverageJson({
    ...doc,
    ranges: {
      ...doc.ranges,
      second: { ...doc.ranges.t, values: [10, 20, 30, 40] },
    },
  });
  assert.ok(Number.isNaN(parsed.bands[0][3]));
  const image = await (await fromArrayBuffer(coverageGridTiff(parsed))).getImage();
  assert.ok(Number.isNaN(image.getGDALNoData()!));
  assert.equal(image.getSamplesPerPixel(), 2);
  const values = await image.readRasters({ interleave: true });
  assert.deepEqual(Array.from(values), [1, 10, 2, 20, 3, 30, NaN, 40]);
});

test("uses CRS coordinate order for latitude-first EPSG:4326", () => {
  const doc = grid();
  doc.domain.referencing[0].coordinates = ["y", "x"];
  doc.domain.referencing[0].system.id = "http://www.opengis.net/def/crs/EPSG/0/4326";
  assert.deepEqual(Array.from(parseCoverageJson(doc).bands[0]), [1, 2, 3, NaN]);
});

test("refuses irregular, multidimensional, malformed and oversized grids", () => {
  const invalid = (doc: unknown) => assert.throws(() => parseCoverageJson(doc), CoverageError);
  let doc = grid();
  doc.domain.axes.x.values = [1, 2, 4];
  invalid(doc);
  doc = grid();
  Object.assign(doc.domain.axes, {
    t: { values: ["2020-01-01", "2020-01-02"] },
  });
  invalid(doc);
  doc = grid();
  doc.ranges.t.shape = [2, 1];
  invalid(doc);
  doc = grid();
  doc.ranges.t.axisNames = ["x", "x"];
  invalid(doc);
  doc = grid();
  Object.assign(doc.domain.axes, { x: { start: 0, stop: 9e6, num: 9000001 } });
  invalid(doc);
  doc = grid();
  Object.assign(doc.ranges.t, { values: ["1", 2, 3, null] });
  invalid(doc);
  doc = grid();
  doc.domain.axes.x = { values: [1] };
  invalid(doc);
});

test("accepts singleton time slices and explicit singleton cell bounds", () => {
  const doc = grid();
  Object.assign(doc.domain.axes, { t: { values: ["2020-01-01"] } });
  Object.assign(doc.domain.axes, { x: { values: [10], bounds: [9.5, 10.5] } });
  doc.ranges.t = {
    type: "NdArray",
    dataType: "float",
    axisNames: ["t", "y", "x"],
    shape: [1, 2, 1],
    values: [1, 2],
  };
  const parsed = parseCoverageJson(doc);
  assert.equal(parsed.width, 1);
  assert.equal(parsed.dx, 1);
  assert.deepEqual(Array.from(parsed.bands[0]), [1, 2]);
});

test("accepts omitted singleton dimensions in one-column, one-row and scalar grids", () => {
  const column = grid();
  Object.assign(column.domain.axes, { x: { values: [10], bounds: [9.5, 10.5] } });
  Object.assign(column.ranges.t, { axisNames: ["y"], shape: [2], values: [1, 2] });
  assert.deepEqual(Array.from(parseCoverageJson(column).bands[0]), [1, 2]);

  const row = grid();
  Object.assign(row.domain.axes, { y: { values: [20], bounds: [19.5, 20.5] } });
  Object.assign(row.ranges.t, { axisNames: ["x"], shape: [2], values: [3, 4] });
  assert.deepEqual(Array.from(parseCoverageJson(row).bands[0]), [3, 4]);

  const scalar = {
    ...column,
    domain: {
      ...column.domain,
      axes: { ...column.domain.axes, y: { values: [20], bounds: [19.5, 20.5] } },
    },
    ranges: { t: { type: "NdArray", dataType: "float", values: [7.25] } },
  };
  const parsed = parseCoverageJson(scalar);
  assert.equal(parsed.width, 1);
  assert.equal(parsed.height, 1);
  assert.deepEqual(Array.from(parsed.bands[0]), [7.25]);
  assert.throws(
    () => parseCoverageJson({ ...scalar, ranges: { t: { ...scalar.ranges.t, values: [1, 2] } } }),
    CoverageError,
  );
  assert.throws(
    () => parseCoverageJson({ ...scalar, ranges: { t: { ...scalar.ranges.t, shape: null } } }),
    CoverageError,
  );
});
