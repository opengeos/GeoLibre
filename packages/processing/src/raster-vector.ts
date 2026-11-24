import type {
  Feature,
  FeatureCollection,
  Geometry,
  LineString,
  MultiPolygon,
  Polygon,
  Position,
} from "geojson";
import type { RasterData } from "./raster-client";
import {
  crsMember,
  crsTransform,
  epsgDefinition,
  geojsonEpsg,
  geojsonFeatures,
  mapGeometry,
  rasterCrsDefinition,
  rasterEpsg,
  toNorthUp,
} from "./raster-geo";

/**
 * In-browser vector/raster tools: Clip by mask, Zonal statistics, Polygonize
 * and Contour. Each follows the rasterio sidecar worker of the same name:
 *
 * - Rasterization reproduces GDAL's rules: a pixel is inside a polygon when
 *   its centre is (scanline fill over all rings, even-odd), or, with
 *   `all_touched`, when the outline passes through it; a point burns the pixel
 *   that contains it. Crop windows follow `rasterio.features.geometry_window`.
 * - Polygonize traces pixel edges per connected region (4- or 8-connected) the
 *   way `rasterio.features.shapes` (GDAL polygonize) groups pixels.
 * - Contour runs marching squares on pixel centres with ContourPy's rules (a
 *   corner is above the level when `z > level`; saddles resolve on the quad's
 *   mean; a quad with one NoData corner is contoured as the triangle left).
 */

/** NoData written where the source declares none. */
const DEFAULT_NODATA = -9999;

type Ring = Position[];

/** Polygon rings in pixel space (col, row), grouped per polygon part. */
type PixelPolygon = Ring[];

function isValid(v: number, nodata: number | null): boolean {
  return Number.isFinite(v) && (nodata == null || v !== nodata);
}

/** World -> pixel (col, row) for a north-up raster. */
function toPixel(raster: RasterData, p: Position): Position {
  return [(p[0] - raster.originX) / raster.resX, (raster.originY - p[1]) / raster.resY];
}

/** Collect the polygon parts and points of a geometry (lines are reported). */
function splitGeometry(geometry: Geometry): {
  polygons: Ring[][];
  points: Position[];
  lines: boolean;
} {
  const out = {
    polygons: [] as Ring[][],
    points: [] as Position[],
    lines: false,
  };
  const visit = (g: Geometry) => {
    switch (g.type) {
      case "Polygon":
        out.polygons.push(g.coordinates);
        break;
      case "MultiPolygon":
        out.polygons.push(...g.coordinates);
        break;
      case "Point":
        out.points.push(g.coordinates);
        break;
      case "MultiPoint":
        out.points.push(...g.coordinates);
        break;
      case "LineString":
      case "MultiLineString":
        out.lines = true;
        break;
      case "GeometryCollection":
        g.geometries.forEach(visit);
        break;
    }
  };
  visit(geometry);
  return out;
}

