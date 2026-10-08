import { getVectorColorRamp } from "@geolibre/core";
import type { PointPrimitiveCollection } from "@cesium/engine";

// Point clouds on the globe (issue #2285).
//
// The 2D map streams LiDAR through the LiDAR control's deck.gl overlay, which
// has no Cesium interop. On the globe a point cloud takes one of two native
// paths: a source already in 3D Tiles form (a `tileset.json`, the format
// Cesium was built for, with `pointCloudShading` for eye-dome lighting) loads
// as a `Cesium3DTileset`; a Cloud Optimized Point Cloud (`.copc.laz`) is
// decoded in the browser with the `copc` package — the same decoder the 2D
// control uses — and drawn as a `PointPrimitiveCollection`. A plain LAS or
// LAZ file has no octree to sample, so it is downloaded whole (up to
// {@link MAX_LAS_FILE_BYTES}), decoded with the same package's LAS reader,
// and thinned to every n-th point (issue #2261). An Entwine Point Tile (EPT)
// dataset is walked breadth-first like COPC, its LASzip nodes decoded with
// that LAS reader.
//
// The COPC path is a bounded preview, not a streaming renderer: it walks the
// octree breadth-first from the root, which COPC populates with a coarse
// sample of the whole cloud, and stops at {@link MAX_POINT_CLOUD_POINTS}.
// That keeps memory bounded (each primitive is a JavaScript object) while
// showing the cloud's shape at every zoom; a level-of-detail streamer is the
// follow-up once Cesium exposes a public point-cloud primitive.

type CesiumNs = typeof import("@cesium/engine");

/** Points a COPC preview loads at most. */
export const MAX_POINT_CLOUD_POINTS = 400_000;

/** Pixel size of a decoded point on the globe. */
export const POINT_CLOUD_PIXEL_SIZE = 2;

/** How the globe can draw a point-cloud URL. */
export type PointCloudSourceKind = "tileset" | "copc" | "las" | "ept" | null;

/**
 * Classify a point-cloud layer's URL: a 3D Tiles tileset, a COPC archive, a
 * plain LAS/LAZ file, or an Entwine Point Tile manifest. An EPT manifest is
 * JSON too, but not a tileset, so it is matched by name before the tileset
 * rule rather than failing inside `Cesium3DTileset.fromUrl`.
 */
