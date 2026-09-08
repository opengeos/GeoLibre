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
// control uses — and drawn as a `PointPrimitiveCollection`.
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
export type PointCloudSourceKind = "tileset" | "copc" | null;

/**
 * Classify a point-cloud layer's URL: a 3D Tiles tileset, a COPC archive, or
 * something the globe cannot draw yet (EPT, plain LAS/LAZ without the COPC
 * hierarchy, which the 2D control streams through its own reader). An EPT
 * manifest is JSON too, but not a tileset: it stays 2D-only rather than
 * failing inside `Cesium3DTileset.fromUrl`.
 */
export function pointCloudSourceKind(url: string | undefined): PointCloudSourceKind {
  if (!url) return null;
  const path = url.split(/[?#]/)[0].toLowerCase();
  if (path.endsWith("/ept.json") || path === "ept.json") return null;
  if (path.endsWith(".json")) return "tileset";
  if (path.endsWith(".copc.laz")) return "copc";
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
   * proj4. Returns `null` for a cloud with no usable CRS, which is then read
   * as already being in degrees.
   */
  projector?: (wkt: string | undefined) => Promise<PointCloudProjector | null>;
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

async function proj4Projector(wkt: string | undefined): Promise<PointCloudProjector | null> {
  if (!wkt) return null;
  const proj4 = (await import("proj4")).default;
  try {
    const converter = proj4(wkt, "EPSG:4326");
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
  const budget = Math.max(1, options.budget ?? MAX_POINT_CLOUD_POINTS);
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

  // Breadth-first over the hierarchy: pages are loaded lazily as the walk
  // reaches keys that live in a deeper page, and the walk stops at the budget.
  const root = await Copc.loadHierarchyPage(url, copc.info.rootHierarchyPage);
  const nodes = new Map(Object.entries(root.nodes));
  const pages = new Map(Object.entries(root.pages));
  const keys = [...nodes.keys()].sort((a, b) => keyDepth(a) - keyDepth(b));
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
    if (planned + node.pointCount > budget && chosen.length > 0) {
      truncated = true;
      break;
    }
    chosen.push(key);
    chosenKeys.add(key);
    planned += node.pointCount;
  }
  if (keys.length) truncated = true;

  const positions = new Float64Array(planned * 3);
  let colors: Uint8Array | null = null;
  let count = 0;
  let zMin = Number.POSITIVE_INFINITY;
  let zMax = Number.NEGATIVE_INFINITY;
  for (const key of chosen) {
    const node = nodes.get(key)!;
    const view = await Copc.loadPointDataView(url, copc, node, {
      include: ["X", "Y", "Z", "Red", "Green", "Blue"],
      lazPerf,
    });
    signal?.throwIfAborted();
    const x = view.getter("X");
    const y = view.getter("Y");
    const z = view.getter("Z");
    const hasColor =
      "Red" in view.dimensions && "Green" in view.dimensions && "Blue" in view.dimensions;
    const r = hasColor ? view.getter("Red") : null;
    const g = hasColor ? view.getter("Green") : null;
    const b = hasColor ? view.getter("Blue") : null;
    if (hasColor && !colors) colors = new Uint8Array(planned * 3);
    for (let i = 0; i < view.pointCount && count < planned; i++) {
      const [lng, lat] = project(x(i), y(i));
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      const height = z(i);
      positions[count * 3] = lng;
      positions[count * 3 + 1] = lat;
      positions[count * 3 + 2] = height;
      if (height < zMin) zMin = height;
      if (height > zMax) zMax = height;
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
    zMin: Number.isFinite(zMin) ? zMin : 0,
    zMax: Number.isFinite(zMax) ? zMax : 0,
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
): PointPrimitiveCollection {
  const collection = new Cesium.PointPrimitiveCollection();
  const ramp = getVectorColorRamp("viridis").colors;
  const alpha = Math.min(1, Math.max(0, opacity));
  for (let i = 0; i < cloud.count; i++) {
    const [r, g, b] = pointCloudColor(cloud, i, ramp);
    collection.add({
      position: Cesium.Cartesian3.fromDegrees(
        cloud.positions[i * 3],
        cloud.positions[i * 3 + 1],
        cloud.positions[i * 3 + 2],
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
