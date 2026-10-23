import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  Decimal,
  Dictionary,
  Field,
  Int32,
  List,
  Map_,
  Struct,
  Utf8,
  Table,
  makeData,
  makeVector,
  vectorFromArray,
} from "apache-arrow";
import {
  decodeArrowDecimal,
  decodeArrowDecimalRows,
  rowsFromResult,
} from "../apps/geolibre-desktop/src/lib/arrow-decimal";

/** Pack signed unscaled integers into Arrow's 128-bit little-endian DECIMAL words. */
function decimalWords(values: bigint[]): Uint32Array {
  const words = new Uint32Array(values.length * 4);
  values.forEach((value, row) => {
    let bits = BigInt.asUintN(128, value);
    for (let word = 0; word < 4; word += 1) {
      words[row * 4 + word] = Number(bits & 0xffffffffn);
      bits >>= 32n;
    }
  });
  return words;
}

/** A DECIMAL(precision, scale) Arrow data chunk holding the unscaled values. */
function decimalData(values: bigint[], scale: number, precision = 38) {
  return makeData({
    type: new Decimal(scale, precision, 128),
    length: values.length,
    data: decimalWords(values),
  });
}

describe("decodeArrowDecimal", () => {
  it("rescales the unscaled digits Arrow stores", () => {
    assert.equal(decodeArrowDecimal(5304140817642212n, 12), 5304.140817642212);
    assert.equal(decodeArrowDecimal(-12345n, 3), -12.345);
    assert.equal(decodeArrowDecimal(5n, 3), 0.005);
    assert.equal(decodeArrowDecimal(-5n, 3), -0.005);
  });

  it("keeps a whole decimal exact when it would overflow a double", () => {
    assert.equal(decodeArrowDecimal(42n, 0), 42);
    assert.equal(decodeArrowDecimal(123456789012345678901234n, 0), "123456789012345678901234");
  });

  it("passes non-decimal values through", () => {
    assert.equal(decodeArrowDecimal(null, 2), null);
    assert.equal(decodeArrowDecimal(undefined, 2), undefined);
    assert.equal(decodeArrowDecimal(1.5, 2), 1.5);
    assert.equal(decodeArrowDecimal("text", 2), "text");
  });
});

describe("rowsFromResult with DECIMAL columns", () => {
  it("returns plain numbers for top-level decimals (issue #2585)", () => {
    const table = new Table({
      area: makeVector(decimalData([5304140817642212n, -15n], 12)),
      id: makeVector(decimalData([7n, 123456789012345678901234n], 0)),
      name: vectorFromArray(["a", "b"]),
    });
    const rows = rowsFromResult(table);
    assert.deepEqual(rows, [
      { area: 5304.140817642212, id: 7, name: "a" },
      { area: -0.000000000015, id: "123456789012345678901234", name: "b" },
    ]);
    assert.equal(typeof rows[0].area, "number");
  });

  it("decodes decimals nested in LIST and STRUCT columns", () => {
    const itemType = new Decimal(2, 10, 128);
    const values = decimalData([125n, 250n, 375n], 2, 10);
    const list = makeData({
      type: new List(new Field("item", itemType, true)),
      length: 2,
      valueOffsets: new Int32Array([0, 2, 3]),
      child: values,
    });
    const struct = makeData({
      type: new Struct([new Field("x", itemType, true)]),
      length: 2,
      children: [decimalData([1n, -99n], 2, 10)],
    });
    const rows = rowsFromResult(new Table({ l: makeVector(list), s: makeVector(struct) }));
    assert.deepEqual(rows, [
      { l: [1.25, 2.5], s: { x: 0.01 } },
      { l: [3.75], s: { x: -0.99 } },
    ]);
  });

  it("decodes decimal values and keys in MAP columns", () => {
    const decimal = new Decimal(2, 10, 128);
    const entries = (keyType: Decimal | Utf8, valueType: Decimal | Utf8) =>
      new Struct([new Field("key", keyType, false), new Field("value", valueType, true)]);
    const keys = vectorFromArray(["a", "b"]).data[0];
    const valuesByText = makeData({
      type: new Map_(new Field("entries", entries(new Utf8(), decimal), false)),
      length: 1,
      valueOffsets: new Int32Array([0, 2]),
      child: makeData({
        type: entries(new Utf8(), decimal),
        length: 2,
        children: [keys, decimalData([125n, -250n], 2, 10)],
      }),
    });
    const textByDecimal = makeData({
      type: new Map_(new Field("entries", entries(decimal, new Utf8()), false)),
      length: 1,
      valueOffsets: new Int32Array([0, 1]),
      child: makeData({
        type: entries(decimal, new Utf8()),
        length: 1,
        children: [decimalData([150n], 2, 10), vectorFromArray(["x"]).data[0]],
      }),
    });
    const rows = rowsFromResult(
      new Table({ m: makeVector(valuesByText), mk: makeVector(textByDecimal) }),
    );
    assert.deepEqual(rows, [{ m: { a: 1.25, b: -2.5 }, mk: { "1.5": "x" } }]);
  });

  it("decodes a dictionary-encoded decimal column", () => {
    const decimal = new Decimal(2, 10, 128);
    const dictionary = makeData({
      type: new Dictionary(decimal, new Int32()),
      length: 3,
      data: new Int32Array([1, 0, 1]),
      dictionary: makeVector(decimalData([125n, -5n], 2, 10)),
    });
    assert.deepEqual(rowsFromResult(new Table({ d: makeVector(dictionary) })), [
      { d: -0.05 },
      { d: 1.25 },
      { d: -0.05 },
    ]);
  });

  it("leaves rows alone when the schema has no decimal", () => {
    const rows = [{ a: 1 }];
    assert.equal(decodeArrowDecimalRows(rows, undefined), rows);
    assert.deepEqual(rowsFromResult(new Table({ a: makeVector(new Float64Array([1.5])) })), [
      { a: 1.5 },
    ]);
  });
});