export function pointCloudSourceKind(url: string | undefined): PointCloudSourceKind {
  if (!url) return null;
  const path = url.split(/[?#]/)[0].toLowerCase();
  if (path.endsWith("/ept.json") || path === "ept.json") return "ept";
  if (path.endsWith(".json")) return "tileset";
  if (path.endsWith(".copc.laz")) return "copc";
  if (path.endsWith(".las") || path.endsWith(".laz")) return "las";
  return null;
}

/** Whether a Gaussian-splat layer's URL is a 3D Tiles tileset the globe can load. */
export function isSplatTilesetUrl(url: string | undefined): boolean {
  return pointCloudSourceKind(url) === "tileset";
}

/** A decoded, reprojected point cloud ready to become primitives. */
export interface DecodedPointCloud {
  /** `[lng, lat, height, ...]` per point, WGS84 degrees and metres. */
  positions: Float64Array;
  /** `[r, g, b, ...]` per point, 0–255, or `null` when the cloud carries no colour. */
  colors: Uint8Array | null;
  count: number;
  zMin: number;
  zMax: number;
  /** Whether the budget cut the walk short. */
  truncated: boolean;
}

/** The slice of the `copc` package the loader uses (injectable for tests). */
export interface CopcModule {
  Copc: {
    create(source: string): Promise<{
      header: {
        scale: number[];
        offset: number[];
        pointCount: number;
        min: number[];
        max: number[];
      };
      info: { rootHierarchyPage: { pageOffset: number; pageLength: number } };
      wkt?: string;
    }>;
    loadHierarchyPage(
      source: string,
      page: { pageOffset: number; pageLength: number },
    ): Promise<{
      nodes: Record<
        string,
        { pointCount: number; pointDataOffset: number; pointDataLength: number } | undefined
      >;
      pages: Record<string, { pageOffset: number; pageLength: number } | undefined>;
    }>;
    loadPointDataView(
      source: string,
      copc: unknown,
      node: { pointCount: number; pointDataOffset: number; pointDataLength: number },
      options?: { include?: string[]; lazPerf?: unknown },
    ): Promise<{
      pointCount: number;
      dimensions: Record<string, unknown>;
      getter(name: string): (index: number) => number;
    }>;
  };
}

/** A reprojection from the cloud's CRS to WGS84 degrees (injectable for tests). */
export type PointCloudProjector = (x: number, y: number) => [number, number];

export interface LoadCopcOptions {
  /** Points to stop at; defaults to {@link MAX_POINT_CLOUD_POINTS}. */
  budget?: number;
  signal?: AbortSignal;
  /** The `copc` module; defaults to a dynamic import. */
  copc?: CopcModule;
  /**
   * The LAZ decoder handed to `copc`; defaults to laz-perf's wasm build with
   * its binary located through a Vite asset URL. The emscripten loader on its
   * own resolves `laz-perf.wasm` against the page, not the module, and under
   * a bundler that fetches the app's HTML instead.
   */
  lazPerf?: () => Promise<unknown>;
  /**
   * Builds the CRS → WGS84 projector from the cloud's WKT; defaults to
   * proj4. Returns `null` for a cloud with no usable CRS, which the loader
   * refuses rather than reading raw coordinates as degrees.
   */
  projector?: (wkt: string | undefined) => Promise<PointCloudProjector | null>;
}

/** The dimensions every decoder reads; Classification only to drop noise. */
const POINT_DIMENSIONS = ["X", "Y", "Z", "Red", "Green", "Blue", "Classification"];

/** ASPRS low (7) and high (18) noise, which 2D viewers hide and which would stretch the height ramp. */
const NOISE_CLASSES = new Set([7, 18]);

/**
 * A per-point noise test for a decoded view, or null when the point format
 * carries no classification.
 */
function noiseTest(view: {
  dimensions: Record<string, unknown>;
  getter(name: string): (index: number) => number;
}): ((index: number) => boolean) | null {
  if (!("Classification" in view.dimensions)) return null;
  const classification = view.getter("Classification");
  return (index) => NOISE_CLASSES.has(classification(index));
}

/** Heights sampled at most when estimating a cloud's height range. */
const HEIGHT_RANGE_SAMPLE = 20_000;

/**
 * The span the height ramp stretches over: the 1st to 99th percentile of the
 * decoded heights, so a few unclassified outliers (a bird, a multipath
 * return hundreds of metres off) do not squash every real point into one
 * colour. A small cloud reads as its exact minimum and maximum.
 *
 * @param positions - `[lng, lat, height, ...]`.
 * @param count - Points filled in `positions`.
 * @returns `{ zMin, zMax }`, both 0 for an empty cloud.
 */
export function heightRange(
  positions: Float64Array,
  count: number,
): { zMin: number; zMax: number } {
  if (count <= 0) return { zMin: 0, zMax: 0 };
  const step = Math.max(1, Math.floor(count / HEIGHT_RANGE_SAMPLE));
  const heights: number[] = [];
  for (let i = 0; i < count; i += step) heights.push(positions[i * 3 + 2]);
  heights.sort((a, b) => a - b);
  const last = heights.length - 1;
  return {
    zMin: heights[Math.floor(last * 0.01)],
    zMax: heights[Math.ceil(last * 0.99)],
  };
}

/** Octree key depth: keys are `D-X-Y-Z`. */
function keyDepth(key: string): number {
  return Number(key.split("-")[0]);
}

async function defaultLazPerf(): Promise<unknown> {
  const [{ createLazPerf }, wasmUrl] = await Promise.all([
    import("laz-perf"),
    import("laz-perf/lib/web/laz-perf.wasm?url").then((m) => m.default),
  ]);
  return createLazPerf({ locateFile: () => wasmUrl });
}

/** Angular WKT units, which never scale a height. */
const ANGULAR_UNIT = /^(degree|radian|grad|gon|arc)/i;

/**
 * Metres per height unit in a WKT: the unit of its vertical CRS when it has
 * one, else, following the LAS convention PDAL and LAStools use, the
 * projected CRS's linear unit (a state-plane cloud in US feet has its heights
 * in feet too). A geographic CRS with no vertical part reads as metres.
 *
 * @param wkt - OGC WKT (1 or 2).
 * @returns The metres-per-unit factor, 1 when none applies.
 */
export function wktHeightScale(wkt: string | undefined): number {
  if (!wkt) return 1;
  const unitFactor = (block: string): number | undefined => {
    const units = [...block.matchAll(/(?:LENGTH)?UNIT\[\s*"([^"]*)"\s*,\s*([0-9.eE+-]+)/g)];
    const linear = units.filter((u) => !ANGULAR_UNIT.test(u[1]));
    const factor = Number(linear.at(-1)?.[2]);
    return Number.isFinite(factor) && factor > 0 ? factor : undefined;
  };
  const vertical = wkt.match(/VERT(?:_CS|CRS)\[[\s\S]*$/);
  if (vertical) return unitFactor(vertical[0]) ?? 1;
  if (!/PROJ(?:CS|CRS)\[/.test(wkt)) return 1;
  return unitFactor(wkt) ?? 1;
}

/**
 * The horizontal CRS of a compound WKT (`COMPD_CS`, or WKT2's `COMPOUNDCRS`),
 * which proj4 cannot parse whole: point clouds commonly pair a projected CRS
 * with a vertical one (Autzen is Oregon Lambert in feet + NAVD88). Any other
 * WKT is returned unchanged.
 *
 * @param wkt - OGC WKT.
 * @returns The WKT proj4 should build its converter from.
 */
export function horizontalWkt(wkt: string): string {
  const trimmed = wkt.trim();
  if (!/^(COMPD_CS|COMPOUNDCRS)\[/i.test(trimmed)) return wkt;
  const child = /(PROJCS|GEOGCS|PROJCRS|GEOGCRS|GEODCRS|BASEGEOGCRS)\[/gi;
  const match = child.exec(trimmed);
  if (!match) return wkt;
  // Scan to the bracket that closes this child, skipping quoted names.
  let depth = 0;
  let quoted = false;
  for (let i = match.index + match[1].length; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "[") depth++;
    else if (!quoted && ch === "]" && --depth === 0) return trimmed.slice(match.index, i + 1);
  }
  return wkt;
}

async function proj4Projector(wkt: string | undefined): Promise<PointCloudProjector | null> {
  if (!wkt) return null;
  const proj4 = (await import("proj4")).default;
  try {
    const converter = proj4(horizontalWkt(wkt), "EPSG:4326");
    return (x, y) => {
      const [lng, lat] = converter.forward([x, y]);
      return [lng, lat];
    };
  } catch {
    return null;
  }
}

/**
 * Decode a bounded preview of a COPC archive: the octree walked
 * breadth-first from the root, points reprojected to WGS84, colour kept
 * when the point format carries one.
 */
export async function loadCopcPointCloud(
  url: string,
  options: LoadCopcOptions = {},
): Promise<DecodedPointCloud> {
  // A NaN, infinite, or fractional budget would size buffers badly; normalise.
  const budget = Number.isFinite(options.budget)
    ? Math.max(1, Math.floor(options.budget as number))
    : MAX_POINT_CLOUD_POINTS;
  const signal = options.signal;
  const { Copc } = options.copc ?? ((await import("copc")) as unknown as CopcModule);
  const copc = await Copc.create(url);
  signal?.throwIfAborted();
  const project = await (options.projector ?? proj4Projector)(copc.wkt);
  // Without a projector the raw X/Y would be fed to the globe as degrees and
  // land a projected cloud somewhere near Null Island; refuse instead.
  if (!project) {
    throw new Error(
      copc.wkt
        ? `COPC archive has no usable CRS (could not parse its WKT: ${copc.wkt.slice(0, 80)})`
        : "COPC archive has no usable CRS (no WKT in the header)",
    );
  }
  const lazPerf = await (options.lazPerf ?? defaultLazPerf)();
  signal?.throwIfAborted();
  // Heights in the CRS's units (often feet) become metres for the globe.
  const zScale = wktHeightScale(copc.wkt);

  // Breadth-first over the hierarchy: pages are loaded lazily as the walk
  // reaches keys that live in a deeper page, and the walk stops at the budget.
  const root = await Copc.loadHierarchyPage(url, copc.info.rootHierarchyPage);
  const nodes = new Map(Object.entries(root.nodes));
  const pages = new Map(Object.entries(root.pages));
  // The frontier starts from both the nodes the root page carries and the keys
  // it only points at through sub-pages (the normal case for a large cloud).
  const keys = [...new Set([...nodes.keys(), ...pages.keys()])].sort(
    (a, b) => keyDepth(a) - keyDepth(b),
  );
  const chosen: string[] = [];
  const chosenKeys = new Set<string>();
  let planned = 0;
  let truncated = false;
  while (keys.length && planned < budget) {
    const key = keys.shift()!;
    const node = nodes.get(key);
    if (!node) {
      // The node's data lives in a sub-page; load it and queue its keys.
      const page = pages.get(key);
      if (!page) continue;
      const subtree = await Copc.loadHierarchyPage(url, page);
      signal?.throwIfAborted();
      const queued = new Set(keys);
      for (const [k, n] of Object.entries(subtree.nodes)) {
        if (n) nodes.set(k, n);
        if (!queued.has(k) && !chosenKeys.has(k)) {
          keys.push(k);
          queued.add(k);
        }
      }
      for (const [k, p] of Object.entries(subtree.pages)) {
        if (p) pages.set(k, p);
        if (!queued.has(k) && !nodes.has(k)) {
          keys.push(k);
          queued.add(k);
        }
      }
      pages.delete(key);
      keys.sort((a, b) => keyDepth(a) - keyDepth(b));
      continue;
    }
    if (node.pointCount === 0) continue;
    if (planned + node.pointCount > budget) {
      if (chosen.length > 0) {
        truncated = true;
        break;
      }
      // A first node bigger than the whole budget is read partially, so the
      // primitive count never exceeds the budget.
      truncated = true;
    }
    chosen.push(key);
    chosenKeys.add(key);
    planned = Math.min(budget, planned + node.pointCount);
  }
  if (keys.length) truncated = true;

  const positions = new Float64Array(planned * 3);
  // A LAS file has one point record format, so the first node decides whether
  // the cloud carries RGB and the buffer is allocated up front. Should a node
  // ever disagree, the cloud is treated as colourless rather than leaving
  // those points black: `undefined` until the first node, `null` for no colour.
  let colors: Uint8Array | null | undefined;
  let count = 0;
  for (const key of chosen) {
    const node = nodes.get(key)!;
    const view = await Copc.loadPointDataView(url, copc, node, {
      include: POINT_DIMENSIONS,
      lazPerf,
    });
    signal?.throwIfAborted();
    const x = view.getter("X");
    const y = view.getter("Y");
    const z = view.getter("Z");
    const hasColor =
      "Red" in view.dimensions && "Green" in view.dimensions && "Blue" in view.dimensions;
    if (colors === undefined) colors = hasColor ? new Uint8Array(planned * 3) : null;
    else if (hasColor !== (colors !== null)) colors = null;
    const r = colors ? view.getter("Red") : null;
    const g = colors ? view.getter("Green") : null;
    const b = colors ? view.getter("Blue") : null;
    const isNoise = noiseTest(view);
    for (let i = 0; i < view.pointCount && count < planned; i++) {
      if (isNoise?.(i)) continue;
      const [lng, lat] = project(x(i), y(i));
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      const height = z(i) * zScale;
      positions[count * 3] = lng;
      positions[count * 3 + 1] = lat;
      positions[count * 3 + 2] = height;
      if (colors && r && g && b) {
        // LAS colour is 16-bit; many writers store 8-bit values unscaled.
        const scale = (v: number) => (v > 255 ? v >> 8 : v);
        colors[count * 3] = scale(r(i));
        colors[count * 3 + 1] = scale(g(i));
        colors[count * 3 + 2] = scale(b(i));
      }
      count++;
    }
  }
  return {
    positions: count === planned ? positions : positions.subarray(0, count * 3),
    colors: colors ? (count === planned ? colors : colors.subarray(0, count * 3)) : null,
    count,
    ...heightRange(positions, count),
    truncated,
  };
}

/** The hex colours of a ramp, sampled at `t` in [0, 1]. */
export function rampColor(colors: readonly string[], t: number): [number, number, number] {
  if (colors.length === 0) return [128, 128, 128];
  const clamped = Math.min(1, Math.max(0, t));
  const position = clamped * (colors.length - 1);
  const index = Math.floor(position);
  const next = Math.min(colors.length - 1, index + 1);
  const f = position - index;
  const parse = (hex: string): [number, number, number] => {
    const h = hex.replace("#", "");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  };
  const a = parse(colors[index]);
  const b = parse(colors[next]);
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

/** The 0–255 colour of point `i`: its own RGB, else its height on the ramp. */
export function pointCloudColor(
  cloud: DecodedPointCloud,
  i: number,
  ramp: readonly string[],
): [number, number, number] {
  if (cloud.colors) return [cloud.colors[i * 3], cloud.colors[i * 3 + 1], cloud.colors[i * 3 + 2]];
  const span = cloud.zMax - cloud.zMin;
  const t = span > 0 ? (cloud.positions[i * 3 + 2] - cloud.zMin) / span : 0.5;
  return rampColor(ramp, t);
}

/**
 * Turn a decoded cloud into primitives: one point each, coloured by RGB or
 * by height on the viridis ramp (the 2D control's `elevation` scheme),
 * drawn through terrain so a cloud sitting on relief is never buried.
 */
export function buildPointCloudCollection(
  Cesium: CesiumNs,
  cloud: DecodedPointCloud,
  opacity: number,
  altitudeOffset = 0,
): PointPrimitiveCollection {
  const collection = new Cesium.PointPrimitiveCollection();
  const ramp = getVectorColorRamp("viridis").colors;
  const alpha = Math.min(1, Math.max(0, opacity));
  // The layer's altitude offset lifts every point, as it does a tileset.
  const lift = Number.isFinite(altitudeOffset) ? altitudeOffset : 0;
  for (let i = 0; i < cloud.count; i++) {
    const [r, g, b] = pointCloudColor(cloud, i, ramp);
    collection.add({
      position: Cesium.Cartesian3.fromDegrees(
        cloud.positions[i * 3],
        cloud.positions[i * 3 + 1],
        cloud.positions[i * 3 + 2] + lift,
      ),
      pixelSize: POINT_CLOUD_PIXEL_SIZE,
      color: new Cesium.Color(r / 255, g / 255, b / 255, alpha),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });
  }
  return collection;
}

/** Re-apply the layer opacity to every primitive of a cloud in place. */
export function setPointCloudOpacity(collection: PointPrimitiveCollection, opacity: number): void {
  const alpha = Math.min(1, Math.max(0, opacity));
  for (let i = 0; i < collection.length; i++) {
    const point = collection.get(i);
    const color = point.color;
    if (color.alpha !== alpha) point.color = color.withAlpha(alpha);
  }
}

// --- Plain LAS / LAZ -------------------------------------------------------

/**
 * Largest plain LAS/LAZ download, and largest decoded point buffer, the globe
 * accepts for a preview. Unlike COPC, a plain file cannot be read in part, so
 * a bigger one is refused with a hint to convert it rather than stalling the
 * tab.
 */
export const MAX_LAS_FILE_BYTES = 512 * 1024 * 1024;

/** The LAS header fields the loader reads (`copc`'s `Las.Header`). */
export interface LasHeader {
  majorVersion: number;
  minorVersion: number;
  pointDataOffset: number;
  pointDataRecordFormat: number;
  pointDataRecordLength: number;
  pointCount: number;
  headerLength: number;
  vlrCount: number;
  evlrOffset: number;
  evlrCount: number;
}

/** One variable-length record (`copc`'s `Las.Vlr`). */
export interface LasVlr {
  userId: string;
  recordId: number;
  contentOffset: number;
  contentLength: number;
}

/** A decoded point view (`copc`'s `Las.View`). */
interface LasPointView {
  pointCount: number;
  dimensions: Record<string, unknown>;
  getter(name: string): (index: number) => number;
}

/** The slice of the `copc` package's `Las` namespace the loader uses (injectable for tests). */
export interface LasModule {
  Las: {
    Header: { parse(buffer: Uint8Array): LasHeader };
    Vlr: {
      walk(
        get: (begin: number, end: number) => Promise<Uint8Array>,
        header: LasHeader,
      ): Promise<LasVlr[]>;
    };
    PointData: { decompressFile(file: Uint8Array, lazPerf?: unknown): Promise<Uint8Array> };
    View: {
      create(
        buffer: Uint8Array,
        header: LasHeader,
        eb?: unknown[],
        include?: string[],
      ): LasPointView;
    };
  };
}

/** What a LAS file says about its coordinate reference system. */
export interface LasCrs {
  /** GeoTIFF GeoKeys by name (`ProjectedCSTypeGeoKey`, ...), from the 34735/6/7 records. */
  geoKeys?: Record<string, unknown>;
  /** OGC WKT from the 2112 record, or the 2D control's copy of it. */
  wkt?: string;
}

/** CRS → WGS84 degrees, with the height converted to metres. */
export type LasProjector = (x: number, y: number, z: number) => [number, number, number];

export interface LoadLasOptions {
  /** Points to keep at most; defaults to {@link MAX_POINT_CLOUD_POINTS}. */
  budget?: number;
  signal?: AbortSignal;
  /** The `copc` module; defaults to a dynamic import. */
  las?: LasModule;
  /** The LAZ decoder, as for {@link LoadCopcOptions.lazPerf}. */
  lazPerf?: () => Promise<unknown>;
  /** Downloads the whole file; defaults to `fetch` with a size check. */
  fetchBytes?: (url: string, signal?: AbortSignal) => Promise<Uint8Array>;
  /** Builds the projector; defaults to GeoKeys (with units) first, then WKT, through proj4. */
  projector?: (crs: LasCrs) => Promise<LasProjector | null>;
  /** A WKT to fall back on when the file itself carries no CRS. */
  fallbackWkt?: string;
}

/** The GeoTIFF GeoKey directory and parameter records LAS files carry the CRS in. */
const GEOKEY_DIRECTORY = 34735;
const GEOKEY_DOUBLES = 34736;
const GEOKEY_ASCII = 34737;
/** The OGC WKT record. */
const WKT_RECORD = 2112;

/**
 * Decode a GeoTIFF GeoKey directory (as LAS stores it in VLR 34735, with its
 * double and ASCII parameters in 34736 and 34737) into a name → value map.
 *
 * @param directory - The 34735 record: little-endian uint16 values.
 * @param doubles - The 34736 record: little-endian float64 values, if present.
 * @param ascii - The 34737 record, if present.
 * @param names - GeoKey id → name (geotiff's `globals.geoKeyNames`).
 * @returns The keys by name; unknown ids are skipped.
 */
export function parseGeoKeyDirectory(
  directory: Uint8Array,
  doubles: Uint8Array | undefined,
  ascii: Uint8Array | undefined,
  names: Record<number, string>,
): Record<string, unknown> {
  const view = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
  const short = (i: number) => view.getUint16(i * 2, true);
  if (directory.byteLength < 8) return {};
  const keyCount = short(3);
  const doubleView = doubles
    ? new DataView(doubles.buffer, doubles.byteOffset, doubles.byteLength)
    : undefined;
  const text = ascii ? new TextDecoder().decode(ascii) : "";
  const keys: Record<string, unknown> = {};
  for (let k = 0; k < keyCount; k++) {
    const at = 4 + k * 4;
    if ((at + 4) * 2 > directory.byteLength) break;
    const [id, location, count, offset] = [short(at), short(at + 1), short(at + 2), short(at + 3)];
    const name = names[id];
    if (!name) continue;
    if (location === 0) {
      keys[name] = offset;
    } else if (location === GEOKEY_DOUBLES && doubleView) {
      const values: number[] = [];
      for (let i = 0; i < count && (offset + i + 1) * 8 <= doubleView.byteLength; i++)
        values.push(doubleView.getFloat64((offset + i) * 8, true));
      keys[name] = count === 1 ? values[0] : values;
    } else if (location === GEOKEY_ASCII) {
      // GeoTIFF ASCII parameters end in "|"; strip it and any NUL padding.
      keys[name] = text.slice(offset, offset + count).replace(/[|\0]+$/, "");
    }
  }
  return keys;
}

async function defaultFetchBytes(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Point cloud download failed (HTTP ${response.status})`);
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_LAS_FILE_BYTES) {
    // Cancel rather than read a body we are about to refuse.
    await response.body?.cancel();
    throw tooLargeError(length);
  }
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  // A chunked or compressed response has no usable length, so count while
  // reading and stop at the cap instead of buffering an unbounded body.
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_LAS_FILE_BYTES) {
      await reader.cancel();
      throw tooLargeError(total);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

function tooLargeError(bytes: number): Error {
  return new Error(
    `Point cloud is too large to preview on the globe (${Math.round(bytes / 1024 / 1024)} MB); ` +
      "convert it to COPC (.copc.laz) to stream it",
  );
}

/** Metres per unit of a proj4 string's linear unit (`+to_meter`, else `+units`). */
export function proj4LinearUnit(definition: string): number {
  const toMeter = Number(definition.match(/\+to_meter=([0-9.eE+-]+)/)?.[1]);
  if (Number.isFinite(toMeter) && toMeter > 0) return toMeter;
  const units = definition.match(/\+units=([\w-]+)/)?.[1];
  if (units === "ft") return 0.3048;
  if (units === "us-ft") return 1200 / 3937;
  return 1;
}

/**
 * The default projector: GeoKeys first, because they also carry the linear
 * and vertical units (US-survey-foot clouds are common), then the WKT. A CRS
 * proj4 cannot build is reported as no CRS, never read as degrees.
 */
async function lasProjector(crs: LasCrs): Promise<LasProjector | null> {
  const proj4 = (await import("proj4")).default;
  let geoKeyFailure: string | undefined;
  if (crs.geoKeys && Object.keys(crs.geoKeys).length > 0) {
    try {
      const { toProj4 } = await import("geotiff-geokeys-to-proj4");
      const resolved = toProj4(crs.geoKeys as never);
      if (resolved.proj4 && !resolved.errors?.CRSNotSupported) {
        // LAS X/Y are always easting/northing, so a north-first `+axis` from
        // the EPSG tables must not swap them.
        const definition = resolved.proj4.replace(/\+axis=\w+\s*/g, "");
        const converter = proj4(definition, "EPSG:4326");
        // Without a vertical unit key the heights share the projected CRS's
        // linear unit (the LAS convention). A user-defined CRS carries that
        // unit in the conversion multipliers; a predefined EPSG code leaves it
        // in the proj4 string.
        const scale =
          crs.geoKeys.VerticalUnitsGeoKey !== undefined || resolved.isGCS
            ? resolved.conversionParameters.z
            : resolved.conversionParameters.x * proj4LinearUnit(definition);
        // Some user-defined CRSs leave a multiplier unset; a NaN would drop
        // every point, so read the heights as metres instead.
        const zScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
        return (x, y, z) => {
          const c = resolved.convertCoordinates({ x, y });
          const [lng, lat] = converter.forward([c.x, c.y]);
          return [lng, lat, z * zScale];
        };
      }
      geoKeyFailure = "the GeoKeys name a CRS the EPSG tables do not support";
    } catch (error) {
      geoKeyFailure = error instanceof Error ? error.message : String(error);
    }
  }
  if (!crs.wkt && geoKeyFailure) {
    throw new Error(`Point cloud has no usable CRS (${geoKeyFailure})`);
  }
  if (crs.wkt) {
    try {
      const converter = proj4(horizontalWkt(crs.wkt), "EPSG:4326");
      const zScale = wktHeightScale(crs.wkt);
      return (x, y, z) => {
        const [lng, lat] = converter.forward([x, y]);
        return [lng, lat, z * zScale];
      };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Decode a bounded preview of a plain LAS or LAZ file: the whole file is
 * downloaded and decoded, then every n-th point is kept so at most `budget`
 * reach the globe, reprojected to WGS84 with the height in metres.
 *
 * @param url - The file URL.
 * @param options - Budget, abort signal, and injectable dependencies.
 * @returns The decoded cloud.
 */
export async function loadLasPointCloud(
  url: string,
  options: LoadLasOptions = {},
): Promise<DecodedPointCloud> {
  const budget = Number.isFinite(options.budget)
    ? Math.max(1, Math.floor(options.budget as number))
    : MAX_POINT_CLOUD_POINTS;
  const signal = options.signal;
  const { Las } = options.las ?? ((await import("copc")) as unknown as LasModule);
  const file = await (options.fetchBytes ?? defaultFetchBytes)(url, signal);
  signal?.throwIfAborted();
  if (file.byteLength > MAX_LAS_FILE_BYTES) throw tooLargeError(file.byteLength);
  // Rejects anything but LAS 1.2 and 1.4, with a message naming the version.
  const header = Las.Header.parse(file);
  const decodedBytes = header.pointCount * header.pointDataRecordLength;
  if (decodedBytes > MAX_LAS_FILE_BYTES) throw tooLargeError(decodedBytes);

  const vlrs = await Las.Vlr.walk(async (begin, end) => file.subarray(begin, end), header);
  const record = (recordId: number) => {
    const vlr = vlrs.find((v) => v.userId === "LASF_Projection" && v.recordId === recordId);
    return vlr
      ? file.subarray(vlr.contentOffset, vlr.contentOffset + vlr.contentLength)
      : undefined;
  };
  const crs: LasCrs = {};
  const directory = record(GEOKEY_DIRECTORY);
  if (directory) {
    const { globals } = await import("geotiff");
    crs.geoKeys = parseGeoKeyDirectory(
      directory,
      record(GEOKEY_DOUBLES),
      record(GEOKEY_ASCII),
      globals.geoKeyNames as unknown as Record<number, string>,
    );
  }
  const wkt = record(WKT_RECORD);
  crs.wkt = wkt ? new TextDecoder().decode(wkt).replace(/\0+$/, "") : options.fallbackWkt;
  const project = await (options.projector ?? lasProjector)(crs);
  if (!project) {
    throw new Error(
      crs.geoKeys || crs.wkt
        ? "Point cloud has no usable CRS (proj4 could not build its projection)"
        : "Point cloud has no usable CRS (no GeoKeys or WKT in the file)",
    );
  }
  signal?.throwIfAborted();

  // `copc` masks the point format's compression bit off, so the LASzip
  // record every LAZ writer adds decides whether the points need decoding.
  const compressed = vlrs.some((v) => v.userId === "laszip encoded");
  if (!compressed && header.pointDataOffset + decodedBytes > file.byteLength) {
    throw new Error("Point cloud file is truncated (its point data runs past the end of the file)");
  }
  const points = compressed
    ? await Las.PointData.decompressFile(file, await (options.lazPerf ?? defaultLazPerf)())
    : file.subarray(header.pointDataOffset, header.pointDataOffset + decodedBytes);
  signal?.throwIfAborted();
  const view = Las.View.create(points, header, [], POINT_DIMENSIONS);

  const stride = Math.max(1, Math.ceil(view.pointCount / budget));
  const planned = Math.ceil(view.pointCount / stride);
  const positions = new Float64Array(planned * 3);
  const hasColor =
    "Red" in view.dimensions && "Green" in view.dimensions && "Blue" in view.dimensions;
  const colors = hasColor ? new Uint8Array(planned * 3) : null;
  const x = view.getter("X");
  const y = view.getter("Y");
  const z = view.getter("Z");
  const r = colors ? view.getter("Red") : null;
  const g = colors ? view.getter("Green") : null;
  const b = colors ? view.getter("Blue") : null;
  const scale = (v: number) => (v > 255 ? v >> 8 : v);
  let count = 0;
  const isNoise = noiseTest(view);
  for (let i = 0; i < view.pointCount; i += stride) {
    if (isNoise?.(i)) continue;
    const [lng, lat, height] = project(x(i), y(i), z(i));
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || !Number.isFinite(height)) continue;
    positions[count * 3] = lng;
    positions[count * 3 + 1] = lat;
    positions[count * 3 + 2] = height;
    if (colors && r && g && b) {
      colors[count * 3] = scale(r(i));
      colors[count * 3 + 1] = scale(g(i));
      colors[count * 3 + 2] = scale(b(i));
    }
    count++;
  }
  return {
    positions: count === planned ? positions : positions.subarray(0, count * 3),
    colors: colors ? (count === planned ? colors : colors.subarray(0, count * 3)) : null,
    count,
    ...heightRange(positions, count),
    truncated: stride > 1,
  };
}

// --- Entwine Point Tiles ---------------------------------------------------

/** The `ept.json` fields the loader reads. */
interface EptManifest {
  dataType?: string;
  hierarchyType?: string;
  srs?: { wkt?: string; authority?: string; horizontal?: string; vertical?: string };
}

/** EPT nodes fetched and decoded at once. */
const EPT_CONCURRENCY = 4;

export interface LoadEptOptions {
  /** Points to load at most; defaults to {@link MAX_POINT_CLOUD_POINTS}. */
  budget?: number;
  signal?: AbortSignal;
  /** The `copc` module (its LAS reader decodes the nodes); defaults to a dynamic import. */
  las?: LasModule;
  /** The LAZ decoder, as for {@link LoadCopcOptions.lazPerf}. */
  lazPerf?: () => Promise<unknown>;
  /** Fetches the manifest and hierarchy JSON; defaults to `fetch`. */
  fetchJson?: (url: string, signal?: AbortSignal) => Promise<unknown>;
  /** Fetches one node's `.laz`; defaults to the bounded LAS download. */
  fetchBytes?: (url: string, signal?: AbortSignal) => Promise<Uint8Array>;
  /** Builds the projector; defaults to the EPSG code, then the WKT, as for LAS. */
  projector?: (crs: LasCrs) => Promise<LasProjector | null>;
}

async function defaultFetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`EPT request failed (HTTP ${response.status}): ${url}`);
  return response.json();
}

/**
 * The CRS an EPT manifest names. An EPSG `horizontal` code goes through the
 * GeoKey path, which knows the code's linear unit; the WKT is the fallback.
 */
export function eptCrs(srs: EptManifest["srs"]): LasCrs {
  const crs: LasCrs = {};
  const code = Number(srs?.horizontal);
  if (srs?.authority?.toUpperCase() === "EPSG" && Number.isInteger(code) && code > 0)
    crs.geoKeys = { GTModelTypeGeoKey: 1, ProjectedCSTypeGeoKey: code };
  if (srs?.wkt) crs.wkt = srs.wkt;
  return crs;
}

/**
 * Decode a bounded preview of an EPT dataset: the octree hierarchy walked
 * breadth-first from the root (whose nodes hold a coarse sample of the whole
 * cloud) until the budget, each LASzip node decoded and reprojected to WGS84
 * with heights in metres. Only the `laszip` data type is read; `binary` and
 * `zstandard` datasets are refused with a message saying so.
 *
 * @param url - The `ept.json` URL.
 * @param options - Budget, abort signal, and injectable dependencies.
 * @returns The decoded cloud.
 */
export async function loadEptPointCloud(
  url: string,
  options: LoadEptOptions = {},
): Promise<DecodedPointCloud> {
  const budget = Number.isFinite(options.budget)
    ? Math.max(1, Math.floor(options.budget as number))
    : MAX_POINT_CLOUD_POINTS;
  const signal = options.signal;
  const fetchJson = options.fetchJson ?? defaultFetchJson;
  const fetchBytes = options.fetchBytes ?? defaultFetchBytes;
  const manifest = (await fetchJson(url, signal)) as EptManifest;
  signal?.throwIfAborted();
  const dataType = manifest.dataType ?? "laszip";
  if (dataType !== "laszip")
    throw new Error(`EPT data type "${dataType}" is not supported on the globe (only laszip)`);
  if (manifest.hierarchyType && manifest.hierarchyType !== "json")
    throw new Error(`EPT hierarchy type "${manifest.hierarchyType}" is not supported on the globe`);
  const crs = eptCrs(manifest.srs);
  const project = await (options.projector ?? lasProjector)(crs);
  if (!project) throw new Error("EPT dataset has no usable CRS (no EPSG code or WKT proj4 can build)");
  const { Las } = options.las ?? ((await import("copc")) as unknown as LasModule);
  const lazPerf = await (options.lazPerf ?? defaultLazPerf)();
  signal?.throwIfAborted();

  // Keys resolve against the directory holding ept.json, whatever its query.
  const base = new URL(".", new URL(url, globalThis.location?.href ?? "http://localhost/"));
  const query = new URL(url, base).search;
  const resource = (path: string) => new URL(`${path}${query}`, base).href;

  // Breadth-first over the hierarchy; a count of -1 marks a subtree whose
  // counts live in their own file, loaded when the walk reaches it.
  const counts = new Map<string, number>();
  const readPage = async (key: string) => {
    const page = (await fetchJson(resource(`ept-hierarchy/${key}.json`), signal)) as Record<
      string,
      number
    >;
    signal?.throwIfAborted();
    for (const [k, n] of Object.entries(page)) if (typeof n === "number") counts.set(k, n);
  };
  await readPage("0-0-0-0");
  const queue = [...counts.keys()].sort((a, b) => keyDepth(a) - keyDepth(b));
  const loadedPages = new Set(["0-0-0-0"]);
  const chosen: string[] = [];
  let planned = 0;
  let truncated = false;
  while (queue.length && planned < budget) {
    const key = queue.shift()!;
    const count = counts.get(key) ?? 0;
    if (count === -1) {
      if (loadedPages.has(key)) continue;
      loadedPages.add(key);
      const before = new Set(counts.keys());
      await readPage(key);
      // The subtree file restates its root with a real count; requeue it.
      const fresh = [...counts.keys()].filter((k) => !before.has(k) || k === key);
      queue.push(...fresh);
      queue.sort((a, b) => keyDepth(a) - keyDepth(b));
      continue;
    }
    if (count <= 0) continue;
    if (planned + count > budget && chosen.length > 0) {
      truncated = true;
      break;
    }
    chosen.push(key);
    planned = Math.min(budget, planned + count);
  }
  if (queue.length) truncated = true;

  const positions = new Float64Array(planned * 3);
  let colors: Uint8Array | null | undefined;
  let written = 0;
  const scale8 = (v: number) => (v > 255 ? v >> 8 : v);
  const decode = async (key: string) => {
    const file = await fetchBytes(resource(`ept-data/${key}.laz`), signal);
    signal?.throwIfAborted();
    const header = Las.Header.parse(file);
    const points = await Las.PointData.decompressFile(file, lazPerf);
    return Las.View.create(points, header, [], POINT_DIMENSIONS);
  };
  for (let start = 0; start < chosen.length && written < planned; start += EPT_CONCURRENCY) {
    const views = await Promise.all(chosen.slice(start, start + EPT_CONCURRENCY).map(decode));
    signal?.throwIfAborted();
    for (const view of views) {
      const hasColor =
        "Red" in view.dimensions && "Green" in view.dimensions && "Blue" in view.dimensions;
      // One schema per dataset, so the first node decides; a disagreeing
      // node makes the cloud colourless rather than leaving points black.
      if (colors === undefined) colors = hasColor ? new Uint8Array(planned * 3) : null;
      else if (hasColor !== (colors !== null)) colors = null;
      const x = view.getter("X");
      const y = view.getter("Y");
      const z = view.getter("Z");
      const r = colors ? view.getter("Red") : null;
      const g = colors ? view.getter("Green") : null;
      const b = colors ? view.getter("Blue") : null;
      const isNoise = noiseTest(view);
      for (let i = 0; i < view.pointCount && written < planned; i++) {
        if (isNoise?.(i)) continue;
        const [lng, lat, height] = project(x(i), y(i), z(i));
        if (!Number.isFinite(lng) || !Number.isFinite(lat) || !Number.isFinite(height)) continue;
        positions[written * 3] = lng;
        positions[written * 3 + 1] = lat;
        positions[written * 3 + 2] = height;
        if (colors && r && g && b) {
          colors[written * 3] = scale8(r(i));
          colors[written * 3 + 1] = scale8(g(i));
          colors[written * 3 + 2] = scale8(b(i));
        }
        written++;
      }
    }
  }
  return {
    positions: written === planned ? positions : positions.subarray(0, written * 3),
    colors: colors ? (written === planned ? colors : colors.subarray(0, written * 3)) : null,
    count: written,
    ...heightRange(positions, written),
    truncated,
  };
}
