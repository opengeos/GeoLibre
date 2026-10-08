/**
 * A GRIB2 decoder for the messages dynamical.org's virtual Icechunk repositories point at.
 *
 * Those repositories reference the producers' GRIB2 files byte range by byte range, one message
 * per Zarr chunk, and name the `gribberish` codec, which has no JavaScript build. This covers what
 * their messages actually use:
 *
 * - grids: template 3.0 (latitude/longitude: GFS, GEFS, ECMWF) and 3.30 (Lambert conformal: HRRR);
 * - packing: templates 5.0 (simple), 5.2/5.3 (complex, with spatial differencing: NOAA) and 5.42
 *   (CCSDS: ECMWF);
 * - the section 6 bitmap and template 5.2/5.3's missing-value substitutes, both decoding to NaN.
 *
 * Anything else throws, naming the template, rather than drawing wrong numbers.
 */

import { decodeAec } from "./grib2-aec";

/**
 * The largest grid decoded: 16 million points, eight times the largest grid a virtual repository
 * references (HRRR, 1.9 million). A decode holds a few float64 copies of the field, so this keeps
 * one to about 128 MB each, where a corrupt message could otherwise ask for gigabytes.
 */
const MAX_GRID_POINTS = 16_000_000;

/** What a decoded field's grid looks like. */
export interface Grib2Grid {
  /** The grid definition template (3.x). */
  template: number;
  /** Points along a row. */
  ni: number;
  /** Rows. */
  nj: number;
  /** The scanning mode flags (code table 3.4). */
  scanningMode: number;
  /** Longitude of the first point and the column step in degrees, for a latitude/longitude grid. */
  firstLongitude?: number;
  longitudeStep?: number;
}

/** One decoded field. */
export interface Grib2Field {
  grid: Grib2Grid;
  /** The data representation template (5.x). */
  packing: number;
  /** Values in the order the message scans them; NaN where the bitmap or packing marks missing. */
  values: Float64Array;
}

/** Sign-and-magnitude integers, which is how GRIB2 stores every signed field. */
function signMagnitude(value: number, bits: number): number {
  const sign = 2 ** (bits - 1);
  return value >= sign ? -(value - sign) : value;
}

/** Big-endian reads within a message. */
class Octets {
  readonly view: DataView;

  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u8(offset: number): number {
    return this.bytes[offset];
  }

  u16(offset: number): number {
    return this.view.getUint16(offset);
  }

  u32(offset: number): number {
    return this.view.getUint32(offset);
  }

  s16(offset: number): number {
    return signMagnitude(this.u16(offset), 16);
  }

  s32(offset: number): number {
    return signMagnitude(this.u32(offset), 32);
  }

  /** A sign-and-magnitude integer `width` bytes wide. */
  signed(offset: number, width: number): number {
    let value = 0;
    for (let index = 0; index < width; index += 1) value = value * 256 + this.bytes[offset + index];
    return signMagnitude(value, width * 8);
  }

  f32(offset: number): number {
    return this.view.getFloat32(offset);
  }
}

/** A big-endian bit cursor, for the packed integers of section 7. */
class BitCursor {
  position: number;

  constructor(
    private readonly bytes: Uint8Array,
    start = 0,
  ) {
    this.position = start * 8;
  }

  read(count: number): number {
    if (count === 0) return 0;
    let value = 0;
    let remaining = count;
    while (remaining > 0) {
      const byte = this.bytes[this.position >>> 3];
      // A truncated message must fail, not decode the missing tail as zeros.
      if (byte === undefined) throw new Error("GRIB2 data section ended early");
      const offset = this.position & 7;
      const take = Math.min(8 - offset, remaining);
      value = value * (1 << take) + ((byte >>> (8 - offset - take)) & ((1 << take) - 1));
      this.position += take;
      remaining -= take;
    }
    return value;
  }

  align(): void {
    this.position = (this.position + 7) & ~7;
  }
}

/** The packing parameters every template shares: `Y = (R + X * 2^E) / 10^D`. */
interface Scaling {
  reference: number;
  binaryScale: number;
  decimalScale: number;
  bits: number;
}

function scale(scaling: Scaling, packed: number): number {
  return (scaling.reference + packed * 2 ** scaling.binaryScale) / 10 ** scaling.decimalScale;
}

