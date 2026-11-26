/** Bound decoded allocation across every band, independently of download size. */
export const MAX_COVERAGE_SAMPLES = 8_000_000;
export type CoverageErrorCode = "response" | "grid" | "empty" | "size" | "metadata" | "bbox";
export class CoverageError extends Error {
  constructor(public readonly code: CoverageErrorCode) {
    super(code);
    this.name = "CoverageError";
  }
}

type JsonObject = Record<string, unknown>;
export function coverageObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CoverageError("response");
  return value as JsonObject;
}

/** A north-up, west-to-east raster; coordinates refer to pixel centers. */
export interface CoverageGrid {
  width: number;
  height: number;
  west: number;
  north: number;
  dx: number;
  dy: number;
  epsg: number;
  names: string[];
  bands: Float64Array[];
}

interface Axis {
  count: number;
  first: number;
  step: number;
}
const coordinateTolerance = (value: number, step: number) =>
  Math.max(Math.abs(step) * 1e-6, Number.EPSILON * Math.max(1, Math.abs(value)) * 16);

/** Decode a regular axis without allocating an expanded coordinate array. */
function axis(value: unknown): Axis {
  const item = coverageObject(value);
  const values = item.values;
  let count: number;
  let first: number;
  let step: number;
  if (Array.isArray(values)) {
    count = values.length;
    first = values[0];
    step = count > 1 ? values[1] - first : NaN;
    if (!values.every((v) => typeof v === "number" && Number.isFinite(v)))
      throw new CoverageError("grid");
    if (
      count > 1 &&
      !values.every((v, i) => Math.abs(v - (first + i * step)) <= coordinateTolerance(v, step))
    )
      throw new CoverageError("grid");
  } else {
    count = item.num as number;
    first = item.start as number;
    step = ((item.stop as number) - first) / (count - 1);
    if (typeof first !== "number" || typeof item.stop !== "number") throw new CoverageError("grid");
  }
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > MAX_COVERAGE_SAMPLES ||
    !Number.isFinite(first)
  )
    throw new CoverageError("grid");
  // Singleton axes need explicit cell bounds; there is no spacing to infer.
  if (count === 1) {
    const bounds = item.bounds;
    if (
      !Array.isArray(bounds) ||
      bounds.length !== 2 ||
      !bounds.every((v) => typeof v === "number" && Number.isFinite(v))
    )
      throw new CoverageError("grid");
    step = bounds[1] - bounds[0];
    if (Math.abs((bounds[0] + bounds[1]) / 2 - first) > coordinateTolerance(first, step))
      throw new CoverageError("grid");
  }
  if (!Number.isFinite(step) || step === 0) throw new CoverageError("grid");
  // Explicit cell edges must agree with the regular centers, otherwise a
  // single affine GeoTIFF would misrepresent the domain's cell geometry.
  if (Array.isArray(item.bounds)) {
    if (item.bounds.length !== count * 2) throw new CoverageError("grid");
    for (let i = 0; i < count; i++) {
      const edges = [item.bounds[2 * i], item.bounds[2 * i + 1]];
      if (!edges.every((v) => typeof v === "number" && Number.isFinite(v)))
        throw new CoverageError("grid");
      const lo = Math.min(...edges),
        hi = Math.max(...edges),
        center = first + i * step;
      const tolerance = coordinateTolerance(center, step);
      if (
        Math.abs(lo - (center - Math.abs(step) / 2)) > tolerance ||
        Math.abs(hi - (center + Math.abs(step) / 2)) > tolerance
      )
        throw new CoverageError("grid");
    }
  }
  return { count, first, step };
}

/** Resolve coordinate order from the declared CRS, never from object key order. */
function horizontalReference(domain: JsonObject): {
  x: string;
  y: string;
  epsg: number;
} {
  if (!Array.isArray(domain.referencing)) throw new CoverageError("grid");
  for (const raw of domain.referencing) {
    const ref = coverageObject(raw),
      system = coverageObject(ref.system);
    if (system.type !== "GeographicCRS" && system.type !== "ProjectedCRS") continue;
    if (
      !Array.isArray(ref.coordinates) ||
      ref.coordinates.length < 2 ||
      !ref.coordinates.every((c) => typeof c === "string")
    )
      throw new CoverageError("grid");
    const id = String(system.id ?? "");
    const epsg = /(?:EPSG(?::|\/0\/|::))(\d+)$/i.exec(id)?.[1];
    const crs84 = /(?:\/|:)CRS84h?$/i.test(id);
    const code = crs84 ? 4326 : Number(epsg);
    if (![4326, 4979, 3857].includes(code)) throw new CoverageError("grid");
    const latitudeFirst = !crs84 && (code === 4326 || code === 4979);
    return {
      x: ref.coordinates[latitudeFirst ? 1 : 0],
      y: ref.coordinates[latitudeFirst ? 0 : 1],
      epsg: code === 4979 ? 4326 : code,
    };
  }
  throw new CoverageError("grid");
}

