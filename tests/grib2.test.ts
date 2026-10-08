import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { decodeGrib2, orientGrib2Field } from "../packages/plugins/src/plugins/grib2";
import {
  GribberishCodec,
  registerGribberishCodec,
} from "../packages/plugins/src/plugins/grib2-codec";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./fixtures/grib2/${name}.grib2`, import.meta.url)));

/** The values ecCodes decodes the fixture to (see fixtures/grib2/make_fixtures.py). */
const expected = (name: string): Array<number | null> =>
  JSON.parse(readFileSync(new URL(`./fixtures/grib2/${name}.json`, import.meta.url), "utf8"))
    .values;

function assertMatches(actual: Float64Array, reference: Array<number | null>): void {
  assert.equal(actual.length, reference.length);
  for (let index = 0; index < reference.length; index += 1) {
    const want = reference[index];
    if (want === null) {
      assert.ok(Number.isNaN(actual[index]), `value ${index} should be missing`);
    } else {
      assert.ok(
        Math.abs(actual[index] - want) <= 1e-6 * Math.max(1, Math.abs(want)),
        `value ${index}: ${actual[index]} != ${want}`,
      );
    }
  }
}

describe("decodeGrib2", () => {
  // Encoded by ecCodes; each mixes a smooth part, whole rows of zeros and a noisy patch, so the
  // CCSDS streams carry split-sample, second-extension, zero and uncompressed blocks.
  for (const [name, packing] of [
    ["ccsds", 42],
    ["ccsds-bitmap", 42],
    ["complex-bitmap", 3],
    ["simple-bitmap", 0],
    ["lambert", 3],
  ] as const) {
    it(`matches ecCodes on ${name} (template 5.${packing})`, () => {
      const field = decodeGrib2(fixture(name));
      assert.equal(field.packing, packing);
      assertMatches(field.values, expected(name));
    });
  }

  it("reads the grid of a latitude/longitude and a Lambert message", () => {
    const latlon = decodeGrib2(fixture("ccsds")).grid;
    assert.deepEqual(
      {
        template: latlon.template,
        ni: latlon.ni,
        nj: latlon.nj,
        scanningMode: latlon.scanningMode,
      },
      { template: 0, ni: 48, nj: 24, scanningMode: 0 },
    );
    assert.equal(latlon.firstLongitude, 0);
    assert.equal(latlon.longitudeStep, 7.5);
    const lambert = decodeGrib2(fixture("lambert")).grid;
    assert.deepEqual(
      {
        template: lambert.template,
        ni: lambert.ni,
        nj: lambert.nj,
        scanning: lambert.scanningMode,
      },
      { template: 30, ni: 48, nj: 24, scanning: 0x40 },
    );
  });

  it("decodes a real GEFS complex-packed categorical field", () => {
    // NOAA GEFS 0.5-degree categorical snow, as a dynamical.org virtual chunk references it.
    const field = decodeGrib2(fixture("gefs-categorical"));
    assert.equal(field.packing, 3);
    assert.equal(field.values.length, 720 * 361);
    let sum = 0;
    for (const value of field.values) {
      assert.ok(value === 0 || value === 1);
      sum += value;
    }
    // ecCodes' sum for the same message.
    assert.equal(sum, 43291);
  });

  it("decodes a constant field packed with zero bits", () => {
    const field = decodeGrib2(fixture("gefs-constant"));
    assert.equal(field.packing, 0);
    assert.equal(field.values.length, 1440 * 721);
    assert.ok(field.values.every((value) => value === 0));
  });

  it("names a packing template it cannot decode", () => {
    const bytes = fixture("simple-bitmap").slice();
    // Section 5 follows sections 0 (16 bytes), 1, 3 and 4; its template number is octets 10-11.
    let offset = 16;
    const view = new DataView(bytes.buffer);
    while (bytes[offset + 4] !== 5) offset += view.getUint32(offset);
    view.setUint16(offset + 9, 40);
    assert.throws(() => decodeGrib2(bytes), /5\.40/);
  });

  it("refuses bytes that are not a GRIB2 message", () => {
    assert.throws(() => decodeGrib2(new TextEncoder().encode("not a grib message")), /GRIB/);
  });
});

describe("orientGrib2Field", () => {
  it("rolls a 0-360 grid to start at -180", () => {
    const field = decodeGrib2(fixture("ccsds"));
    const out = orientGrib2Field(field, { adjustLongitudeRange: true });
    // 180 degrees east is column 24 of 48 at 7.5 degrees; it becomes the first column.
    for (const row of [0, 11, 23]) {
      assert.equal(out[row * 48], field.values[row * 48 + 24]);
      assert.equal(out[row * 48 + 23], field.values[row * 48 + 47]);
      assert.equal(out[row * 48 + 24], field.values[row * 48]);
    }
    assert.deepEqual(orientGrib2Field(field), field.values);
  });

  it("puts the north row first for a grid scanned south to north", () => {
    const field = decodeGrib2(fixture("lambert"));
    const out = orientGrib2Field(field, { northUp: true });
    assert.deepEqual(out.subarray(0, 48), field.values.subarray(23 * 48, 24 * 48));
    assert.deepEqual(out.subarray(23 * 48), field.values.subarray(0, 48));
    // The longitude roll only applies to latitude/longitude grids.
    assert.deepEqual(orientGrib2Field(field, { northUp: true, adjustLongitudeRange: true }), out);
  });
});

describe("GribberishCodec", () => {
  it("decodes a chunk in the array's orientation and type", () => {
    const codec = GribberishCodec.fromConfig(
      { var: "TMP", adjust_longitude_range: true, north_up: true },
      { shape: [1, 1, 24, 48], dataType: "float32" },
    );
    const chunk = codec.decode(fixture("lambert"));
    assert.ok(chunk.data instanceof Float32Array);
    assert.deepEqual(chunk.shape, [1, 1, 24, 48]);
    assert.deepEqual(chunk.stride, [1152, 1152, 48, 1]);
    const values = decodeGrib2(fixture("lambert")).values;
    assert.equal(chunk.data[0], Math.fround(values[23 * 48]));
  });

  it("refuses a chunk shape the message does not fill", () => {
    const codec = GribberishCodec.fromConfig({}, { shape: [1, 10, 48], dataType: "float64" });
    assert.throws(() => codec.decode(fixture("lambert")), /1152 values for a chunk of 480/);
  });

  it("refuses a non-float array", () => {
    assert.throws(
      () => GribberishCodec.fromConfig({}, { shape: [24, 48], dataType: "int16" }),
      /int16/,
    );
  });

  it("registers with zarrita once", async () => {
    const { registry } = await import("zarrita");
    await registerGribberishCodec();
    await registerGribberishCodec();
    assert.equal(await registry.get("gribberish")?.(), GribberishCodec);
  });
});
