/**
 * Object hierarchy (multilevel OBIA) for the Object-Based Analysis workbench.
 *
 * A coarser level is built from a finer one by merging adjacent objects, so
 * every parent is exactly the union of its children and containment always
 * holds, as in eCognition's image object hierarchy. Merging is best-first on
 * the object adjacency graph with the color heterogeneity criterion of
 * multiresolution segmentation: the cost of merging two objects is the
 * increase in size-weighted standard deviation, summed over the bands, and
 * merging stops when the cheapest merge costs more than scale².
 *
 * Parent features are exact, not re-measured: spectral statistics are pooled
 * from the children's, and shape and neighbor context come from a scan of the
 * parent label grid with the same definitions as the measurement tools.
 */
import { addSpectralIndices, type ObiaFeatureTable, type ObiaIndexBands } from "./obia";
import { readRasterData, writeRasterBands, type RasterData } from "./raster-client";

/** A decoded label raster: one object id per pixel, 0 for none. */
export interface ObiaLabelGrid {
  width: number;
  height: number;
  ids: Int32Array;
  /** Georeferencing to write a relabeled grid with. */
  raster: RasterData;
}

/**
 * Decode a label raster (GeoTIFF) into an integer grid.
 *
 * @param labels Label raster bytes.
 */
export async function decodeLabelGrid(labels: Uint8Array): Promise<ObiaLabelGrid> {
  const copy = labels.slice();
  const raster = await readRasterData(copy.buffer as ArrayBuffer);
  const values = raster.bands[0];
  const ids = new Int32Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    ids[i] = value > 0 && value !== raster.nodata && Number.isFinite(value) ? Math.round(value) : 0;
  }
  return { width: raster.width, height: raster.height, ids, raster: { ...raster, bands: [] } };
}

/** Encode a grid of object ids as a label raster with the grid's georeferencing. */
export function encodeLabelGrid(grid: ObiaLabelGrid, ids: Int32Array): Uint8Array {
  const values = Float32Array.from(ids);
  return new Uint8Array(writeRasterBands({ ...grid.raster, nodata: 0, bands: [values] }));
}

/** Shared pixel edges between objects: `id -> neighbor id -> edge count`. */
export type ObiaAdjacency = Map<number, Map<number, number>>;

/**
 * The adjacency graph of a label grid: which objects share pixel edges, and
 * how many (4-connectivity; NoData is not a neighbor).
 */
export function objectAdjacency(grid: ObiaLabelGrid): ObiaAdjacency {
  const graph: ObiaAdjacency = new Map();
  const add = (a: number, b: number) => {
    let row = graph.get(a);
    if (!row) graph.set(a, (row = new Map()));
    row.set(b, (row.get(b) ?? 0) + 1);
  };
  const { width, height, ids } = grid;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const a = ids[i];
      if (!a) continue;
      if (x + 1 < width) {
        const b = ids[i + 1];
        if (b && b !== a) {
          add(a, b);
          add(b, a);
        }
      }
      if (y + 1 < height) {
        const b = ids[i + width];
        if (b && b !== a) {
          add(a, b);
          add(b, a);
        }
      }
    }
  }
  return graph;
}

/** Pooled statistics of one region while merging. */
interface Region {
  n: number;
  mean: number[];
  /** Mean of squares, per band, so pooling is exact. */
  meanSq: number[];
  version: number;
}

const regionStd = (region: Region, b: number) =>
  Math.sqrt(Math.max(region.meanSq[b] - region.mean[b] * region.mean[b], 0));

/** A binary min-heap of candidate merges, ordered by cost then ids. */
class MergeHeap {
  private items: { cost: number; a: number; b: number; va: number; vb: number }[] = [];
  get size(): number {
    return this.items.length;
  }
  private less(i: number, j: number): boolean {
    const x = this.items[i];
    const y = this.items[j];
    return x.cost !== y.cost ? x.cost < y.cost : x.a !== y.a ? x.a < y.a : x.b < y.b;
  }
  push(item: { cost: number; a: number; b: number; va: number; vb: number }): void {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) break;
      [items[i], items[parent]] = [items[parent], items[i]];
      i = parent;
    }
  }
  pop(): { cost: number; a: number; b: number; va: number; vb: number } | undefined {
    const items = this.items;
    if (!items.length) return undefined;
    const top = items[0];
    const last = items.pop()!;
    if (items.length) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < items.length && this.less(l, m)) m = l;
        if (r < items.length && this.less(r, m)) m = r;
        if (m === i) break;
        [items[i], items[m]] = [items[m], items[i]];
        i = m;
      }
    }
    return top;
  }
}

