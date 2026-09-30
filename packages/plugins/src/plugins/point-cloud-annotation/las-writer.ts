// Writes the annotated points back out as an uncompressed LAS 1.4 file (point
// data record format 6, or 7 with RGB), reprojected to the source CRS when its
// WKT is known so the result lines up with the original survey.

import proj4 from "proj4";

/** The loaded point data the writer reads (maplibre-gl-lidar's `PointCloudData`). */
export interface LasExportCloud {
  /** `[dLng, dLat, z]` offsets from `coordinateOrigin`; Z is in metres. */
  positions: Float32Array;
  coordinateOrigin: readonly [number, number, number];
  pointCount: number;
  classifications?: Uint8Array;
  /** 0-1, rescaled to the LAS 16-bit range. */
  intensities?: Float32Array;
  /** RGBA, 8 bits per channel. */
  colors?: Uint8Array;
  hasRGB?: boolean;
  extraAttributes?: Record<string, ArrayLike<number>>;
  /** Per-point object (instance) ids, 0 for none; written as an extra dimension. */
  instances?: Uint32Array;
  /** The source file's WKT, if it had one. */
  wkt?: string;
}

/** WGS 84 as WKT1, written when the source CRS is unknown or unparseable. */
export const WGS84_WKT =
  'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]]';

/**
 * Extracts the horizontal `PROJCS[...]` from a compound WKT. Mirrors
 * maplibre-gl-lidar's loader so export inverts exactly what load applied.
 *
 * @param wkt - A WKT1 string, possibly `COMPD_CS[...]`.
 * @returns The horizontal part, or `wkt` unchanged.
 */
export function extractProjcsFromWkt(wkt: string): string {
  if (!wkt.startsWith("COMPD_CS[")) return wkt;
  const start = wkt.indexOf("PROJCS[");
  if (start === -1) return wkt;
  let depth = 0;
  for (let i = start; i < wkt.length; i++) {
    if (wkt[i] === "[") depth++;
    if (wkt[i] === "]") {
      depth--;
      if (depth === 0) return wkt.substring(start, i + 1);
    }
  }
  return wkt;
}

/**
 * The factor the loader multiplied Z by to get metres (feet-based CRSs).
 * Mirrors maplibre-gl-lidar's `getVerticalUnitConversionFactor`.
 *
 * @param wkt - The source WKT.
 * @returns Metres per source vertical unit.
 */