function parseGrid(section: Octets, start: number): Grib2Grid {
  const template = section.u16(start + 12);
  if (template === 0) {
    const ni = section.u32(start + 30);
    const nj = section.u32(start + 34);
    const basicAngle = section.u32(start + 38);
    const subdivisions = section.u32(start + 42);
    // Microdegrees unless the grid names another unit (template 3.0 note 1); a zero or missing
    // subdivision count names none.
    const unit =
      basicAngle === 0 ||
      basicAngle === 0xffffffff ||
      subdivisions === 0 ||
      subdivisions === 0xffffffff
        ? 1e-6
        : basicAngle / subdivisions;
    const increment = section.u32(start + 63);
    return {
      template,
      ni,
      nj,
      scanningMode: section.u8(start + 71),
      firstLongitude: section.s32(start + 50) * unit,
      // All ones is "missing": no step, so the longitude roll is skipped.
      ...(increment === 0xffffffff ? {} : { longitudeStep: increment * unit }),
    };
  }
  if (template === 30) {
    return {
      template,
      ni: section.u32(start + 30),
      nj: section.u32(start + 34),
      scanningMode: section.u8(start + 64),
    };
  }
  throw new Error(`Unsupported GRIB2 grid template 3.${template}`);
}

/** Template 5.0: every value is `bits` wide. */
function unpackSimple(data: Uint8Array, count: number, scaling: Scaling): Float64Array {
  const out = new Float64Array(count);
  if (scaling.bits === 0) return out.fill(scale(scaling, 0));
  const cursor = new BitCursor(data);
  for (let index = 0; index < count; index += 1)
    out[index] = scale(scaling, cursor.read(scaling.bits));
  return out;
}

/**
 * Templates 5.2 and 5.3: values split into groups, each with its own reference and width, with
 * (5.3) first- or second-order differencing on top. A port of g2c's `comunpack`.
 */
function unpackComplex(
  section5: Octets,
  start5: number,
  data: Uint8Array,
  count: number,
  scaling: Scaling,
  spatial: boolean,
): Float64Array {
  const missingManagement = section5.u8(start5 + 22);
  const groups = section5.u32(start5 + 31);
  const widthReference = section5.u8(start5 + 35);
  const widthBits = section5.u8(start5 + 36);
  const lengthReference = section5.u32(start5 + 37);
  const lengthIncrement = section5.u8(start5 + 41);
  const lastLength = section5.u32(start5 + 42);
  const lengthBits = section5.u8(start5 + 46);
  const order = spatial ? section5.u8(start5 + 47) : 0;
  const extraOctets = spatial ? section5.u8(start5 + 48) : 0;
  // Every group holds at least one value, so more groups than values is a corrupt count that
  // would otherwise size the arrays below.
  if (groups > count)
    throw new Error(`GRIB2 message declares ${groups} groups for ${count} values`);

  const out = new Float64Array(count);
  const missing = new Uint8Array(count);
  const cursor = new BitCursor(data);

  // Template 5.3 leads with the differencing's initial values and its overall minimum.
  if (
    spatial &&
    (order < 1 || order > 2 || extraOctets < 1 || data.length < (order + 1) * extraOctets)
  ) {
    throw new Error(
      `Unsupported GRIB2 spatial differencing (order ${order}, ${extraOctets} extra octets)`,
    );
  }
  const initial: number[] = [];
  let minimum = 0;
  if (order > 0) {
    const reader = new Octets(data);
    for (let index = 0; index < order; index += 1) {
      initial.push(reader.signed(index * extraOctets, extraOctets));
    }
    minimum = reader.signed(order * extraOctets, extraOctets);
    cursor.position = (order + 1) * extraOctets * 8;
  }

  const references = new Array<number>(groups);
  for (let group = 0; group < groups; group += 1) references[group] = cursor.read(scaling.bits);
  cursor.align();
  const widths = new Array<number>(groups);
  for (let group = 0; group < groups; group += 1) {
    widths[group] = widthReference + cursor.read(widthBits);
  }
  cursor.align();
  const lengths = new Array<number>(groups);
  for (let group = 0; group < groups; group += 1) {
    lengths[group] = lengthReference + cursor.read(lengthBits) * lengthIncrement;
  }
  cursor.align();
  if (groups > 0) lengths[groups - 1] = lastLength;

  const allOnes = (bits: number) => 2 ** bits - 1;
  let index = 0;
  for (let group = 0; group < groups; group += 1) {
    const reference = references[group];
    const width = widths[group];
    const length = lengths[group];
    if (width === 0) {
      // A constant group, or a run of missing values.
      let flag = 0;
      if (missingManagement >= 1 && reference === allOnes(scaling.bits)) flag = 1;
      if (missingManagement === 2 && reference === allOnes(scaling.bits) - 1) flag = 2;
      for (let n = 0; n < length && index < count; n += 1, index += 1) {
        out[index] = reference;
        missing[index] = flag;
      }
    } else {
      for (let n = 0; n < length && index < count; n += 1, index += 1) {
        const value = cursor.read(width);
        let flag = 0;
        if (missingManagement >= 1 && value === allOnes(width)) flag = 1;
        if (missingManagement === 2 && value === allOnes(width) - 1) flag = 2;
        out[index] = reference + value;
        missing[index] = flag;
      }
    }
  }

  // Group lengths that cover fewer values than declared would leave zeros that decode as data.
  if (index !== count) throw new Error(`GRIB2 groups hold ${index} values, not ${count}`);

  // Undo the differencing over the values that are present.
  if (order > 0) {
    let seen = 0;
    let last = 0;
    let beforeLast = 0;
    for (let n = 0; n < count; n += 1) {
      if (missing[n]) continue;
      let value: number;
      if (seen < order) {
        value = initial[seen];
      } else if (order === 1) {
        value = out[n] + minimum + last;
      } else {
        value = out[n] + minimum + 2 * last - beforeLast;
      }
      out[n] = value;
      beforeLast = last;
      last = value;
      seen += 1;
    }
  }

  for (let n = 0; n < count; n += 1) out[n] = missing[n] ? Number.NaN : scale(scaling, out[n]);
  return out;
}