/** Options for building a coarser level. */
export interface ObiaMergeOptions {
  /**
   * Scale: merging stops when the cheapest merge raises the size-weighted
   * standard deviation (in standardized band units) by more than scale².
   */
  scale: number;
  /** 1-based source bands whose `mean_b<n>`/`std_b<n>` drive the merge. */
  bands: readonly number[];
}

/**
 * Merge adjacent objects into parents, best-first by color heterogeneity.
 *
 * @param table Child features: needs `mean_b<n>`, `std_b<n>` for the bands and
 *   `area_px`.
 * @param adjacency The children's adjacency graph.
 * @param options Scale and bands.
 * @returns Each child's parent id; parents are numbered 1..k in order of their
 *   smallest child id.
 * @throws When a child lacks the statistics the merge needs.
 */
export function mergeObjects(
  table: ObiaFeatureTable,
  adjacency: ObiaAdjacency,
  options: ObiaMergeOptions,
): Map<number, number> {
  const bands = [...options.bands];
  const missing = bands.flatMap((b) =>
    [`mean_b${b}`, `std_b${b}`].filter((field) => !table.fields.includes(field)),
  );
  if (!bands.length || missing.length || !table.fields.includes("area_px")) {
    throw new Error(
      "Merging needs each object's band means, standard deviations and size: measure spectral statistics first.",
    );
  }
  // Standardize the bands by their global pixel standard deviation, so the
  // scale means the same for any value range.
  let total = 0;
  const sum = bands.map(() => 0);
  const sumSq = bands.map(() => 0);
  const regions = new Map<number, Region>();
  for (const [id, row] of table.rows) {
    const n = row.area_px ?? 0;
    if (!(n > 0)) continue;
    const mean = bands.map((b) => row[`mean_b${b}`] ?? 0);
    const std = bands.map((b) => row[`std_b${b}`] ?? 0);
    regions.set(id, {
      n,
      mean,
      meanSq: mean.map((m, i) => std[i] * std[i] + m * m),
      version: 0,
    });
    total += n;
    mean.forEach((m, i) => {
      sum[i] += n * m;
      sumSq[i] += n * (std[i] * std[i] + m * m);
    });
  }
  const scaleOf = bands.map((_, i) => {
    const m = sum[i] / total;
    const sd = Math.sqrt(Math.max(sumSq[i] / total - m * m, 0));
    return sd > 0 ? sd : 1;
  });
  const heterogeneity = (region: Region) =>
    bands.reduce((acc, _, i) => acc + (region.n * regionStd(region, i)) / scaleOf[i], 0);
  const merged = (a: Region, b: Region): Region => {
    const n = a.n + b.n;
    return {
      n,
      mean: a.mean.map((m, i) => (a.n * m + b.n * b.mean[i]) / n),
      meanSq: a.meanSq.map((m, i) => (a.n * m + b.n * b.meanSq[i]) / n),
      version: 0,
    };
  };
  const cost = (a: Region, b: Region) =>
    heterogeneity(merged(a, b)) - heterogeneity(a) - heterogeneity(b);

  // Union-find over child ids; a root keeps the region and its neighbors.
  const root = new Map<number, number>();
  const find = (id: number): number => {
    let r = id;
    while (root.get(r) !== r) r = root.get(r)!;
    let x = id;
    while (root.get(x) !== r) {
      const next = root.get(x)!;
      root.set(x, r);
      x = next;
    }
    return r;
  };
  const neighbors = new Map<number, Set<number>>();
  for (const id of regions.keys()) {
    root.set(id, id);
    neighbors.set(
      id,
      new Set([...(adjacency.get(id)?.keys() ?? [])].filter((other) => regions.has(other))),
    );
  }

  const heap = new MergeHeap();
  const limit = options.scale * options.scale;
  const consider = (a: number, b: number) => {
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const ra = regions.get(lo)!;
    const rb = regions.get(hi)!;
    const c = cost(ra, rb);
    if (c <= limit) heap.push({ cost: c, a: lo, b: hi, va: ra.version, vb: rb.version });
  };
  for (const [id, set] of neighbors) for (const other of set) if (id < other) consider(id, other);

  while (heap.size) {
    const edge = heap.pop()!;
    const ra = regions.get(edge.a);
    const rb = regions.get(edge.b);
    // Stale: one side has merged or changed since this cost was computed.
    if (!ra || !rb || ra.version !== edge.va || rb.version !== edge.vb) continue;
    const next = merged(ra, rb);
    next.version = Math.max(ra.version, rb.version) + 1;
    regions.set(edge.a, next);
    regions.delete(edge.b);
    root.set(edge.b, edge.a);
    const set = neighbors.get(edge.a)!;
    for (const other of neighbors.get(edge.b)!) {
      if (other === edge.a) continue;
      set.add(other);
      const theirs = neighbors.get(other)!;
      theirs.delete(edge.b);
      theirs.add(edge.a);
    }
    set.delete(edge.b);
    neighbors.delete(edge.b);
    for (const other of set) consider(edge.a, other);
  }

  // Number parents by their smallest child, so the result is reproducible.
  const parentOf = new Map<number, number>();
  const numbering = new Map<number, number>();
  for (const id of [...root.keys()].sort((a, b) => a - b)) {
    const r = find(id);
    let parent = numbering.get(r);
    if (parent == null) numbering.set(r, (parent = numbering.size + 1));
    parentOf.set(id, parent);
  }
  return parentOf;
}

