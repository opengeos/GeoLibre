import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeGrib2, orientGrib2Field } from "../packages/plugins/src/plugins/grib2";
import {
  GribberishCodec,
  registerGribberishCodec,
} from "../packages/plugins/src/plugins/grib2-codec";

// --- Messages built here: simple packing (template 5.0) ---------------------------------------

interface BuildOptions {
  /** Grid template 0 (latitude/longitude) or 30 (Lambert conformal). */
  grid?: 0 | 30;
  ni: number;
  nj: number;
  /** Values in scanning order; NaN marks a point the bitmap leaves out. */
  values: number[];
  bits?: number;
  /** Decimal scale factor D: values are stored as `value * 10^D`. */
  decimal?: number;
  scanningMode?: number;
  /** Longitude of the first point and the column step, in degrees (template 0). */
  firstLongitude?: number;
  longitudeStep?: number;
}

function section(
  number: number,
  length: number,
  fill: (view: DataView, bytes: Uint8Array) => void,
) {
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, length);
  bytes[4] = number;
  fill(view, bytes);
  return bytes;
}

/** A one-field GRIB2 message with simple packing, built to the WMO layout. */
function buildGrib2(options: BuildOptions): Uint8Array {
  const { ni, nj, values, bits = 16, decimal = 0, grid = 0, scanningMode = 0 } = options;
  const present = values
    .filter((value) => !Number.isNaN(value))
    .map((value) => value * 10 ** decimal);
  const reference = Math.fround(present.length ? Math.min(...present) : 0);
  const packed = present.map((value) => Math.round(value - reference));

  const sections: Uint8Array[] = [];
  sections.push(section(1, 21, () => undefined));
  if (grid === 0) {
    sections.push(
      section(3, 72, (view, bytes) => {
        view.setUint32(5, ni * nj);
        view.setUint16(12, 0);
        view.setUint32(30, ni);
        view.setUint32(34, nj);
        view.setUint32(38, 0);
        view.setUint32(42, 0xffffffff);
        view.setUint32(50, Math.round((options.firstLongitude ?? 0) * 1e6));
        view.setUint32(63, Math.round((options.longitudeStep ?? 1) * 1e6));
        bytes[71] = scanningMode;
      }),
    );
  } else {
    sections.push(
      section(3, 81, (view, bytes) => {
        view.setUint32(5, ni * nj);
        view.setUint16(12, 30);
        view.setUint32(30, ni);
        view.setUint32(34, nj);
        bytes[64] = scanningMode;
      }),
    );
  }
  sections.push(section(4, 9, () => undefined));
  sections.push(
    section(5, 21, (view, bytes) => {
      view.setUint32(5, present.length);
      view.setUint16(9, 0);
      view.setFloat32(11, reference);
      view.setUint16(17, decimal);
      bytes[19] = bits;
    }),
  );
  const masked = values.some((value) => Number.isNaN(value));
  const bitmap = new Uint8Array(masked ? Math.ceil(values.length / 8) : 0);
  values.forEach((value, index) => {
    if (masked && !Number.isNaN(value)) bitmap[index >>> 3] |= 0x80 >>> (index & 7);
  });
  sections.push(
    section(6, 6 + bitmap.length, (_view, bytes) => {
      bytes[5] = masked ? 0 : 255;
      bytes.set(bitmap, 6);
    }),
  );
  const data = new Uint8Array(Math.ceil((packed.length * bits) / 8));
  let position = 0;
  for (const value of packed) {
    for (let bit = bits - 1; bit >= 0; bit -= 1, position += 1) {
      if (Math.floor(value / 2 ** bit) % 2) data[position >>> 3] |= 0x80 >>> (position & 7);
    }
  }
  sections.push(section(7, 5 + data.length, (_view, bytes) => bytes.set(data, 5)));
  sections.push(new TextEncoder().encode("7777"));

  const total = 16 + sections.reduce((sum, part) => sum + part.length, 0);
  const message = new Uint8Array(total);
  message.set(new TextEncoder().encode("GRIB"), 0);
  message[7] = 2;
  new DataView(message.buffer).setBigUint64(8, BigInt(total));
  let offset = 16;
  for (const part of sections) {
    message.set(part, offset);
    offset += part.length;
  }
  return message;
}

