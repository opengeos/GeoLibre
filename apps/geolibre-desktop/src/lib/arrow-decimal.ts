import { DataType } from "apache-arrow";

/**
 * A field of an Arrow result schema: its column name and Arrow type. The type
 * is left loose because DuckDB-WASM ships its own apache-arrow copy; the
 * `DataType.isX` guards below compare `typeId` only, so they read either one.
 */
export interface ArrowSchemaField {
  name: string;
  type: unknown;
}

type CellConverter = (value: unknown) => unknown;

/**
 * Convert one Arrow DECIMAL cell to a plain JS value.
 *
 * Arrow hands a DECIMAL back as a `DecimalBigNum` (a `Uint32Array` subclass)
 * holding the *unscaled* integer: `5304.140817642212` arrives as the digits
 * `5304140817642212`, with the scale only recorded on the column's type. Left
 * alone it is spread into a `{0: .., 1: ..}` object and later typed as jsonb, so
 * it is rescaled here instead.
 *
 * A fractional value becomes a `number`, accepting the same rounding DuckDB
 * applies when it casts a DECIMAL to DOUBLE. A whole value (scale 0) follows the
 * bigint rule the rest of the DuckDB readers use: a `number` when it is a safe
 * integer, otherwise its exact digits as a string, so a DECIMAL(38,0) id column
 * never silently loses digits.
 *
 * @param value The raw cell; null/undefined pass through unchanged.
 * @param scale The column's DECIMAL scale (digits after the decimal point).
 * @returns The decoded number (or digit string), or the input when it is not a
 *   decimal wrapper.
 */
export function decodeArrowDecimal(value: unknown, scale: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object" && typeof value !== "bigint") return value;
  const digits = String(value);
  if (!/^-?\d+$/.test(digits)) return value;
  if (scale <= 0) {
    const whole = Number(digits);
    return Number.isSafeInteger(whole) ? whole : digits;
  }
  const negative = digits.startsWith("-");
  const magnitude = (negative ? digits.slice(1) : digits).padStart(scale + 1, "0");
  const point = magnitude.length - scale;
  return Number(`${negative ? "-" : ""}${magnitude.slice(0, point)}.${magnitude.slice(point)}`);
}

/**
 * Build a converter for a column of the given Arrow type that decodes every
 * DECIMAL it contains, including inside LIST and STRUCT values. Returns null
 * when the type holds no DECIMAL, so the common case costs nothing per row.
 */
function decimalConverter(type: unknown): CellConverter | null {
  if (DataType.isDecimal(type)) {
    const { scale } = type;
    return (value) => decodeArrowDecimal(value, scale);
  }
  if (DataType.isList(type) || DataType.isFixedSizeList(type)) {
    const child = type.children[0] ? decimalConverter(type.children[0].type) : null;
    if (!child) return null;
    return (value) =>
      value !== null && value !== undefined && typeof value === "object" && Symbol.iterator in value
        ? Array.from(value as Iterable<unknown>, child)
        : value;
  }
  if (DataType.isStruct(type)) {
    const children = type.children.flatMap((field) => {
      const convert = decimalConverter(field.type);
      return convert ? [[field.name, convert] as const] : [];
    });
    if (children.length === 0) return null;
    return (value) => {
      if (value === null || value === undefined || typeof value !== "object") return value;
      const row = value as { toJSON?: () => Record<string, unknown> };
      const out = typeof row.toJSON === "function" ? row.toJSON() : { ...row };
      for (const [name, convert] of children) out[name] = convert(out[name]);
      return out;
    };
  }
  return null;
}

/**
 * Decode the DECIMAL cells of rows read from an Arrow result, in place, using
 * the result's schema for each column's scale. Rows of a result with no
 * DECIMAL column are returned untouched.
 *
 * @param rows Plain row objects (e.g. from `StructRow.toJSON()`), keyed by
 *   column name. They are mutated and returned.
 * @param fields The result schema's fields; when absent nothing is decoded.
 * @returns The same rows, with decimals as numbers (or exact digit strings).
 */
export function decodeArrowDecimalRows<T extends Record<string, unknown>>(
  rows: T[],
  fields: ReadonlyArray<ArrowSchemaField> | undefined,
): T[] {
  if (!fields || rows.length === 0) return rows;
  const converters = fields.flatMap((field) => {
    const convert = decimalConverter(field.type);
    return convert ? [[field.name, convert] as const] : [];
  });
  if (converters.length === 0) return rows;
  for (const row of rows) {
    const record = row as Record<string, unknown>;
    for (const [name, convert] of converters) record[name] = convert(record[name]);
  }
  return rows;
}
