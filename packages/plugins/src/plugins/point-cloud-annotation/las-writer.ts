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
          // A compound WKT keeps its COMPD_CS/COMPOUNDCRS prefix after
          // extraction, so ask the parsed projection, and fall back to "has a
          // geographic CRS but no projected one".
          geographic:
            (converter as unknown as { oProj?: { projName?: string } }).oProj?.projName ===
              "longlat" ||
            (!/PROJ(CS|CRS)\[/i.test(wkt) && /GEOG(CS|CRS)\[|GEODCRS\[/i.test(wkt)),
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

function writeAscii(view: DataView, offset: number, text: string, length: number): void {
  for (let i = 0; i < length; i++)
    view.setUint8(offset + i, i < text.length ? text.charCodeAt(i) & 0x7f : 0);
}

function attribute(cloud: LasExportCloud, name: string): ArrayLike<number> | undefined {
  const arr = cloud.extraAttributes?.[name];
  return arr && arr.length >= cloud.pointCount ? arr : undefined;
}

/**
 * Serialises the cloud as LAS 1.4.
 *
 * @param cloud - The loaded points, with edited classifications.
 * @param options - `softwareName` for the header; `crs` to override the output CRS.
 * @returns The file bytes.
 */
export function writeLas(
  cloud: LasExportCloud,
  options: { softwareName?: string; crs?: ExportCrs; now?: Date } = {},
): ArrayBuffer {
  const count = Math.min(cloud.pointCount, Math.floor(cloud.positions.length / 3));
  const crs = options.crs ?? resolveExportCrs(cloud.wkt);
  const hasRgb = Boolean(cloud.hasRGB && cloud.colors && cloud.colors.length >= count * 4);
  const format = hasRgb ? 7 : 6;
  const recordLength = hasRgb ? 36 : 30;
  const wktBytes = new TextEncoder().encode(`${crs.wkt}\0`);
  const pointOffset = HEADER_SIZE + VLR_HEADER_SIZE + wktBytes.length;

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
  view.setUint32(100, 1, true);
  view.setUint8(104, format);
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

  // The OGC WKT VLR.
  let offset = HEADER_SIZE;
  writeAscii(view, offset + 2, "LASF_Projection", 16);
  view.setUint16(offset + 18, 2112, true);
  view.setUint16(offset + 20, wktBytes.length, true);
  writeAscii(view, offset + 22, "OGC WKT", 32);
  new Uint8Array(buffer, offset + VLR_HEADER_SIZE, wktBytes.length).set(wktBytes);

  const returnNumber = attribute(cloud, "ReturnNumber");
  const numberOfReturns = attribute(cloud, "NumberOfReturns");
  const scanDirection = attribute(cloud, "ScanDirectionFlag");
  const edgeOfFlightLine = attribute(cloud, "EdgeOfFlightLine");
  const scannerChannel = attribute(cloud, "ScannerChannel");
  const classFlags = attribute(cloud, "ClassFlags");
  const userData = attribute(cloud, "UserData");
  const scanAngle = attribute(cloud, "ScanAngle");
  const scanAngleRank = attribute(cloud, "ScanAngleRank");
  const pointSourceId = attribute(cloud, "PointSourceId");
  const gpsTime = attribute(cloud, "GpsTime");
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
    offset += recordLength;
  }
  returnCounts.forEach((value, index) => view.setBigUint64(255 + index * 8, BigInt(value), true));
  return buffer;
}

/**
 * Builds a Segments.ai `pointcloud-segmentation` label whose
 * `point_annotations` line up index-for-index with {@link writeLas}'s output:
 * one annotation per class present, with `category_id` set to the class code.
 *
 * @param classifications - Per-point class codes, in export order.
 * @param count - Number of points exported.
 * @param names - Display name per class code, for the `categories` list.
 * @returns The label as a JSON-serialisable object.
 */
export function buildSegmentsLabel(
  classifications: Uint8Array,
  count: number,
  names: (code: number) => string,
): {
  format_version: string;
  annotations: { id: number; category_id: number }[];
  point_annotations: number[];
  categories: { id: number; name: string }[];
} {
  const idForCode = new Map<number, number>();
  const pointAnnotations = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    const code = classifications[i];
    let id = idForCode.get(code);
    if (id === undefined) {
      id = idForCode.size + 1;
      idForCode.set(code, id);
    }
    pointAnnotations[i] = id;
  }
  const codes = [...idForCode.keys()];
  return {
    format_version: "0.1",
    annotations: codes.map((code) => ({ id: idForCode.get(code) as number, category_id: code })),
    point_annotations: pointAnnotations,
    categories: codes.sort((a, b) => a - b).map((code) => ({ id: code, name: names(code) })),
  };
}