/** Where section 5 starts in a message. */
function section5(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 16;
  while (bytes[offset + 4] !== 5) offset += view.getUint32(offset);
  return offset;
}

// --- Messages encoded by ecCodes 2.49 ----------------------------------------------------------
// A 16 x 8 latitude/longitude grid (22.5 degree columns from 0 east): a smooth field with two
// rows of zeros and a noisy patch, so the CCSDS stream carries split, zero-block and uncompressed
// blocks. `grid_ccsds` at 16 bits; `grid_complex_spatial_differencing` at second order, with five
// points masked by a bitmap. The sums and samples are ecCodes' own decode.

const CCSDS =
  "R1JJQv//AAIAAAAAAAABjQAAABUBAGIAAAQAAQfXAxcMAAAAAgAAAEgDAAAAAIAAAAAAAP///////////////////wAAABAAAAAIAAAAAP////8DIRYgAAAAADCDIRYgFB3XYAFXUqAA5OHAAAAAACIEAAAAAAAAAP+AAAAAAQAAAAAB//////////////8AAAAZBQAAAIAAKsI8+fOABwAAEAAOIACAAAAABgb/AAAA2weqOfJepJXASvUkrugwVj6Fqksn+r18qfqpOGpoxFDqPDcE6QnG/ikuhWukN1oawAAAAAAAAA/////xgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADQA///wACQSMkAPOfIJHRFjDPAlCKEoGqH4IUHwGYEUBuA/X7PtN/KtfIvcCh4O+tsmgCnZgrISDYB73wACJUjAD///uFTbRRNPXlQzRMWJTVYLCF8Ik+KOEKCX49SXQXMhHTBTE0KeO8RySoReOWJsD6CPANzc3Nw==";
const COMPLEX =
  "R1JJQv//AAIAAAAAAAABUgAAABUBAGIAAAQAAQfXAxcMAAAAAgAAAEgDAAAAAIAAAAAAAP///////////////////wAAABAAAAAIAAAAAP////8DIRYgAAAAADCDIRYgFB3XYAFXUqAA5OHAAAAAACIEAAAAAAAAAP+AAAAAAQAAAAAB//////////////8AAAAxBQAAAHsAA8IlvYaAAgAACwABAGJY0ZoAAAAAAAAADAAEAAAAAgEAAAAOBQICAAAAFgYA+f////8/////////9////wAAAHgHBQYFGYUEnbNufw1aCCcoDO0AE2AkT+BXTAw1x8RgGA0BgkEWwL3tKQLUtnPe9wgEMQECNmqrwACFyMgAB6e6VtAgH86AyodWqPLSXZQSORzqPAAUJgEZewAAn0R/RoUcS7TWg8DvS2S2SFTimczLuWYiADc3Nzc=";

const decoded = (base64: string) => new Uint8Array(Buffer.from(base64, "base64"));

function assertMatchesEcCodes(
  values: Float64Array,
  expected: { sum: number; missing: number[]; samples: Record<number, number> },
): void {
  assert.equal(values.length, 128);
  let sum = 0;
  const missing: number[] = [];
  values.forEach((value, index) => {
    if (Number.isNaN(value)) missing.push(index);
    else sum += value;
  });
  assert.deepEqual(missing, expected.missing);
  assert.ok(Math.abs(sum - expected.sum) < 1e-3, `sum ${sum} != ${expected.sum}`);
  for (const [index, value] of Object.entries(expected.samples)) {
    assert.ok(Math.abs(values[Number(index)] - value) < 1e-5, `value ${index}`);
  }
}