/** Template 5.42: CCSDS-compressed integers, scaled like simple packing. */
function unpackCcsds(
  section5: Octets,
  start5: number,
  data: Uint8Array,
  count: number,
  scaling: Scaling,
): Float64Array {
  if (scaling.bits === 0) return new Float64Array(count).fill(scale(scaling, 0));
  const samples = decodeAec(data, count, {
    bitsPerSample: scaling.bits,
    flags: section5.u8(start5 + 21),
    blockSize: section5.u8(start5 + 22),
    rsi: section5.u16(start5 + 23),
  });
  for (let n = 0; n < count; n += 1) samples[n] = scale(scaling, samples[n]);
  return samples;
}

/**
 * Decode the first field of a GRIB2 message.
 *
 * Args:
 *   bytes: One whole message, `GRIB` through `7777`.
 *
 * Returns:
 *   The field's grid and values, one per grid point, in the message's scanning order.
 */
export function decodeGrib2(bytes: Uint8Array): Grib2Field {
  const message = new Octets(bytes);
  if (bytes.length < 16 || String.fromCharCode(...bytes.subarray(0, 4)) !== "GRIB") {
    throw new Error("Not a GRIB message");
  }
  if (message.u8(7) !== 2) throw new Error(`Unsupported GRIB edition ${message.u8(7)}`);

  let grid: Grib2Grid | null = null;
  let packing = -1;
  let start5 = -1;
  let encodedCount = 0;
  let bitmap: Uint8Array | null = null;
  let offset = 16;
  while (offset + 5 <= bytes.length) {
    if (
      bytes[offset] === 0x37 &&
      bytes[offset + 1] === 0x37 &&
      bytes[offset + 2] === 0x37 &&
      bytes[offset + 3] === 0x37
    ) {
      break;
    }
    const length = message.u32(offset);
    const number = message.u8(offset + 4);
    if (length < 5) throw new Error("Corrupt GRIB section");
    if (number === 3) {
      grid = parseGrid(message, offset);
    } else if (number === 5) {
      start5 = offset;
      encodedCount = message.u32(offset + 5);
      packing = message.u16(offset + 9);
    } else if (number === 6) {
      const indicator = message.u8(offset + 5);
      if (indicator === 0) bitmap = bytes.subarray(offset + 6, offset + length);
      else if (indicator !== 255)
        throw new Error(`Unsupported GRIB2 bitmap indicator ${indicator}`);
    } else if (number === 7) {
      if (!grid || start5 < 0) throw new Error("GRIB2 data section before its grid or packing");
      // The counts size the decode's arrays, so a corrupt one is refused before it allocates.
      const points = grid.ni * grid.nj;
      if (points > MAX_GRID_POINTS || encodedCount > points) {
        throw new Error(`GRIB2 message declares ${encodedCount} values for ${points} grid points`);
      }
      const data = bytes.subarray(offset + 5, offset + length);
      const scaling: Scaling = {
        reference: message.f32(start5 + 11),
        binaryScale: message.s16(start5 + 15),
        decimalScale: message.s16(start5 + 17),
        bits: message.u8(start5 + 19),
      };
      let packed: Float64Array;
      if (packing === 0) packed = unpackSimple(data, encodedCount, scaling);
      else if (packing === 2 || packing === 3) {
        packed = unpackComplex(message, start5, data, encodedCount, scaling, packing === 3);
      } else if (packing === 42) {
        packed = unpackCcsds(message, start5, data, encodedCount, scaling);
      } else throw new Error(`Unsupported GRIB2 packing template 5.${packing}`);
      return { grid, packing, values: applyBitmap(packed, bitmap, grid.ni * grid.nj) };
    }
    offset += length;
  }
  throw new Error("GRIB message has no data section");
}

