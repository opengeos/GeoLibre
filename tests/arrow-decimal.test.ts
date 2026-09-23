import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  Decimal,
  Field,
  List,
  Struct,
  Table,
  makeData,
  makeVector,
  vectorFromArray,
} from "apache-arrow";
import {
  decodeArrowDecimal,
  decodeArrowDecimalRows,
} from "../apps/geolibre-desktop/src/lib/arrow-decimal";

/**
 * What `rowsFromResult` (duckdb-vector-loader.ts) does with a DuckDB-WASM Arrow
 * result. Re-stated here because importing that module loads DuckDB-WASM.
 */
function rowsFromResult(table: Table) {
  return decodeArrowDecimalRows(
    table.toArray().map((row) => row.toJSON() as Record<string, unknown>),
    table.schema.fields,
  );
}

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

  it("leaves rows alone when the schema has no decimal", () => {
    const rows = [{ a: 1 }];
    assert.equal(decodeArrowDecimalRows(rows, undefined), rows);
    assert.deepEqual(rowsFromResult(new Table({ a: makeVector(new Float64Array([1.5])) })), [
      { a: 1.5 },
    ]);
  });
});