describe("decodeGrib2", () => {
  it("matches ecCodes on CCSDS packing (template 5.42)", () => {
    const field = decodeGrib2(decoded(CCSDS));
    assert.equal(field.packing, 42);
    assertMatchesEcCodes(field.values, {
      sum: 22489.8735,
      missing: [],
      samples: { 0: 279.998096, 17: 284.310596, 37: -0.001904, 88: -18.814404, 127: 293.466846 },
    });
  });

  it("matches ecCodes on second-order complex packing with a bitmap (template 5.3)", () => {
    const field = decodeGrib2(decoded(COMPLEX));
    assert.equal(field.packing, 3);
    assertMatchesEcCodes(field.values, {
      sum: 21786.235,
      missing: [5, 6, 40, 41, 100],
      samples: { 0: 280.064919, 17: 284.314919, 37: 0.064919, 88: -40.685081, 127: 293.564919 },
    });
  });

  it("decodes simple packing with a bitmap and a decimal scale (template 5.0)", () => {
    const values = [12.3, Number.NaN, -4.5, 0, 7.7, Number.NaN, 21.1, 3.3];
    const field = decodeGrib2(buildGrib2({ ni: 4, nj: 2, values, decimal: 1 }));
    assert.equal(field.packing, 0);
    values.forEach((value, index) => {
      if (Number.isNaN(value)) assert.ok(Number.isNaN(field.values[index]));
      else assert.ok(Math.abs(field.values[index] - value) < 1e-4, `value ${index}`);
    });
  });

  it("reads the grid of a latitude/longitude and a Lambert message", () => {
    const latlon = decodeGrib2(decoded(CCSDS)).grid;
    assert.deepEqual(
      { template: latlon.template, ni: latlon.ni, nj: latlon.nj, scanning: latlon.scanningMode },
      { template: 0, ni: 16, nj: 8, scanning: 0 },
    );
    assert.equal(latlon.firstLongitude, 0);
    assert.equal(latlon.longitudeStep, 22.5);
    const values = Array.from({ length: 6 }, (_, index) => index);
    const lambert = decodeGrib2(buildGrib2({ grid: 30, ni: 3, nj: 2, values, scanningMode: 0x40 }));
    assert.deepEqual(
      { template: lambert.grid.template, ni: lambert.grid.ni, nj: lambert.grid.nj },
      { template: 30, ni: 3, nj: 2 },
    );
    assert.equal(lambert.grid.scanningMode, 0x40);
  });

  it("decodes a constant field packed with zero bits", () => {
    const field = decodeGrib2(buildGrib2({ ni: 4, nj: 3, values: Array(12).fill(5), bits: 0 }));
    assert.deepEqual([...field.values], Array(12).fill(5));
  });

  it("fails on a truncated message rather than reading zeros", () => {
    const values = Array.from({ length: 64 }, (_, index) => index);
    const bytes = buildGrib2({ ni: 8, nj: 8, values });
    // Drop the end of the data section and the end marker; the section header still claims them,
    // so the section is refused for running past the buffer.
    assert.throws(() => decodeGrib2(bytes.subarray(0, bytes.length - 40)), /Corrupt GRIB section/);
  });

  it("refuses a value count larger than the grid before allocating for it", () => {
    const bytes = buildGrib2({ ni: 4, nj: 2, values: Array(8).fill(1) });
    // Section 5 octets 6-9: the number of encoded values.
    new DataView(bytes.buffer).setUint32(section5(bytes) + 5, 0xfffffff0);
    assert.throws(() => decodeGrib2(bytes), /values for 8 grid points/);
  });

  it("refuses groups that cover fewer values than the message declares", () => {
    const bytes = decoded(COMPLEX);
    const view = new DataView(bytes.buffer);
    // 123 values are encoded (128 points less 5 masked); claim two more.
    const offset = section5(bytes) + 5;
    view.setUint32(offset, view.getUint32(offset) + 2);
    assert.throws(() => decodeGrib2(bytes), /groups hold 123 values, not 125/);
  });

  it("refuses a spatial differencing order it does not implement", () => {
    const bytes = decoded(COMPLEX);
    // Template 5.3 octet 48: the order of spatial differencing (1 or 2).
    bytes[section5(bytes) + 47] = 3;
    assert.throws(() => decodeGrib2(bytes), /order 3/);
  });

  it("names a packing template it cannot decode", () => {
    const bytes = buildGrib2({ ni: 2, nj: 2, values: [1, 2, 3, 4] });
    // Section 5 octets 10-11: the data representation template.
    new DataView(bytes.buffer).setUint16(section5(bytes) + 9, 40);
    assert.throws(() => decodeGrib2(bytes), /5\.40/);
  });

  it("refuses bytes that are not a GRIB2 message", () => {
    assert.throws(() => decodeGrib2(new TextEncoder().encode("not a grib message")), /GRIB/);
  });
});