/** Bounds (minX, minY, maxX, maxY) of every position in a geometry. */
function geometryBounds(geometry: Geometry): [number, number, number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  mapGeometry(geometry, ([x, y]) => {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    return [x, y];
  });
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

/** A pixel window [col0, col1) x [row0, row1). */
interface Window {
  col0: number;
  row0: number;
  col1: number;
  row1: number;
}

/**
 * The window `rasterio.features.geometry_window` returns: the union of each
 * shape's floor/ceil pixel bounds, intersected with the raster (null when they
 * do not overlap).
 */
function geometryWindow(raster: RasterData, geometries: Geometry[]): Window | null {
  let col0 = Infinity;
  let row0 = Infinity;
  let col1 = -Infinity;
  let row1 = -Infinity;
  for (const g of geometries) {
    const b = geometryBounds(g);
    if (!b) continue;
    const colOff = (b[0] - raster.originX) / raster.resX;
    const rowOff = (raster.originY - b[3]) / raster.resY;
    const w = (b[2] - b[0]) / raster.resX;
    const h = (b[3] - b[1]) / raster.resY;
    const c0 = Math.floor(colOff);
    const r0 = Math.floor(rowOff);
    col0 = Math.min(col0, c0);
    row0 = Math.min(row0, r0);
    col1 = Math.max(col1, Math.ceil(colOff + w));
    row1 = Math.max(row1, Math.ceil(rowOff + h));
  }
  if (!Number.isFinite(col0)) return null;
  const win = {
    col0: Math.max(0, col0),
    row0: Math.max(0, row0),
    col1: Math.min(raster.width, col1),
    row1: Math.min(raster.height, row1),
  };
  // rasterio's Window.intersection rejects an empty or edge-only overlap.
  if (win.col1 <= win.col0 || win.row1 <= win.row0) return null;
  return win;
}

/**
 * Burn polygons (pixel space) into `mask` over a window, GDAL style: a pixel is
 * set when its centre is inside (even-odd over the part's rings).
 */
function burnPolygonCentres(
  mask: Uint8Array,
  width: number,
  win: Window,
  rings: PixelPolygon,
): void {
  const xs: number[] = [];
  for (let row = win.row0; row < win.row1; row += 1) {
    const y = row + 0.5;
    xs.length = 0;
    for (const ring of rings) {
      for (let i = 0, n = ring.length; i + 1 < n; i += 1) {
        let [x1, y1] = ring[i];
        let [x2, y2] = ring[i + 1];
        if (y1 === y2) continue;
        if (y1 > y2) {
          [x1, x2] = [x2, x1];
          [y1, y2] = [y2, y1];
        }
        if (y < y2 && y >= y1) xs.push(((y - y1) * (x2 - x1)) / (y2 - y1) + x1);
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      // Pixels whose centre lies in [xs[k], xs[k + 1]) (GDAL's
      // floor(x + 0.5) start / exclusive end).
      const start = Math.max(win.col0, Math.floor(xs[k] + 0.5));
      const end = Math.min(win.col1, Math.floor(xs[k + 1] + 0.5));
      for (let col = start; col < end; col += 1) mask[row * width + col] = 1;
    }
  }
}

/** Burn every pixel a segment passes through (all-touched outline). */
function burnSegmentTouched(
  mask: Uint8Array,
  width: number,
  win: Window,
  a: Position,
  b: Position,
): void {
  const [x0, y0] = a;
  const [x1, y1] = b;
  const minX = Math.min(x0, x1);
  const maxX = Math.max(x0, x1);
  const lastIndex = (lo: number, hi: number) =>
    hi > lo && Number.isInteger(hi) ? hi - 1 : Math.floor(hi);
  const cStart = Math.max(win.col0, Math.floor(minX));
  const cEnd = Math.min(win.col1 - 1, lastIndex(minX, maxX));
  for (let col = cStart; col <= cEnd; col += 1) {
    let ya: number;
    let yb: number;
    if (x0 === x1) {
      ya = y0;
      yb = y1;
    } else {
      const xa = Math.max(minX, col);
      const xb = Math.min(maxX, col + 1);
      ya = y0 + ((xa - x0) * (y1 - y0)) / (x1 - x0);
      yb = y0 + ((xb - x0) * (y1 - y0)) / (x1 - x0);
    }
    const lo = Math.min(ya, yb);
    const hi = Math.max(ya, yb);
    const rStart = Math.max(win.row0, Math.floor(lo));
    const rEnd = Math.min(win.row1 - 1, lastIndex(lo, hi));
    for (let row = rStart; row <= rEnd; row += 1) mask[row * width + col] = 1;
  }
}

/**
 * Rasterize geometries (already in the raster's CRS) to a 0/1 mask over the
 * full raster, limited to `win`.
 */
function rasterizeGeometries(
  raster: RasterData,
  geometries: Geometry[],
  win: Window,
  allTouched: boolean,
  reusable?: Uint8Array,
): Uint8Array {
  const mask = reusable ?? new Uint8Array(raster.width * raster.height);
  if (reusable)
    for (let row = win.row0; row < win.row1; row++)
      mask.fill(0, row * raster.width + win.col0, row * raster.width + win.col1);
  for (const geometry of geometries) {
    const { polygons, points } = splitGeometry(geometry);
    for (const polygon of polygons) {
      const rings = polygon.map((ring) => ring.map((p) => toPixel(raster, p)));
      burnPolygonCentres(mask, raster.width, win, rings);
      if (allTouched) {
        for (const ring of rings) {
          for (let i = 0; i + 1 < ring.length; i += 1) {
            burnSegmentTouched(mask, raster.width, win, ring[i], ring[i + 1]);
          }
        }
      }
    }
    for (const point of points) {
      const [c, r] = toPixel(raster, point);
      const col = Math.floor(c);
      const row = Math.floor(r);
      if (col >= win.col0 && col < win.col1 && row >= win.row0 && row < win.row1) {
        mask[row * raster.width + col] = 1;
      }
    }
  }
  return mask;
}

/**
 * Reproject a GeoJSON input's geometries into the raster's CRS (the input's
 * CRS is its `crs` member, else WGS84), skipping null geometries.
 */
async function geometriesInRasterCrs(
  raster: RasterData,
  features: Feature[],
  vectorEpsg: number,
  toolName: string,
): Promise<(Geometry | null)[]> {
  const rasterDef = await rasterCrsDefinition(raster, toolName);
  const same = rasterEpsg(raster) === vectorEpsg;
  const fn = same ? null : await crsTransform(await epsgDefinition(vectorEpsg), rasterDef);
  return features.map((f) => {
    const g = f?.geometry ?? null;
    if (!g) return null;
    return fn ? mapGeometry(g, fn) : g;
  });
}

export interface ClipMaskParams {
  crop?: boolean;
  all_touched?: boolean;
}

/**
 * Clip a raster to the polygons of a GeoJSON mask, like `rasterio.mask.mask`
 * in the sidecar: pixels outside the shapes become NoData and, with `crop`,
 * the raster is trimmed to the shapes' pixel window.
 */
export async function clipRasterByMask(
  input: RasterData,
  maskGeojson: unknown,
  params: ClipMaskParams,
): Promise<{ raster: RasterData; messages: string[] }> {
  const raster = toNorthUp(input);
  const crop = params.crop ?? true;
  const allTouched = Boolean(params.all_touched);
  const features = geojsonFeatures(maskGeojson).filter((f) => f?.geometry);
  if (!features.length) throw new Error("Mask layer has no geometries");
  const geometries = (
    await geometriesInRasterCrs(raster, features, geojsonEpsg(maskGeojson), "clip-by-mask")
  ).filter((g): g is Geometry => g != null);
  const messages: string[] = [];
  const window = geometryWindow(raster, geometries);
  if (!window && crop) throw new Error("Input shapes do not overlap raster.");
  const win = window ?? { col0: 0, row0: 0, col1: 0, row1: 0 };
  if (!window) {
    messages.push(
      "Warning: shapes are outside bounds of raster. Are they in different coordinate reference systems?",
    );
  }
  const mask = rasterizeGeometries(raster, geometries, win, allTouched);
  const outWin = crop ? win : { col0: 0, row0: 0, col1: raster.width, row1: raster.height };
  const outW = outWin.col1 - outWin.col0;
  const outH = outWin.row1 - outWin.row0;
  const outNodata = raster.nodata ?? DEFAULT_NODATA;
  const bands = raster.bands.map((band) => {
    const out = new Float32Array(outW * outH);
    for (let r = 0; r < outH; r += 1) {
      for (let c = 0; c < outW; c += 1) {
        const i = (r + outWin.row0) * raster.width + c + outWin.col0;
        const v = band[i];
        out[r * outW + c] = mask[i] && isValid(v, raster.nodata) ? v : outNodata;
      }
    }
    return out;
  });
  messages.push(`Clipped by ${geometries.length} mask geometry(ies).`);
  return {
    raster: {
      ...raster,
      bands,
      width: outW,
      height: outH,
      originX: raster.originX + outWin.col0 * raster.resX,
      originY: raster.originY - outWin.row0 * raster.resY,
      nodata: outNodata,
    },
    messages,
  };
}

export interface ZonalParams {
  band?: number;
  prefix?: string;
}

const STAT_KEYS = ["min", "max", "mean", "sum", "std", "median"] as const;

/**
 * Summarize raster values inside each zone polygon (count, min, max, mean,
 * sum, std, median), like the sidecar's `rio_mask(crop=True)` per zone: pixel
 * centres inside the zone, NoData and non-finite values excluded.
 */
export async function zonalStatistics(
  input: RasterData,
  zonesGeojson: unknown,
  params: ZonalParams,
): Promise<{ geojson: FeatureCollection; messages: string[] }> {
  const raster = toNorthUp(input);
  const bandIndex = Math.trunc(Number(params.band ?? 1));
  if (!(bandIndex >= 1 && bandIndex <= raster.bands.length)) {
    throw new Error(`Band ${bandIndex} out of range (raster has ${raster.bands.length} band(s))`);
  }
  const band = raster.bands[bandIndex - 1];
  const prefix = String(params.prefix ?? "");
  const features = geojsonFeatures(zonesGeojson);
  if (!features.length) throw new Error("Zones layer has no features");
  const zoneEpsg = geojsonEpsg(zonesGeojson);
  const geometries = await geometriesInRasterCrs(raster, features, zoneEpsg, "zonal statistics");
  let withData = 0;
  let reusableMask: Uint8Array | undefined;
  const out: Feature[] = features.map((feature, idx) => {
    const props: Record<string, unknown> = { ...(feature?.properties ?? {}) };
    const geometry = geometries[idx];
    const values: number[] = [];
    if (geometry) {
      const parts = splitGeometry(geometry);
      if (parts.lines) {
        throw new Error(
          "The in-browser zonal statistics supports polygon and point zones. Use the sidecar (rasterio/GDAL) engine for line zones.",
        );
      }
      const win = geometryWindow(raster, [geometry]);
      if (win) {
        const mask = rasterizeGeometries(raster, [geometry], win, false, reusableMask);
        reusableMask = mask;
        for (let r = win.row0; r < win.row1; r += 1) {
          for (let c = win.col0; c < win.col1; c += 1) {
            const i = r * raster.width + c;
            if (mask[i] && isValid(band[i], raster.nodata)) values.push(band[i]);
          }
        }
      }
    }
    const n = values.length;
    props[`${prefix}count`] = n;
    if (n) {
      withData += 1;
      let sum = 0;
      let min = Infinity;
      let max = -Infinity;
      for (const v of values) {
        sum += v;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const mean = sum / n;
      let acc = 0;
      for (const v of values) acc += (v - mean) ** 2;
      const sorted = values.sort((a, b) => a - b);
      const mid = n >> 1;
      props[`${prefix}min`] = min;
      props[`${prefix}max`] = max;
      props[`${prefix}mean`] = mean;
      props[`${prefix}sum`] = sum;
      props[`${prefix}std`] = Math.sqrt(acc / n);
      props[`${prefix}median`] = n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    } else {
      for (const key of STAT_KEYS) props[`${prefix}${key}`] = null;
    }
    return {
      type: "Feature",
      properties: props,
      geometry: feature?.geometry ?? null,
    } as Feature;
  });
  const member = crsMember(zoneEpsg);
  const geojson = {
    type: "FeatureCollection",
    ...(member ? { crs: member } : {}),
    features: out,
  } as FeatureCollection;
  return {
    geojson,
    messages: [`Computed zonal statistics for ${out.length} zone(s) (${withData} with data).`],
  };
}

export interface PolygonizeParams {
  band?: number;
  connectivity?: number | string;
  field?: string;
}

/** Shoelace area of a ring's exterior, relative to its first vertex. */
function ringArea(ring: Position[]): number {
  const [ox, oy] = ring[0];
  let total = 0;
  for (let i = 0; i + 1 < ring.length; i += 1) {
    total += (ring[i][0] - ox) * (ring[i + 1][1] - oy) - (ring[i + 1][0] - ox) * (ring[i][1] - oy);
  }
  return total / 2;
}

/** Drop vertices that sit on a straight run (pixel-edge rings are axis-aligned). */
function simplifyRing(ring: Position[]): Position[] {
  const pts = ring.slice(0, -1);
  const out: Position[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i += 1) {
    const prev = pts[(i - 1 + n) % n];
    const cur = pts[i];
    const next = pts[(i + 1) % n];
    const collinear =
      (prev[0] === cur[0] && cur[0] === next[0]) || (prev[1] === cur[1] && cur[1] === next[1]);
    if (!collinear) out.push(cur);
  }
  out.push(out[0]);
  return out;
}

/**
 * Convert a raster band into polygons of connected equal-value pixels, like
 * `rasterio.features.shapes` in the sidecar. Rings follow pixel edges; output
 * polygons are sorted largest first so small enclosed regions draw on top.
 */
export function polygonizeRaster(
  input: RasterData,
  params: PolygonizeParams,
): { geojson: FeatureCollection; messages: string[] } {
  if (input.width * input.height > 8_000_000)
    throw new RangeError(
      "Browser polygonization is limited to 8 million pixels. Crop the raster or use the sidecar (rasterio/GDAL) engine.",
    );
  const raster = toNorthUp(input);
  const bandIndex = Math.trunc(Number(params.band ?? 1));
  const band = raster.bands[bandIndex - 1];
  if (!band) throw new Error(`Band ${bandIndex} out of range.`);
  const eight = String(params.connectivity ?? "4") === "8";
  const field = String(params.field ?? "value");
  const { width: W, height: H, nodata } = raster;

  // Union-find labelling of equal-valued valid pixels.
  const parent = new Int32Array(W * H).fill(-1);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    while (parent[i] !== r) {
      const next = parent[i];
      parent[i] = r;
      i = next;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  for (let i = 0; i < W * H; i += 1) if (isValid(band[i], nodata)) parent[i] = i;
  const same = (i: number, j: number) => parent[j] !== -1 && band[i] === band[j];
  for (let r = 0; r < H; r += 1) {
    for (let c = 0; c < W; c += 1) {
      const i = r * W + c;
      if (parent[i] === -1) continue;
      if (c > 0 && same(i, i - 1)) union(i, i - 1);
      if (r > 0 && same(i, i - W)) union(i, i - W);
      if (eight && r > 0 && c > 0 && same(i, i - W - 1)) union(i, i - W - 1);
      if (eight && r > 0 && c + 1 < W && same(i, i - W + 1)) union(i, i - W + 1);
    }
  }
  const label = new Int32Array(W * H).fill(-1);
  for (let i = 0; i < W * H; i += 1) if (parent[i] !== -1) label[i] = find(i);

  const labelAt = (r: number, c: number) =>
    r < 0 || c < 0 || r >= H || c >= W ? -1 : label[r * W + c];
  // Count before allocating per-region arrays, edges, or GeoJSON rings.
  let boundaryEdges = 0;
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const lab = label[r * W + c];
      if (lab === -1) continue;
      if (labelAt(r - 1, c) !== lab) boundaryEdges++;
      if (labelAt(r + 1, c) !== lab) boundaryEdges++;
      if (labelAt(r, c - 1) !== lab) boundaryEdges++;
      if (labelAt(r, c + 1) !== lab) boundaryEdges++;
      if (boundaryEdges > 250_000)
        throw new RangeError(
          "Browser polygonization exceeds the 250,000 boundary-edge budget. Crop or simplify the classified raster, or use the sidecar (rasterio/GDAL) engine.",
        );
    }
  }

  // Directed boundary edges per region, region on the left in pixel space
  // (x right, y down). Vertex id = row * (W + 1) + col.
  const V = W + 1;
  const edges = new Map<number, { from: number; to: number }[]>();
  const addEdge = (lab: number, from: number, to: number) => {
    let list = edges.get(lab);
    if (!list) edges.set(lab, (list = []));
    list.push({ from, to });
  };
  for (let r = 0; r < H; r += 1) {
    for (let c = 0; c < W; c += 1) {
      const lab = label[r * W + c];
      if (lab === -1) continue;
      if (labelAt(r - 1, c) !== lab) addEdge(lab, r * V + c + 1, r * V + c); // top, west
      if (labelAt(r + 1, c) !== lab) addEdge(lab, (r + 1) * V + c, (r + 1) * V + c + 1); // bottom, east
      if (labelAt(r, c - 1) !== lab) addEdge(lab, r * V + c, (r + 1) * V + c); // left, south
      if (labelAt(r, c + 1) !== lab) addEdge(lab, (r + 1) * V + c + 1, r * V + c + 1); // right, north
    }
  }

  const features: Feature<Polygon>[] = [];
  const toWorld = (v: number): Position => {
    const row = Math.floor(v / V);
    const col = v - row * V;
    return [raster.originX + col * raster.resX, raster.originY - row * raster.resY];
  };
  const dir = (from: number, to: number): [number, number] => {
    const fr = Math.floor(from / V);
    const tr = Math.floor(to / V);
    return [to - tr * V - (from - fr * V), tr - fr];
  };
  // Regions in scan order of their first pixel (the union-find root).
  const order = [...edges.keys()].sort((a, b) => a - b);
  for (const lab of order) {
    const list = edges.get(lab)!;
    const outgoing = new Map<number, number[]>();
    list.forEach((e, k) => {
      const arr = outgoing.get(e.from);
      if (arr) arr.push(k);
      else outgoing.set(e.from, [k]);
    });
    const used = new Uint8Array(list.length);
    const rings: number[][] = [];
    for (let start = 0; start < list.length; start += 1) {
      if (used[start]) continue;
      const ring = [list[start].from];
      let k = start;
      while (!used[k]) {
        used[k] = 1;
        const e = list[k];
        ring.push(e.to);
        const cands = (outgoing.get(e.to) ?? []).filter((j) => !used[j]);
        if (!cands.length) break;
        if (cands.length === 1) {
          k = cands[0];
          continue;
        }
        // Saddle vertex: 8-connectivity crosses to the diagonal pixel (right
        // turn), 4-connectivity keeps to the current pixel (left turn).
        const [dx, dy] = dir(e.from, e.to);
        const pick = cands.find((j) => {
          const [nx, ny] = dir(list[j].from, list[j].to);
          const cross = dx * ny - dy * nx; // > 0: right turn in y-down space
          return cross > 0;
        });
        k = pick ?? cands[0];
      }
      rings.push(ring);
    }
    const worldRings = rings.map((ring) => simplifyRing(ring.map(toWorld)));
    // In world (y-up) space the exterior is counter-clockwise (positive area).
    let exteriorIndex = 0;
    for (let i = 1; i < worldRings.length; i += 1) {
      if (Math.abs(ringArea(worldRings[i])) > Math.abs(ringArea(worldRings[exteriorIndex]))) {
        exteriorIndex = i;
      }
    }
    const exterior = worldRings[exteriorIndex];
    const holes = worldRings.filter((_, i) => i !== exteriorIndex);
    const firstPixel = lab;
    features.push({
      type: "Feature",
      properties: { [field]: band[firstPixel] },
      geometry: { type: "Polygon", coordinates: [exterior, ...holes] },
    });
  }
  // Largest first (stable), matching the sidecar's draw-order fix (#3335).
  const sorted = features
    .map((f, i) => ({ f, i, a: Math.abs(ringArea(f.geometry.coordinates[0])) }))
    .sort((x, y) => y.a - x.a || x.i - y.i)
    .map((x) => x.f);
  const member = crsMember(rasterEpsg(raster));
  return {
    geojson: {
      type: "FeatureCollection",
      ...(member ? { crs: member } : {}),
      features: sorted,
    } as FeatureCollection,
    messages: [`Polygonized into ${sorted.length} feature(s).`],
  };
}

export interface ContourParams {
  band?: number;
  interval: number;
  base?: number;
  attribute?: string;
}

/** Contour levels the sidecar generates for a data range. */
export function contourLevels(
  zmin: number,
  zmax: number,
  interval: number,
  base: number,
): number[] {
  const start = base + Math.ceil((zmin - base) / interval) * interval;
  const n = Math.floor((zmax - start) / interval + 1e-9) + 1;
  const levels: number[] = [];
  for (let i = 0; i < Math.max(0, n); i += 1) {
    levels.push(Number((start + i * interval).toFixed(6)));
  }
  return levels;
}

/**
 * Generate contour lines from a raster band, like the sidecar's ContourPy run
 * on pixel centres. Lines are LineStrings in the raster's CRS; closed loops
 * repeat their first vertex.
 */
export function contourRaster(
  input: RasterData,
  params: ContourParams,
): { geojson: FeatureCollection; messages: string[] } {
  const raster = toNorthUp(input);
  const bandIndex = Math.trunc(Number(params.band ?? 1));
  const band = raster.bands[bandIndex - 1];
  if (!band) throw new Error(`Band ${bandIndex} out of range.`);
  const interval = Number(params.interval);
  if (!(interval > 0)) throw new Error("Contour interval must be > 0");
  const base = Number(params.base ?? 0) || 0;
  const attribute = String(params.attribute ?? "elev");
  const { width: nx, height: ny, nodata } = raster;
  const z = new Float64Array(nx * ny);
  const ok = new Uint8Array(nx * ny);
  let zmin = Infinity;
  let zmax = -Infinity;
  for (let i = 0; i < nx * ny; i += 1) {
    const v = band[i];
    if (isValid(v, nodata)) {
      z[i] = v;
      ok[i] = 1;
      if (v < zmin) zmin = v;
      if (v > zmax) zmax = v;
    }
  }
  if (!Number.isFinite(zmin)) throw new Error("Raster band has no valid data to contour");
  const levels = contourLevels(zmin, zmax, interval, base);
  if (!levels.length) {
    throw new Error(
      `No contour levels fall within the data range [${zmin}, ${zmax}] for interval=${interval} and base=${base}.`,
    );
  }
  const toWorld = (col: number, row: number): Position => [
    raster.originX + (col + 0.5) * raster.resX,
    raster.originY - (row + 0.5) * raster.resY,
  ];

  const features: Feature<LineString>[] = [];
  for (const level of levels) {
    for (const line of traceLevel(z, ok, nx, ny, level)) {
      if (line.length < 2) continue;
      features.push({
        type: "Feature",
        properties: { [attribute]: level },
        geometry: {
          type: "LineString",
          coordinates: line.map(([c, r]) => toWorld(c, r)),
        },
      });
    }
  }
  const member = crsMember(rasterEpsg(raster));
  return {
    geojson: {
      type: "FeatureCollection",
      ...(member ? { crs: member } : {}),
      features,
    } as FeatureCollection,
    messages: [`Generated ${features.length} contour line(s) across ${levels.length} level(s).`],
  };
}

/**
 * Marching squares for one level over a grid of point values (`ok` marks valid
 * points). Returns polylines in (col, row) grid coordinates.
 */
function traceLevel(
  z: Float64Array,
  ok: Uint8Array,
  nx: number,
  ny: number,
  level: number,
): Position[][] {
  // A crossing is identified by its grid edge (ordered point pair) so segments
  // from neighbouring cells join; diagonal edges (corner triangles) are unique.
  const crossing = new Map<string, Position>();
  const ends = new Map<string, number[]>(); // crossing key -> segment ids
  const segments: [string, string][] = [];
  const above = (p: number) => z[p] > level;
  const key = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const point = (a: number, b: number): Position => {
    // ContourPy: frac = (z1 - level) / (z1 - z0); p = p0 * frac + p1 * (1 - frac).
    const frac = (z[b] - level) / (z[b] - z[a]);
    const ax = a % nx;
    const ay = (a - ax) / nx;
    const bx = b % nx;
    const by = (b - bx) / nx;
    return [ax * frac + bx * (1 - frac), ay * frac + by * (1 - frac)];
  };
  const addSegment = (e1: [number, number], e2: [number, number]) => {
    const k1 = key(e1[0], e1[1]);
    const k2 = key(e2[0], e2[1]);
    if (!crossing.has(k1)) crossing.set(k1, point(e1[0], e1[1]));
    if (!crossing.has(k2)) crossing.set(k2, point(e2[0], e2[1]));
    const id = segments.length;
    segments.push([k1, k2]);
    for (const k of [k1, k2]) {
      const list = ends.get(k);
      if (list) list.push(id);
      else ends.set(k, [id]);
    }
  };
  /** Contour a triangle of three valid points (a corner-masked quad). */
  const triangle = (a: number, b: number, c: number) => {
    const pts = [a, b, c];
    const up = pts.map(above);
    const n = up.filter(Boolean).length;
    if (n === 0 || n === 3) return;
    // The odd vertex out is cut off by one segment across its two edges.
    const odd = up.findIndex((u) => (n === 1 ? u : !u));
    const o = pts[odd];
    const others = pts.filter((_, i) => i !== odd);
    addSegment([o, others[0]], [o, others[1]]);
  };

  for (let j = 0; j + 1 < ny; j += 1) {
    for (let i = 0; i + 1 < nx; i += 1) {
      const sw = j * nx + i;
      const se = sw + 1;
      const nw = sw + nx;
      const ne = nw + 1;
      const valid = [ok[sw], ok[se], ok[nw], ok[ne]];
      const count = valid[0] + valid[1] + valid[2] + valid[3];
      if (count < 3) continue;
      if (count === 3) {
        if (!ok[sw]) triangle(se, ne, nw);
        else if (!ok[se]) triangle(sw, nw, ne);
        else if (!ok[nw]) triangle(sw, se, ne);
        else triangle(sw, se, nw);
        continue;
      }
      const uSW = above(sw);
      const uSE = above(se);
      const uNW = above(nw);
      const uNE = above(ne);
      const S: [number, number] = [sw, se];
      const E: [number, number] = [se, ne];
      const N: [number, number] = [nw, ne];
      const Wd: [number, number] = [sw, nw];
      const crossS = uSW !== uSE;
      const crossE = uSE !== uNE;
      const crossN = uNW !== uNE;
      const crossW = uSW !== uNW;
      const n = +crossS + +crossE + +crossN + +crossW;
      if (n === 0) continue;
      if (n === 2) {
        const es = [crossS && S, crossE && E, crossN && N, crossW && Wd].filter(Boolean) as [
          number,
          number,
        ][];
        addSegment(es[0], es[1]);
        continue;
      }
      // Saddle: corners on the other side of the quad's mean are cut off.
      const middleAbove = 0.25 * (z[sw] + z[se] + z[nw] + z[ne]) > level;
      if (uSW !== middleAbove) addSegment(S, Wd);
      if (uSE !== middleAbove) addSegment(S, E);
      if (uNW !== middleAbove) addSegment(N, Wd);
      if (uNE !== middleAbove) addSegment(N, E);
    }
  }

  // Chain segments into polylines: open lines from degree-1 crossings first,
  // then the remaining closed loops (first vertex repeated).
  const used = new Uint8Array(segments.length);
  const lines: Position[][] = [];
  const walk = (startKey: string, startSeg: number): string[] => {
    const keys = [startKey];
    let seg = startSeg;
    let at = startKey;
    while (seg !== -1 && !used[seg]) {
      used[seg] = 1;
      const [a, b] = segments[seg];
      at = a === at ? b : a;
      keys.push(at);
      const next = (ends.get(at) ?? []).find((s) => !used[s]);
      seg = next ?? -1;
    }
    return keys;
  };
  for (const [k, list] of ends) {
    if (list.length !== 1 || used[list[0]]) continue;
    lines.push(walk(k, list[0]).map((key2) => crossing.get(key2)!));
  }
  for (let s = 0; s < segments.length; s += 1) {
    if (used[s]) continue;
    lines.push(walk(segments[s][0], s).map((key2) => crossing.get(key2)!));
  }
  return lines;
}