export function verticalUnitFactor(wkt: string): number {
  const lower = wkt.toLowerCase();
  if (
    lower.includes("us survey foot") ||
    lower.includes("us_survey_foot") ||
    lower.includes("foot_us")
  ) {
    return 0.3048006096012192;
  }
  const footPatterns = [
    /unit\s*\[\s*"foot/i,
    /unit\s*\[\s*"international foot/i,
    /,\s*foot\s*\]/i,
    /"ft"/i,
  ];
  return footPatterns.some((pattern) => pattern.test(wkt)) ? 0.3048 : 1;
}

/** The CRS the export is written in. */
export interface ExportCrs {
  wkt: string;
  geographic: boolean;
  /** Longitude/latitude to CRS X/Y. */
  forward: (lng: number, lat: number) => [number, number];
  /** Divides metres to get the CRS vertical unit. */
  zFactor: number;
}

/**
 * Chooses the output CRS: the source's own when proj4 can parse it, else WGS 84.
 *
 * @param wkt - The source WKT, if any.
 * @returns The CRS to write.
 */
export function resolveExportCrs(wkt: string | undefined): ExportCrs {
  if (wkt && wkt.trim()) {
    try {
      const converter = proj4("EPSG:4326", extractProjcsFromWkt(wkt));
      const probe = converter.forward([0, 0]);
      if (probe.every((value) => Number.isFinite(value))) {
        return {
          wkt,
          // Decided from the WKT text rather than proj4's internals: geographic
          // when it has a geographic CRS but no projected one, which also
          // covers a COMPD_CS/COMPOUNDCRS wrapper.
          geographic: !/PROJ(CS|CRS)\[/i.test(wkt) && /GEOG(CS|CRS)\[|GEODCRS\[/i.test(wkt),
          forward: (lng, lat) => converter.forward([lng, lat]) as [number, number],
          zFactor: verticalUnitFactor(wkt),
        };
      }
    } catch {
      // Fall through to WGS 84.
    }
  }
  return { wkt: WGS84_WKT, geographic: true, forward: (lng, lat) => [lng, lat], zFactor: 1 };
}

const HEADER_SIZE = 375;
const VLR_HEADER_SIZE = 54;

/** Bytes the `instance` extra dimension adds to every point record. */
export const INSTANCE_EXTRA_BYTES = 4;

/**
 * Whether the export carries object ids (so records get the extra dimension).
 *
 * @param cloud - The export.
 * @param count - Points written.
 * @returns True when `instances` covers every point.
 */
function hasInstances(cloud: LasExportCloud, count: number): boolean {
  return Boolean(cloud.instances && cloud.instances.length >= count);
}

/**
 * The LAS 1.4 Extra Bytes VLR payload describing a uint32 `instance`
 * dimension (one 192-byte descriptor), which laspy, PDAL and LAStools read.
 *
 * @returns The VLR data.
 */
export function instanceExtraBytesDescriptor(): Uint8Array {
  const data = new Uint8Array(192);
  const view = new DataView(data.buffer);
  data[2] = 6; // data_type: unsigned long (uint32)
  data[3] = 0; // options: no no_data/min/max/scale/offset
  writeAscii(view, 4, "instance", 32);
  writeAscii(view, 160, "Object (instance) id, 0 = none", 32);
  return data;
}

function writeAscii(view: DataView, offset: number, text: string, length: number): void {
  for (let i = 0; i < length; i++)
    view.setUint8(offset + i, i < text.length ? text.charCodeAt(i) & 0x7f : 0);
}

function attribute(
  cloud: LasExportCloud,
  name: string,
  count: number,
): ArrayLike<number> | undefined {
  const arr = cloud.extraAttributes?.[name];
  return arr && arr.length >= count ? arr : undefined;
}

/** A variable length record appended after the WKT VLR. */
export interface LasVlr {
  userId: string;
  recordId: number;
  description: string;
  data: Uint8Array;
}

/** Options for {@link writeLas}. */
export interface WriteLasOptions {
  softwareName?: string;
  /** Overrides the output CRS (defaults to the cloud's own, else WGS 84). */
  crs?: ExportCrs;
  now?: Date;
  /** VLRs written after the WKT one (e.g. the LASzip VLR for a LAZ file). */
  extraVlrs?: LasVlr[];
  /** OR-ed into the header's point data format byte (0x80 marks LAZ). */
  pointFormatFlags?: number;
}

/**
 * Serialises the cloud as LAS 1.4.
 *
 * @param cloud - The loaded points, with edited classifications.
 * @param options - Header, CRS and extra-VLR options.
 * @returns The file bytes.
 */
export function writeLas(cloud: LasExportCloud, options: WriteLasOptions = {}): ArrayBuffer {
  const count = Math.min(cloud.pointCount, Math.floor(cloud.positions.length / 3));
  const crs = options.crs ?? resolveExportCrs(cloud.wkt);
  const hasRgb = Boolean(cloud.hasRGB && cloud.colors && cloud.colors.length >= count * 4);
  const format = hasRgb ? 7 : 6;
  const standardLength = hasRgb ? 36 : 30;
  const withInstances = hasInstances(cloud, count);
  const recordLength = standardLength + (withInstances ? INSTANCE_EXTRA_BYTES : 0);
  const wktBytes = new TextEncoder().encode(`${crs.wkt}\0`);
  const vlrs: LasVlr[] = [
    { userId: "LASF_Projection", recordId: 2112, description: "OGC WKT", data: wktBytes },
    ...(withInstances
      ? [
          {
            userId: "LASF_Spec",
            recordId: 4,
            description: "Extra Bytes",
            data: instanceExtraBytesDescriptor(),
          },
        ]
      : []),
    ...(options.extraVlrs ?? []),
  ];
  // A VLR's payload length is a uint16; a longer one (e.g. a huge WKT)
  // would corrupt every offset after it.
  for (const vlr of vlrs) {
    if (vlr.data.length > 0xffff) throw new Error(`VLR "${vlr.userId}" exceeds 65535 bytes`);
  }
  const pointOffset = vlrs.reduce(
    (offset, vlr) => offset + VLR_HEADER_SIZE + vlr.data.length,
    HEADER_SIZE,
  );

  // Project every point once, tracking the bounds for the header.
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const zs = new Float64Array(count);
  const bounds = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
  const [lng0, lat0] = cloud.coordinateOrigin;
  for (let i = 0; i < count; i++) {
    const [x, y] = crs.forward(lng0 + cloud.positions[i * 3], lat0 + cloud.positions[i * 3 + 1]);
    const z = cloud.positions[i * 3 + 2] / crs.zFactor;
    xs[i] = x;
    ys[i] = y;
    zs[i] = z;
    if (x < bounds[0]) bounds[0] = x;
    if (x > bounds[1]) bounds[1] = x;
    if (y < bounds[2]) bounds[2] = y;
    if (y > bounds[3]) bounds[3] = y;
    if (z < bounds[4]) bounds[4] = z;
    if (z > bounds[5]) bounds[5] = z;
  }
  if (count === 0) bounds.fill(0);
  const xyScale = crs.geographic ? 1e-7 : 0.001;
  const zScale = 0.001;
  const offsets = [
    Math.floor((bounds[0] + bounds[1]) / 2),
    Math.floor((bounds[2] + bounds[3]) / 2),
    Math.floor((bounds[4] + bounds[5]) / 2),
  ];

  const buffer = new ArrayBuffer(pointOffset + count * recordLength);
  const view = new DataView(buffer);
  writeAscii(view, 0, "LASF", 4);
  // Global encoding: WKT CRS (bit 4) and standard GPS time (bit 0), which
  // LAS 1.4 requires for point formats 6-10.
  view.setUint16(6, 0x11, true);
  view.setUint8(24, 1);
  view.setUint8(25, 4);
  writeAscii(view, 26, "GeoLibre", 32);
  writeAscii(view, 58, options.softwareName ?? "GeoLibre point cloud annotator", 32);
  const now = options.now ?? new Date();
  const dayOfYear = Math.floor(
    (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
      Date.UTC(now.getUTCFullYear(), 0, 0)) /
      86400000,
  );
  view.setUint16(90, dayOfYear, true);
  view.setUint16(92, now.getUTCFullYear(), true);
  view.setUint16(94, HEADER_SIZE, true);
  view.setUint32(96, pointOffset, true);
  view.setUint32(100, vlrs.length, true);
  view.setUint8(104, format | (options.pointFormatFlags ?? 0));
  view.setUint16(105, recordLength, true);
  // Legacy point counts (offsets 107-130) stay 0, as LAS 1.4 allows for formats 6-10.
  view.setFloat64(131, xyScale, true);
  view.setFloat64(139, xyScale, true);
  view.setFloat64(147, zScale, true);
  view.setFloat64(155, offsets[0], true);
  view.setFloat64(163, offsets[1], true);
  view.setFloat64(171, offsets[2], true);
  view.setFloat64(179, bounds[1], true);
  view.setFloat64(187, bounds[0], true);
  view.setFloat64(195, bounds[3], true);
  view.setFloat64(203, bounds[2], true);
  view.setFloat64(211, bounds[5], true);
  view.setFloat64(219, bounds[4], true);
  view.setBigUint64(247, BigInt(count), true);

  let offset = HEADER_SIZE;
  for (const vlr of vlrs) {
    writeAscii(view, offset + 2, vlr.userId, 16);
    view.setUint16(offset + 18, vlr.recordId, true);
    view.setUint16(offset + 20, vlr.data.length, true);
    writeAscii(view, offset + 22, vlr.description, 32);
    new Uint8Array(buffer, offset + VLR_HEADER_SIZE, vlr.data.length).set(vlr.data);
    offset += VLR_HEADER_SIZE + vlr.data.length;
  }

  const returnNumber = attribute(cloud, "ReturnNumber", count);
  const numberOfReturns = attribute(cloud, "NumberOfReturns", count);
  const scanDirection = attribute(cloud, "ScanDirectionFlag", count);
  const edgeOfFlightLine = attribute(cloud, "EdgeOfFlightLine", count);
  const scannerChannel = attribute(cloud, "ScannerChannel", count);
  const classFlags = attribute(cloud, "ClassFlags", count);
  const userData = attribute(cloud, "UserData", count);
  const scanAngle = attribute(cloud, "ScanAngle", count);
  const scanAngleRank = attribute(cloud, "ScanAngleRank", count);
  const pointSourceId = attribute(cloud, "PointSourceId", count);
  const gpsTime = attribute(cloud, "GpsTime", count);
  const returnCounts = new Array<number>(15).fill(0);

  offset = pointOffset;
  for (let i = 0; i < count; i++) {
    view.setInt32(offset, Math.round((xs[i] - offsets[0]) / xyScale), true);
    view.setInt32(offset + 4, Math.round((ys[i] - offsets[1]) / xyScale), true);
    view.setInt32(offset + 8, Math.round((zs[i] - offsets[2]) / zScale), true);
    const intensity = cloud.intensities?.[i];
    view.setUint16(
      offset + 12,
      intensity === undefined ? 0 : Math.round(Math.min(1, Math.max(0, intensity)) * 65535),
      true,
    );
    const ret = Math.min(15, Math.max(1, returnNumber?.[i] ?? 1));
    const returns = Math.min(15, Math.max(ret, numberOfReturns?.[i] ?? 1));
    returnCounts[ret - 1]++;
    view.setUint8(offset + 14, ret | (returns << 4));
    view.setUint8(
      offset + 15,
      ((classFlags?.[i] ?? 0) & 0x0f) |
        (((scannerChannel?.[i] ?? 0) & 0x03) << 4) |
        (((scanDirection?.[i] ?? 0) & 0x01) << 6) |
        (((edgeOfFlightLine?.[i] ?? 0) & 0x01) << 7),
    );
    view.setUint8(offset + 16, cloud.classifications?.[i] ?? 1);
    view.setUint8(offset + 17, userData?.[i] ?? 0);
    const angleDegrees = scanAngle?.[i] ?? scanAngleRank?.[i] ?? 0;
    view.setInt16(
      offset + 18,
      Math.max(-30000, Math.min(30000, Math.round(angleDegrees / 0.006))),
      true,
    );
    view.setUint16(offset + 20, pointSourceId?.[i] ?? 0, true);
    view.setFloat64(offset + 22, gpsTime?.[i] ?? 0, true);
    if (hasRgb && cloud.colors) {
      view.setUint16(offset + 30, cloud.colors[i * 4] * 257, true);
      view.setUint16(offset + 32, cloud.colors[i * 4 + 1] * 257, true);
      view.setUint16(offset + 34, cloud.colors[i * 4 + 2] * 257, true);
    }
    if (withInstances) view.setUint32(offset + standardLength, cloud.instances![i], true);
    offset += recordLength;
  }
  returnCounts.forEach((value, index) => view.setBigUint64(255 + index * 8, BigInt(value), true));
  return buffer;
}

/**
 * Builds a Segments.ai `pointcloud-segmentation` label whose
 * `point_annotations` line up index-for-index with {@link writeLas}'s output.
 * Each object (instance) becomes its own annotation; points in no object get
 * one annotation per class. `category_id` is the class code.
 *
 * @param classifications - Per-point class codes, in export order.
 * @param count - Number of points exported.
 * @param names - Display name per class code, for the `categories` list.
 * @param instances - Per-point object ids (0 for none), in export order.
 * @returns The label as a JSON-serialisable object.
 */
export function buildSegmentsLabel(
  classifications: Uint8Array,
  count: number,
  names: (code: number) => string,
  instances?: Uint32Array,
): {
  format_version: string;
  annotations: { id: number; category_id: number }[];
  point_annotations: number[];
  categories: { id: number; name: string }[];
} {
  // Keyed by class, and object id when there is one, so a point relabelled
  // after joining an object still gets its own class.
  const idForKey = new Map<number, { id: number; code: number }>();
  const pointAnnotations = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    const code = classifications[i];
    const instance = instances && i < instances.length ? instances[i] : 0;
    const key = instance * 256 + code;
    let entry = idForKey.get(key);
    if (entry === undefined) {
      entry = { id: idForKey.size + 1, code };
      idForKey.set(key, entry);
    }
    pointAnnotations[i] = entry.id;
  }
  const codes = [...new Set([...idForKey.values()].map((entry) => entry.code))];
  return {
    format_version: "0.1",
    annotations: [...idForKey.values()].map(({ id, code }) => ({ id, category_id: code })),
    point_annotations: pointAnnotations,
    categories: codes.sort((a, b) => a - b).map((code) => ({ id: code, name: names(code) })),
  };
}

/** The two calls {@link writeLaz} needs from the laz-rs WASM encoder. */
export interface LazEncoder {
  laszip_vlr_data(pointFormat: number, extraBytes: number): Uint8Array;
  compress_points(
    prefix: Uint8Array,
    points: Uint8Array,
    pointFormat: number,
    extraBytes: number,
    recordLength: number,
  ): Uint8Array;
}

/**
 * Serialises the cloud as LAZ (LASzip-compressed LAS 1.4): the same header and
 * records as {@link writeLas}, plus the LASzip VLR, with the point records
 * compressed by laz-rs.
 *
 * @param cloud - The loaded points, with edited classifications.
 * @param encoder - The initialised laz-rs WASM encoder.
 * @param options - Header and CRS options.
 * @returns The file bytes.
 */
export function writeLaz(
  cloud: LasExportCloud,
  encoder: LazEncoder,
  options: Omit<WriteLasOptions, "extraVlrs" | "pointFormatFlags"> = {},
): Uint8Array {
  const count = Math.min(cloud.pointCount, Math.floor(cloud.positions.length / 3));
  const hasRgb = Boolean(cloud.hasRGB && cloud.colors && cloud.colors.length >= count * 4);
  const format = hasRgb ? 7 : 6;
  const extraBytes = hasInstances(cloud, count) ? INSTANCE_EXTRA_BYTES : 0;
  const recordLength = (hasRgb ? 36 : 30) + extraBytes;
  const laszip: LasVlr = {
    userId: "laszip encoded",
    recordId: 22204,
    description: "laz-rs",
    data: encoder.laszip_vlr_data(format, extraBytes),
  };
  const bytes = new Uint8Array(
    writeLas(cloud, {
      // maplibre-gl-lidar <= 0.18.0 detects LAZ by "laszip" in this field
      // (copc.js strips the 0x80 format bit), so name it to stay readable.
      softwareName: "GeoLibre annotator (LASzip)",
      ...options,
      extraVlrs: [laszip],
      pointFormatFlags: 0x80,
    }),
  );
  const pointOffset = new DataView(bytes.buffer).getUint32(96, true);
  return encoder.compress_points(
    bytes.subarray(0, pointOffset),
    bytes.subarray(pointOffset),
    format,
    extraBytes,
    recordLength,
  );
}

/**
 * Serialises the cloud as a NumPy `.npy` structured array, ready for
 * `numpy.load` in a training pipeline: one record per point with `x`, `y`,
 * `z` (float64, in the same CRS and units as {@link writeLas}), `intensity`
 * (uint16), `classification` (uint8), when the cloud has colour, `red`,
 * `green`, `blue` (uint8), and with objects, `instance` (uint32, 0 for none).
 *
 * @param cloud - The loaded points, with edited classifications.
 * @param options - `crs` to override the output CRS.
 * @returns The file bytes.
 */
export function writeNpy(cloud: LasExportCloud, options: { crs?: ExportCrs } = {}): Uint8Array {
  const count = Math.min(cloud.pointCount, Math.floor(cloud.positions.length / 3));
  const crs = options.crs ?? resolveExportCrs(cloud.wkt);
  const hasRgb = Boolean(cloud.hasRGB && cloud.colors && cloud.colors.length >= count * 4);
  const withInstances = hasInstances(cloud, count);
  const fields: [string, string, number][] = [
    ["x", "<f8", 8],
    ["y", "<f8", 8],
    ["z", "<f8", 8],
    ["intensity", "<u2", 2],
    ["classification", "|u1", 1],
    ...(hasRgb
      ? ([
          ["red", "|u1", 1],
          ["green", "|u1", 1],
          ["blue", "|u1", 1],
        ] as [string, string, number][])
      : []),
    ...(withInstances ? ([["instance", "<u4", 4]] as [string, string, number][]) : []),
  ];
  const recordSize = fields.reduce((sum, [, , size]) => sum + size, 0);
  const descr = fields.map(([name, type]) => `('${name}', '${type}')`).join(", ");
  let header = `{'descr': [${descr}], 'fortran_order': False, 'shape': (${count},), }`;
  // Magic (6) + version (2) + length (2) + header, padded with spaces to a
  // multiple of 64 bytes and ending in a newline, per the .npy v1.0 format.
  const unpadded = 10 + header.length + 1;
  header += " ".repeat((64 - (unpadded % 64)) % 64) + "\n";
  const bytes = new Uint8Array(10 + header.length + count * recordSize);
  const view = new DataView(bytes.buffer);
  bytes.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0]);
  view.setUint16(8, header.length, true);
  for (let i = 0; i < header.length; i++) bytes[10 + i] = header.charCodeAt(i);
  const [lng0, lat0] = cloud.coordinateOrigin;
  let offset = 10 + header.length;
  for (let i = 0; i < count; i++) {
    const [x, y] = crs.forward(lng0 + cloud.positions[i * 3], lat0 + cloud.positions[i * 3 + 1]);
    view.setFloat64(offset, x, true);
    view.setFloat64(offset + 8, y, true);
    view.setFloat64(offset + 16, cloud.positions[i * 3 + 2] / crs.zFactor, true);
    const intensity = cloud.intensities?.[i];
    view.setUint16(
      offset + 24,
      intensity === undefined ? 0 : Math.round(Math.min(1, Math.max(0, intensity)) * 65535),
      true,
    );
    view.setUint8(offset + 26, cloud.classifications?.[i] ?? 1);
    if (hasRgb && cloud.colors) {
      view.setUint8(offset + 27, cloud.colors[i * 4]);
      view.setUint8(offset + 28, cloud.colors[i * 4 + 1]);
      view.setUint8(offset + 29, cloud.colors[i * 4 + 2]);
    }
    if (withInstances) view.setUint32(offset + recordSize - 4, cloud.instances![i], true);
    offset += recordSize;
  }
  return bytes;
}

/**
 * Copies a subset of a cloud's points (in the given order) into a new cloud,
 * e.g. one tile of a larger session for a tool with a memory limit.
 *
 * @param cloud - The source cloud.
 * @param indices - Points to keep.
 * @returns A cloud holding just those points.
 */
export function subsetCloud(cloud: LasExportCloud, indices: ArrayLike<number>): LasExportCloud {
  const n = indices.length;
  const positions = new Float32Array(n * 3);
  const classifications = cloud.classifications ? new Uint8Array(n) : undefined;
  const intensities = cloud.intensities ? new Float32Array(n) : undefined;
  const colors = cloud.colors ? new Uint8Array(n * 4) : undefined;
  const instances = cloud.instances ? new Uint32Array(n) : undefined;
  const extraAttributes: Record<string, number[]> = {};
  const extras = Object.entries(cloud.extraAttributes ?? {});
  for (const [name] of extras) extraAttributes[name] = new Array<number>(n);
  for (let k = 0; k < n; k++) {
    const i = indices[k];
    positions[k * 3] = cloud.positions[i * 3];
    positions[k * 3 + 1] = cloud.positions[i * 3 + 1];
    positions[k * 3 + 2] = cloud.positions[i * 3 + 2];
    if (classifications) classifications[k] = cloud.classifications![i];
    if (intensities) intensities[k] = cloud.intensities![i];
    if (instances) instances[k] = cloud.instances![i] ?? 0;
    if (colors) {
      colors[k * 4] = cloud.colors![i * 4];
      colors[k * 4 + 1] = cloud.colors![i * 4 + 1];
      colors[k * 4 + 2] = cloud.colors![i * 4 + 2];
      colors[k * 4 + 3] = cloud.colors![i * 4 + 3];
    }
    for (const [name, values] of extras) extraAttributes[name][k] = values[i];
  }
  return {
    positions,
    coordinateOrigin: cloud.coordinateOrigin,
    pointCount: n,
    classifications,
    intensities,
    colors,
    hasRGB: cloud.hasRGB,
    extraAttributes,
    instances,
    wkt: cloud.wkt,
  };
}

/**
 * A file-name stem for a point cloud's exports: its name without a
 * LAS/LAZ/COPC extension, with unsafe characters replaced.
 *
 * @param name - The cloud's display name.
 * @returns The stem, or "point-cloud" when nothing is left.
 */
export function safeFileStem(name: string): string {
  const stem = name.replace(/\.(copc\.)?la[sz]$/i, "").replace(/[^\w.-]+/g, "_");
  return stem || "point-cloud";
}