describe("orientGrib2Field", () => {
  it("rolls a 0-360 grid to start at -180", () => {
    const field = decodeGrib2(decoded(CCSDS));
    const out = orientGrib2Field(field, { adjustLongitudeRange: true });
    // 180 degrees east is column 8 of 16 at 22.5 degrees; it becomes the first column.
    for (const row of [0, 3, 7]) {
      assert.equal(out[row * 16], field.values[row * 16 + 8]);
      assert.equal(out[row * 16 + 7], field.values[row * 16 + 15]);
      assert.equal(out[row * 16 + 8], field.values[row * 16]);
    }
    assert.deepEqual(orientGrib2Field(field), field.values);
  });

  it("puts the north row first for a grid scanned south to north", () => {
    const values = [1, 2, 3, 4, 5, 6];
    const field = decodeGrib2(buildGrib2({ grid: 30, ni: 3, nj: 2, values, scanningMode: 0x40 }));
    assert.deepEqual([...orientGrib2Field(field, { northUp: true })], [4, 5, 6, 1, 2, 3]);
    // Left as scanned unless asked, and the longitude roll only applies to latitude/longitude.
    assert.deepEqual([...orientGrib2Field(field)], values);
    assert.deepEqual(
      [...orientGrib2Field(field, { northUp: true, adjustLongitudeRange: true })],
      [4, 5, 6, 1, 2, 3],
    );
  });
});

describe("GribberishCodec", () => {
  const lambert = () =>
    buildGrib2({ grid: 30, ni: 3, nj: 2, values: [1, 2, 3, 4, 5, 6], scanningMode: 0x40 });

  it("decodes a chunk in the array's orientation and type", () => {
    const codec = GribberishCodec.fromConfig(
      { var: "TMP", adjust_longitude_range: true, north_up: true },
      { shape: [1, 1, 2, 3], dataType: "float32" },
    );
    const chunk = codec.decode(lambert());
    assert.ok(chunk.data instanceof Float32Array);
    assert.deepEqual(chunk.shape, [1, 1, 2, 3]);
    assert.deepEqual(chunk.stride, [6, 6, 3, 1]);
    assert.deepEqual([...chunk.data], [4, 5, 6, 1, 2, 3]);
  });

  it("refuses a chunk shape the message does not fill", () => {
    const codec = GribberishCodec.fromConfig({}, { shape: [1, 10, 3], dataType: "float64" });
    assert.throws(() => codec.decode(lambert()), /6 values for a chunk of 30/);
  });

  it("refuses a non-float array", () => {
    assert.throws(
      () => GribberishCodec.fromConfig({}, { shape: [2, 3], dataType: "int16" }),
      /int16/,
    );
  });

  it("registers with zarrita once", async () => {
    const { registry } = await import("zarrita");
    await registerGribberishCodec();
    await registerGribberishCodec();
    assert.equal(await registry.get("gribberish")?.(), GribberishCodec);
  });

  it("decodes a chunk read through zarrita, as a virtual repository is read", async () => {
    const zarr = await import("zarrita");
    await registerGribberishCodec();
    const metadata = {
      zarr_format: 3,
      node_type: "array",
      shape: [1, 2, 3],
      data_type: "float64",
      chunk_grid: { name: "regular", configuration: { chunk_shape: [1, 2, 3] } },
      chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
      fill_value: "NaN",
      codecs: [
        { name: "scale_offset", configuration: { offset: -273.15 } },
        { name: "gribberish", configuration: { var: "TMP", north_up: true } },
      ],
    };
    const files = new Map<string, Uint8Array>([
      ["/t/zarr.json", new TextEncoder().encode(JSON.stringify(metadata))],
      ["/t/c/0/0/0", lambert()],
    ]);
    const store = { get: async (key: string) => files.get(key) };
    const array = await zarr.open.v3(zarr.root(store).resolve("t"), { kind: "array" });
    const chunk = await zarr.get(array);
    assert.deepEqual(chunk.shape, [1, 2, 3]);
    // North row first, then scale_offset's decode adds the offset.
    const expected = [4, 5, 6, 1, 2, 3].map((value) => value - 273.15);
    (chunk.data as Float64Array).forEach((value, index) =>
      assert.ok(Math.abs(value - expected[index]) < 1e-9),
    );
  });
});