/**
 * Convert numeric CoverageJSON Grid ranges to north-up bands. Linked domain
 * and range documents are resolved by the transport before calling this.
 * Extra axes must be singleton slices; arbitrary dimension permutations are
 * handled using NdArray row-major strides, including x-before-y ranges.
 */
export function parseCoverageJson(document: unknown): CoverageGrid {
  const coverage = coverageObject(document),
    domain = coverageObject(coverage.domain);
  if (
    coverage.type !== "Coverage" ||
    domain.type !== "Domain" ||
    (domain.domainType !== undefined && domain.domainType !== "Grid")
  )
    throw new CoverageError("grid");
  const axes = coverageObject(domain.axes),
    ref = horizontalReference(domain);
  const x = axis(axes[ref.x]),
    y = axis(axes[ref.y]);
  if (ref.x === ref.y) throw new CoverageError("grid");
  for (const [name, raw] of Object.entries(axes)) {
    if (name === ref.x || name === ref.y) continue;
    const extra = coverageObject(raw);
    if (Array.isArray(extra.values) ? extra.values.length !== 1 : extra.num !== 1)
      throw new CoverageError("grid");
  }
  const ranges = coverageObject(coverage.ranges);
  const names = Object.keys(ranges);
  if (!names.length) throw new CoverageError("grid");
  if (x.count * y.count * names.length > MAX_COVERAGE_SAMPLES) throw new CoverageError("size");
  const bands = names.map((name) => {
    const range = coverageObject(ranges[name]);
    if (
      range.type !== "NdArray" ||
      !["float", "integer"].includes(String(range.dataType)) ||
      (range.shape !== undefined && !Array.isArray(range.shape)) ||
      (range.axisNames !== undefined && !Array.isArray(range.axisNames)) ||
      !Array.isArray(range.values)
    )
      throw new CoverageError("grid");
    const shape: unknown[] = range.shape === undefined ? [] : (range.shape as unknown[]),
      dims: unknown[] = range.axisNames === undefined ? [] : (range.axisNames as unknown[]);
    if (
      dims.length !== shape.length ||
      new Set(dims).size !== dims.length ||
      (x.count > 1 && !dims.includes(ref.x)) ||
      (y.count > 1 && !dims.includes(ref.y))
    )
      throw new CoverageError("grid");
    const strides: number[] = [];
    let length = 1;
    for (let i = shape.length - 1; i >= 0; i--) {
      const size = shape[i];
      if (
        typeof size !== "number" ||
        !Number.isSafeInteger(size) ||
        size < 1 ||
        typeof dims[i] !== "string"
      )
        throw new CoverageError("grid");
      const expected = dims[i] === ref.x ? x.count : dims[i] === ref.y ? y.count : 1;
      if (size !== expected || !Object.hasOwn(axes, dims[i] as string))
        throw new CoverageError("grid");
      strides[i] = length;
      length *= size;
      if (length > MAX_COVERAGE_SAMPLES) throw new CoverageError("size");
    }
    if (range.values.length !== length) throw new CoverageError("grid");
    // CoverageJSON permits omission of singleton dimensions, including a
    // scalar range with no axisNames/shape. Its absent dimensions have stride 0.
    const xs = dims.includes(ref.x) ? strides[dims.indexOf(ref.x)] : 0,
      ys = dims.includes(ref.y) ? strides[dims.indexOf(ref.y)] : 0;
    const band = new Float64Array(x.count * y.count);
    for (let row = 0; row < y.count; row++) {
      const iy = y.step < 0 ? row : y.count - 1 - row;
      for (let col = 0; col < x.count; col++) {
        const ix = x.step > 0 ? col : x.count - 1 - col;
        const value = range.values[iy * ys + ix * xs];
        if (value !== null && (typeof value !== "number" || !Number.isFinite(value)))
          throw new CoverageError("grid");
        if (value !== null && range.dataType === "integer" && !Number.isSafeInteger(value))
          throw new CoverageError("grid");
        band[row * x.count + col] = value === null ? NaN : value;
      }
    }
    return band;
  });
  return {
    width: x.count,
    height: y.count,
    west: Math.min(x.first, x.first + (x.count - 1) * x.step),
    north: Math.max(y.first, y.first + (y.count - 1) * y.step),
    dx: Math.abs(x.step),
    dy: Math.abs(y.step),
    epsg: ref.epsg,
    names,
    bands,
  };
}

