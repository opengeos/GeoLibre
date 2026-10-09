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
  // Float32 holds ids exactly up to 2^24: well above the object count of any
  // grid the browser handles (OBIA_MAX_PIXELS is 4096 x 4096).
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
  // the border), bounding box, and shared edges between objects. Typed
  // accumulators indexed by a dense slot per id keep it fast on big grids.
  const { width, height } = grid;
  let maxId = 0;
  for (let i = 0; i < parentIds.length; i += 1) if (parentIds[i] > maxId) maxId = parentIds[i];
  const slotById = maxId <= 4 * parentIds.length ? new Int32Array(maxId + 1).fill(-1) : null;
  const slotMap = slotById ? null : new Map<number, number>();
  const idOfSlot: number[] = [];
  const slotOf = (id: number): number => {
    let slot = slotById ? slotById[id] : (slotMap!.get(id) ?? -1);
    if (slot < 0) {
      slot = idOfSlot.length;
      idOfSlot.push(id);
      if (slotById) slotById[id] = slot;
      else slotMap!.set(id, slot);
    }
    return slot;
  };
  const capacity = () => idOfSlot.length;
  let areaAcc = new Float64Array(1024);
  let perimeterAcc = new Float64Array(1024);
  let x0Acc = new Int32Array(1024);
  let y0Acc = new Int32Array(1024);
  let x1Acc = new Int32Array(1024);
  let y1Acc = new Int32Array(1024);
  const grow = () => {
    const size = areaAcc.length * 2;
    const f = (a: Float64Array) => {
      const b = new Float64Array(size);
      b.set(a);
      return b;
    };
    const g = (a: Int32Array) => {
      const b = new Int32Array(size);
      b.set(a);
      return b;
    };
    areaAcc = f(areaAcc);
    perimeterAcc = f(perimeterAcc);
    x0Acc = g(x0Acc);
    y0Acc = g(y0Acc);
    x1Acc = g(x1Acc);
    y1Acc = g(y1Acc);
  };
  const shared = new Map<number, Map<number, number>>();
  const share = (a: number, b: number) => {
    let m = shared.get(a);
    if (!m) shared.set(a, (m = new Map()));
    m.set(b, (m.get(b) ?? 0) + 1);
  };
  const edge = (id: number, slot: number, other: number) => {
    if (other === id) return;
    perimeterAcc[slot] += 1;
    if (other > 0) share(id, other);
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const id = parentIds[i];
      if (!id) continue;
      const before = capacity();
      const slot = slotOf(id);
      if (slot >= areaAcc.length) grow();
      if (slot === before) {
        x0Acc[slot] = x1Acc[slot] = x;
        y0Acc[slot] = y1Acc[slot] = y;
      } else {
        if (x < x0Acc[slot]) x0Acc[slot] = x;
        if (x > x1Acc[slot]) x1Acc[slot] = x;
        if (y > y1Acc[slot]) y1Acc[slot] = y;
      }
      areaAcc[slot] += 1;
      edge(id, slot, x > 0 ? parentIds[i - 1] : -1);
      edge(id, slot, x + 1 < width ? parentIds[i + 1] : -1);
      edge(id, slot, y > 0 ? parentIds[i - width] : -1);
      edge(id, slot, y + 1 < height ? parentIds[i + width] : -1);
    }
  }
  const area = new Map<number, number>();
  const perimeter = new Map<number, number>();
  const box = new Map<number, [number, number, number, number]>();
  idOfSlot.forEach((id, slot) => {
    area.set(id, areaAcc[slot]);
    perimeter.set(id, perimeterAcc[slot]);
    box.set(id, [x0Acc[slot], y0Acc[slot], x1Acc[slot], y1Acc[slot]]);
  });
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

/**
 * A field-name-safe form of a class name for the per-class context fields,
 * unique among `taken` (which it extends).
 *
 * @param name The class name.
 * @param taken Slugs already used.
 */
export function classFieldSlug(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "class";
  let slug = base;
  for (let n = 2; taken.has(slug); n += 1) slug = `${base}_${n}`;
  taken.add(slug);
  return slug;
}