/**
 * Relabel a grid's objects with their parents' ids.
 *
 * @param grid The child grid.
 * @param parentOf Each child's parent; a child without one becomes NoData.
 */
export function relabelGrid(
  grid: ObiaLabelGrid,
  parentOf: ReadonlyMap<number, number>,
): Int32Array {
  const out = new Int32Array(grid.ids.length);
  for (let i = 0; i < grid.ids.length; i += 1) {
    const id = grid.ids[i];
    out[i] = id ? (parentOf.get(id) ?? 0) : 0;
  }
  return out;
}

/** Which feature groups a level's table carries (as its child level's). */
export interface ObiaLevelFeatureOptions {
  spectral: boolean;
  shape: boolean;
  context: boolean;
  indices?: ObiaIndexBands;
}

/**
 * Features of a parent level: spectral statistics pooled exactly from the
 * children, shape and neighbor context from the parent grid, with the field
 * names of the measurement tools. GLCM texture is not carried up.
 *
 * @param children The child level's features.
 * @param parentOf Each child's parent id.
 * @param parentIds The parent grid ({@link relabelGrid}).
 * @param grid The child grid, for its size.
 * @param bandIndexes 1-based bands with spectral statistics.
 * @param options Which groups to compute.
 */
export function levelFeatures(
  children: ObiaFeatureTable,
  parentOf: ReadonlyMap<number, number>,
  parentIds: Int32Array,
  grid: Pick<ObiaLabelGrid, "width" | "height">,
  bandIndexes: readonly number[],
  options: ObiaLevelFeatureOptions,
): ObiaFeatureTable {
  const table: ObiaFeatureTable = { fields: [], rows: new Map() };
  const row = (id: number) => {
    let r = table.rows.get(id);
    if (!r) table.rows.set(id, (r = {}));
    return r;
  };
  const field = (name: string) => {
    if (!table.fields.includes(name)) table.fields.push(name);
  };

  if (options.spectral) {
    const acc = new Map<
      number,
      { n: number; sum: number[]; sumSq: number[]; min: number[]; max: number[] }
    >();
    for (const [child, values] of children.rows) {
      const parent = parentOf.get(child);
      const n = values.area_px ?? 0;
      if (!parent || !(n > 0)) continue;
      let a = acc.get(parent);
      if (!a) {
        a = {
          n: 0,
          sum: bandIndexes.map(() => 0),
          sumSq: bandIndexes.map(() => 0),
          min: bandIndexes.map(() => Infinity),
          max: bandIndexes.map(() => -Infinity),
        };
        acc.set(parent, a);
      }
      a.n += n;
      bandIndexes.forEach((b, i) => {
        const mean = values[`mean_b${b}`] ?? 0;
        const std = values[`std_b${b}`] ?? 0;
        a!.sum[i] += n * mean;
        a!.sumSq[i] += n * (std * std + mean * mean);
        a!.min[i] = Math.min(a!.min[i], values[`min_b${b}`] ?? Infinity);
        a!.max[i] = Math.max(a!.max[i], values[`max_b${b}`] ?? -Infinity);
      });
    }
    for (const b of bandIndexes) {
      for (const name of ["mean", "std", "min", "max"]) field(`${name}_b${b}`);
    }
    for (const [parent, a] of acc) {
      const r = row(parent);
      bandIndexes.forEach((b, i) => {
        const mean = a.sum[i] / a.n;
        r[`mean_b${b}`] = mean;
        r[`std_b${b}`] = Math.sqrt(Math.max(a.sumSq[i] / a.n - mean * mean, 0));
        r[`min_b${b}`] = Number.isFinite(a.min[i]) ? a.min[i] : null;
        r[`max_b${b}`] = Number.isFinite(a.max[i]) ? a.max[i] : null;
      });
    }
  }

  // One scan of the parent grid: area, perimeter (edges to another object or
  // the border), bounding box, and shared edges between objects.
  const { width, height } = grid;
  const area = new Map<number, number>();
  const perimeter = new Map<number, number>();
  const box = new Map<number, [number, number, number, number]>();
  const shared = new Map<number, Map<number, number>>();
  const bump = (map: Map<number, number>, id: number, by = 1) =>
    map.set(id, (map.get(id) ?? 0) + by);
  const share = (a: number, b: number) => {
    let m = shared.get(a);
    if (!m) shared.set(a, (m = new Map()));
    bump(m, b);
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const id = parentIds[i];
      if (!id) continue;
      bump(area, id);
      const b = box.get(id);
      if (!b) box.set(id, [x, y, x, y]);
      else {
        if (x < b[0]) b[0] = x;
        if (y < b[1]) b[1] = y;
        if (x > b[2]) b[2] = x;
        if (y > b[3]) b[3] = y;
      }
      const left = x > 0 ? parentIds[i - 1] : -1;
      const right = x + 1 < width ? parentIds[i + 1] : -1;
      const up = y > 0 ? parentIds[i - width] : -1;
      const down = y + 1 < height ? parentIds[i + width] : -1;
      for (const other of [left, right, up, down]) {
        if (other === id) continue;
        bump(perimeter, id);
        if (other > 0) share(id, other);
      }
    }
  }
  if (options.shape || options.spectral) field("area_px");
  for (const [id, n] of area) row(id).area_px = n;
  if (options.shape) {
    for (const name of [
      "perimeter_px",
      "compactness",
      "bbox_width_px",
      "bbox_height_px",
      "elongation",
    ]) {
      field(name);
    }
    for (const [id, n] of area) {
      const p = perimeter.get(id) ?? 0;
      const [x0, y0, x1, y1] = box.get(id)!;
      const w = x1 - x0 + 1;
      const h = y1 - y0 + 1;
      Object.assign(row(id), {
        perimeter_px: p,
        compactness: p ? (4 * Math.PI * n) / (p * p) : null,
        bbox_width_px: w,
        bbox_height_px: h,
        elongation: Math.max(w, h) / Math.min(w, h),
      });
    }
  }
  if (options.context) {
    for (const name of ["neighbor_count", "shared_boundary_total", "mean_shared_boundary"])
      field(name);
    for (const id of area.keys()) {
      const m = shared.get(id);
      const count = m?.size ?? 0;
      const totalShared = m ? [...m.values()].reduce((a, b) => a + b, 0) : 0;
      Object.assign(row(id), {
        neighbor_count: count,
        shared_boundary_total: totalShared,
        mean_shared_boundary: count ? totalShared / count : 0,
      });
    }
  }
  if (options.spectral && options.indices) addSpectralIndices(table, bandIndexes, options.indices);
  return table;
}

/** The `segment_id` of each parent's children, for the level mapping. */
export function childrenOf(parentOf: ReadonlyMap<number, number>): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const [child, parent] of parentOf) {
    const list = children.get(parent);
    if (list) list.push(child);
    else children.set(parent, [child]);
  }
  return children;
}