/** Spread the encoded values over the grid points the bitmap marks present; NaN elsewhere. */
function applyBitmap(
  packed: Float64Array,
  bitmap: Uint8Array | null,
  points: number,
): Float64Array {
  if (!bitmap) {
    if (packed.length !== points) {
      throw new Error(`GRIB2 field holds ${packed.length} values for ${points} grid points`);
    }
    return packed;
  }
  const out = new Float64Array(points);
  let next = 0;
  for (let point = 0; point < points; point += 1) {
    const present = (bitmap[point >>> 3] >>> (7 - (point & 7))) & 1;
    out[point] = present ? (packed[next++] ?? Number.NaN) : Number.NaN;
  }
  return out;
}

/** How to lay a decoded field out, matching the `gribberish` codec's options. */
export interface Grib2LayoutOptions {
  /** Put the northernmost row first. */
  northUp?: boolean;
  /** Roll a 0-360 latitude/longitude grid so its columns run from -180. */
  adjustLongitudeRange?: boolean;
}

/**
 * Lay a field out row by row, west to east, in the orientation the Zarr array declares.
 *
 * Returns:
 *   `nj * ni` values, row-major.
 */
export function orientGrib2Field(
  field: Grib2Field,
  options: Grib2LayoutOptions = {},
): Float64Array {
  const { ni, nj, scanningMode } = field.grid;
  if (scanningMode & 0x30) {
    throw new Error(`Unsupported GRIB2 scanning mode ${scanningMode}`);
  }
  const westward = (scanningMode & 0x80) !== 0;
  const northward = (scanningMode & 0x40) !== 0;
  const flipRows = northward && options.northUp === true;

  let roll = 0;
  if (
    options.adjustLongitudeRange &&
    field.grid.template === 0 &&
    field.grid.firstLongitude !== undefined &&
    field.grid.longitudeStep
  ) {
    // The column whose longitude, wrapped into [-180, 180), is westernmost comes first.
    const step = field.grid.longitudeStep;
    const first = westward
      ? field.grid.firstLongitude - (ni - 1) * step
      : field.grid.firstLongitude;
    const wrapped = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;
    let westernmost = Number.POSITIVE_INFINITY;
    for (let column = 0; column < ni; column += 1) {
      const lon = wrapped(first + column * step);
      if (lon < westernmost - 1e-9) {
        westernmost = lon;
        roll = column;
      }
    }
  }

  const out = new Float64Array(ni * nj);
  for (let row = 0; row < nj; row += 1) {
    const sourceRow = flipRows ? nj - 1 - row : row;
    for (let column = 0; column < ni; column += 1) {
      const eastward = (column + roll) % ni;
      const sourceColumn = westward ? ni - 1 - eastward : eastward;
      out[row * ni + column] = field.values[sourceRow * ni + sourceColumn];
    }
  }
  return out;
}