/** What context features are computed from. */
export interface ObiaContextInputs {
  /** This level's features and adjacency. */
  table: ObiaFeatureTable;
  adjacency: ObiaAdjacency;
  /** 1-based bands whose means get a neighbor contrast. */
  bands: readonly number[];
  /** Class names, in legend order, for the per-class fields. */
  classes: readonly string[];
  /** The level above: each of this level's objects' parent, and its features and classes. */
  parent?: {
    parentOf: ReadonlyMap<number, number>;
    table: ObiaFeatureTable;
    predictions?: ReadonlyMap<number, string>;
  };
  /** The level below: each child's parent here, its size and its class. */
  children?: {
    parentOf: ReadonlyMap<number, number>;
    areas: ReadonlyMap<number, number>;
    predictions?: ReadonlyMap<number, string>;
  };
}

/** Parent fields copied down as `parent_<field>`. */
const PARENT_FIELD = /^(mean_b\d+|brightness|ndvi|ndwi|area_px|child_count)$/;

/**
 * Context features of a level's objects, for rules and classifiers:
 *
 * - `nb_contrast_b<n>`: the object's band mean minus its neighbors', weighted
 *   by shared border;
 * - `parent_<field>` (band means, indices, size) and `parent_is_<class>`
 *   (1 or 0) from the level above, when there is one (the classes once it is
 *   classified): class inheritance as features;
 * - `child_frac_<class>`: the share of the object's area in each class of the
 *   level below, once that level is classified.
 *
 * @param inputs This level and its neighbors in the hierarchy.
 * @returns A table with only the context fields.
 */
export function contextFeatures(inputs: ObiaContextInputs): ObiaFeatureTable {
  const { table, adjacency } = inputs;
  const out: ObiaFeatureTable = { fields: [], rows: new Map() };
  for (const id of table.rows.keys()) out.rows.set(id, {});
  const set = (id: number, field: string, value: number | null) => {
    if (!out.fields.includes(field)) out.fields.push(field);
    const row = out.rows.get(id);
    if (row) row[field] = value;
  };
  const taken = new Set<string>();
  const slugs = inputs.classes.map((name) => [name, classFieldSlug(name, taken)] as const);

  for (const band of inputs.bands) {
    const field = `mean_b${band}`;
    if (!table.fields.includes(field)) continue;
    for (const [id, row] of table.rows) {
      const own = row[field];
      let weight = 0;
      let sum = 0;
      for (const [other, edges] of adjacency.get(id) ?? []) {
        const value = table.rows.get(other)?.[field];
        if (value == null) continue;
        weight += edges;
        sum += edges * value;
      }
      set(id, `nb_contrast_b${band}`, own != null && weight > 0 ? own - sum / weight : null);
    }
  }

  const parent = inputs.parent;
  if (parent) {
    const fields = parent.table.fields.filter((field) => PARENT_FIELD.test(field));
    for (const id of table.rows.keys()) {
      const p = parent.parentOf.get(id);
      const row = p != null ? parent.table.rows.get(p) : undefined;
      for (const field of fields) set(id, `parent_${field}`, row?.[field] ?? null);
      if (parent.predictions?.size) {
        const name = p != null ? parent.predictions.get(p) : undefined;
        for (const [className, slug] of slugs) {
          set(id, `parent_is_${slug}`, name == null ? null : name === className ? 1 : 0);
        }
      }
    }
  }

  const children = inputs.children;
  if (children?.predictions?.size) {
    const totals = new Map<number, number>();
    const byClass = new Map<number, Map<string, number>>();
    for (const [child, id] of children.parentOf) {
      const area = children.areas.get(child) ?? 0;
      totals.set(id, (totals.get(id) ?? 0) + area);
      const name = children.predictions.get(child);
      if (name == null) continue;
      let m = byClass.get(id);
      if (!m) byClass.set(id, (m = new Map()));
      m.set(name, (m.get(name) ?? 0) + area);
    }
    for (const id of table.rows.keys()) {
      const total = totals.get(id) ?? 0;
      for (const [className, slug] of slugs) {
        const area = byClass.get(id)?.get(className) ?? 0;
        set(id, `child_frac_${slug}`, total > 0 ? area / total : null);
      }
    }
  }
  return out;
}

/** Whether a feature field is a context feature ({@link contextFeatures}). */
export const isContextField = (field: string): boolean =>
  /^(nb_contrast_|parent_|child_frac_)/.test(field);