/**
 * Encode a Float64, pixel-interleaved strip with a dynamically sized TIFF IFD.
 * The generic geotiff.js writer reserves only 1000 directory bytes, which is
 * insufficient for many numeric bands. This layout includes only the tags
 * needed for an affine numerical raster; the COG encoder tiles it afterward.
 */
export function coverageGridTiff(grid: CoverageGrid): ArrayBuffer {
  if (![grid.width, grid.height].every((value) => Number.isSafeInteger(value) && value > 0))
    throw new CoverageError("grid");
  const pixels = grid.width * grid.height,
    bands = grid.bands.length;
  if (
    !Number.isSafeInteger(pixels) ||
    pixels < 1 ||
    !bands ||
    bands > 65535 ||
    grid.bands.some((band) => band.length !== pixels)
  )
    throw new CoverageError("grid");
  const samples = pixels * bands;
  if (samples > MAX_COVERAGE_SAMPLES) throw new CoverageError("size");
  const field = (tag: number, type: 3 | 4 | 12, values: number[]) => {
    const width = type === 3 ? 2 : type === 4 ? 4 : 8;
    const bytes = new Uint8Array(values.length * width),
      view = new DataView(bytes.buffer);
    values.forEach((value, index) => {
      if (type === 3) view.setUint16(index * width, value, true);
      else if (type === 4) view.setUint32(index * width, value, true);
      else view.setFloat64(index * width, value, true);
    });
    return { tag, type: Number(type), count: values.length, bytes, offset: 0 };
  };
  const stripOffset = field(273, 4, [0]);
  const entries = [
    field(256, 4, [grid.width]),
    field(257, 4, [grid.height]),
    field(258, 3, Array(bands).fill(64)),
    field(259, 3, [1]),
    field(262, 3, [1]),
    stripOffset,
    field(277, 3, [bands]),
    field(278, 4, [grid.height]),
    field(279, 4, [samples * 8]),
    field(284, 3, [1]),
    field(339, 3, Array(bands).fill(3)),
    field(33550, 12, [grid.dx, grid.dy, 0]),
    field(33922, 12, [0, 0, 0, grid.west - grid.dx / 2, grid.north + grid.dy / 2, 0]),
    field(34735, 3, [
      1,
      1,
      0,
      3,
      1024,
      0,
      1,
      grid.epsg === 4326 ? 2 : 1,
      1025,
      0,
      1,
      1,
      grid.epsg === 4326 ? 2048 : 3072,
      0,
      1,
      grid.epsg,
    ]),
    { tag: 42113, type: 2, count: 4, bytes: new TextEncoder().encode("nan\0"), offset: 0 },
  ];
  // Extra numeric bands have unspecified interpretation, never alpha.
  if (bands > 1) entries.push(field(338, 3, Array(bands - 1).fill(0)));
  entries.sort((a, b) => a.tag - b.tag);
  const align = (value: number) => Math.ceil(value / 8) * 8;
  let cursor = align(8 + 2 + entries.length * 12 + 4);
  for (const entry of entries)
    if (entry.bytes.length > 4) {
      entry.offset = cursor;
      cursor = align(cursor + entry.bytes.length);
    }
  new DataView(stripOffset.bytes.buffer).setUint32(0, cursor, true);
  const output = new ArrayBuffer(cursor + samples * 8),
    bytes = new Uint8Array(output),
    view = new DataView(output);
  bytes.set([0x49, 0x49]);
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);
  view.setUint16(8, entries.length, true);
  entries.forEach((entry, index) => {
    const position = 10 + index * 12;
    view.setUint16(position, entry.tag, true);
    view.setUint16(position + 2, entry.type, true);
    view.setUint32(position + 4, entry.count, true);
    if (entry.bytes.length <= 4) bytes.set(entry.bytes, position + 8);
    else {
      view.setUint32(position + 8, entry.offset, true);
      bytes.set(entry.bytes, entry.offset);
    }
  });
  for (let pixel = 0; pixel < pixels; pixel++)
    for (let band = 0; band < bands; band++)
      view.setFloat64(cursor + (pixel * bands + band) * 8, grid.bands[band][pixel], true);
  return output;
}
