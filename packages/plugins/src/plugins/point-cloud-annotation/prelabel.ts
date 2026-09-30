// Pre-labelling: run a Whitebox LiDAR classifier on the session's points and
// take its classes as a starting point. The session is written as LAS in its
// own point order, the tool classifies it in place (same count, same order),
// and the result maps back to the loaded points by index.

/** A Whitebox tool the annotator offers as a pre-labeller. */
export interface PrelabelTool {
  /** Stable id for the panel's select. */
  id: string;
  /** Whitebox tool id. */
  toolId: string;
  /** Extra scalar parameters (all tools take `input` and `output`). */
  parameters: Record<string, string>;
  /** Catalog key and English label. */
  labelKey: string;
  label: string;
}

/**
 * The classifiers that keep every point in order, so results map back by
 * index. Both were checked on Autzen: `improved_ground_point_filter` filters
 * (drops points) unless `classify` is set.
 */
export const PRELABEL_TOOLS: readonly PrelabelTool[] = [
  {
    id: "ground",
    toolId: "improved_ground_point_filter",
    parameters: { classify: "true" },
    labelKey: "prelabelGround",
    label: "Ground (improved ground point filter)",
  },
  {
    id: "ground-vegetation",
    toolId: "classify_lidar",
    parameters: {},
    labelKey: "prelabelClassify",
    label: "Ground, vegetation and unclassified (classify LiDAR)",
  },
];

/**
 * Runs a Whitebox LiDAR tool on LAS bytes and returns the output LAS bytes.
 * Injected by the app (the plugins package cannot depend on the processing
 * package), backed by the in-browser WASM runner.
 */
export type PrelabelRunner = (
  toolId: string,
  parameters: Record<string, string>,
  las: Uint8Array,
) => Promise<Uint8Array>;

/**
 * Reads the per-point classification codes out of an uncompressed LAS file
 * (LAS 1.0-1.4, point formats 0-10).
 *
 * @param bytes - The LAS file.
 * @returns One class code per point, in file order.
 * @throws Error for a non-LAS or compressed (LAZ) file.
 */
export function readLasClassifications(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 227 || String.fromCharCode(...bytes.subarray(0, 4)) !== "LASF") {
    throw new Error("The tool did not return a LAS file.");
  }
  const formatByte = bytes[104];
  if (formatByte & 0xc0) throw new Error("The tool returned a compressed (LAZ) file.");
  const format = formatByte & 0x3f;
  const recordLength = view.getUint16(105, true);
  const pointOffset = view.getUint32(96, true);
  const minor = bytes[25];
  let count = view.getUint32(107, true);
  if (minor >= 4 && bytes.length >= 255) {
    const extended = Number(view.getBigUint64(247, true));
    if (extended > 0) count = extended;
  }
  // Formats 0-5 pack the class in the low 5 bits of byte 15; formats 6-10
  // give it a full byte at 16.
  const legacy = format < 6;
  const at = legacy ? 15 : 16;
  // Reject a header whose record geometry would read the same or out-of-record
  // bytes as classes (record length 0, or too short for the format).
  const minimumRecord = legacy ? 20 : 30;
  if (
    format > 10 ||
    recordLength < minimumRecord ||
    pointOffset < 227 ||
    pointOffset > bytes.length
  ) {
    throw new Error("The tool returned a malformed LAS file.");
  }
  const available = Math.floor((bytes.length - pointOffset) / recordLength);
  const n = Math.min(count, available);
  const classes = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const byte = bytes[pointOffset + i * recordLength + at];
    classes[i] = legacy ? byte & 0x1f : byte;
  }
  return classes;
}

/** Which of a tool's results to take. */
export interface PrelabelMergeOptions {
  /** Only relabel points that are still 0 (never classified) or 1 (unclassified). */
  onlyUnclassified: boolean;
  /** Classes whose points keep their class (locked or hidden). */
  protectedClasses: ReadonlySet<number>;
}

/**
 * Picks the points whose class the tool changed and that the options allow
 * relabelling, with their new codes.
 *
 * @param current - The session's classes.
 * @param result - The tool's classes, index for index.
 * @param options - Merge restrictions.
 * @returns Parallel arrays of point indices and new class codes.
 * @throws Error when the tool changed the number of points.
 */
export function mergePrelabels(
  current: Uint8Array,
  result: Uint8Array,
  count: number,
  options: PrelabelMergeOptions,
): { indices: Uint32Array; codes: Uint8Array } {
  if (result.length !== count) {
    throw new Error(
      `The tool returned ${result.length} points for ${count}; it must keep every point in order.`,
    );
  }
  const indices: number[] = [];
  const codes: number[] = [];
  for (let i = 0; i < count; i++) {
    const before = current[i];
    const after = result[i];
    if (after === before) continue;
    if (options.onlyUnclassified && before !== 0 && before !== 1) continue;
    if (options.protectedClasses.has(before)) continue;
    indices.push(i);
    codes.push(after);
  }
  return { indices: Uint32Array.from(indices), codes: Uint8Array.from(codes) };
}

/** Points stored as offsets from an origin (the LiDAR control's layout). */
interface TileablePoints {
  positions: Float32Array;
  coordinateOrigin: readonly [number, number, number];
  pointCount: number;
}

/** Smallest tile edge (m) before a too-dense tile is refused. */
const MIN_TILE_SIZE = 2;

/** One unit of work: the points a tile owns and the points it is run on. */
export interface PrelabelTile {
  /** Points whose result this tile provides (each point is in one core). */
  core: Uint32Array;
  /** Core plus the buffer around it, the input the tool sees. */
  input: Uint32Array;
}

/**
 * Splits a cloud into square tiles of at most about `maxPoints` points, each
 * run with a `buffer`-metre margin of neighbours so a filter sees context at
 * tile edges. Whitebox's WASM build runs out of memory on a few million
 * points, so large sessions are processed tile by tile. Dense tiles are split
 * again (quadtree) until they fit.
 *
 * @param points - The cloud.
 * @param maxPoints - Target maximum core points per tile.
 * @param buffer - Overlap margin in metres.
 * @returns The tiles; a single tile when the cloud already fits.
 */
export function planPrelabelTiles(
  points: TileablePoints,
  maxPoints = 750_000,
  buffer = 20,
): PrelabelTile[] {
  const count = Math.min(points.pointCount, Math.floor(points.positions.length / 3));
  const all = Uint32Array.from({ length: count }, (_, i) => i);
  if (count <= maxPoints) return [{ core: all, input: all }];
  // Metres per degree at the origin (spherical; ample for tiling).
  const my = 6378137 * (Math.PI / 180);
  const mx = my * Math.cos((points.coordinateOrigin[1] * Math.PI) / 180);
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    xs[i] = points.positions[i * 3] * mx;
    ys[i] = points.positions[i * 3 + 1] * my;
  }
  const tiles: PrelabelTile[] = [];
  // Each call gets the points inside its tile's buffered bounds (`candidates`)
  // so a leaf builds its buffered input without rescanning the whole cloud.
  const split = (
    indices: Uint32Array,
    candidates: Uint32Array,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ) => {
    if (indices.length === 0) return;
    const inBuffered = (i: number, bx0: number, by0: number, bx1: number, by1: number) =>
      xs[i] >= bx0 - buffer &&
      xs[i] < bx1 + buffer &&
      ys[i] >= by0 - buffer &&
      ys[i] < by1 + buffer;
    if (indices.length <= maxPoints) {
      tiles.push({
        core: indices,
        input: candidates.filter((i) => inBuffered(i, x0, y0, x1, y1)),
      });
      return;
    }
    if (x1 - x0 < MIN_TILE_SIZE) {
      // Too dense to split further (e.g. a terrestrial scan): refuse rather
      // than hand the tool more points than it has memory for.
      throw new Error(
        `Too many points (${indices.length}) in a ${MIN_TILE_SIZE} m tile to pre-label; select a sparser area.`,
      );
    }
    const mxMid = (x0 + x1) / 2;
    const myMid = (y0 + y1) / 2;
    const quads: number[][] = [[], [], [], []];
    for (const i of indices) quads[(xs[i] >= mxMid ? 1 : 0) + (ys[i] >= myMid ? 2 : 0)].push(i);
    const bounds: [number, number, number, number][] = [
      [x0, y0, mxMid, myMid],
      [mxMid, y0, x1, myMid],
      [x0, myMid, mxMid, y1],
      [mxMid, myMid, x1, y1],
    ];
    bounds.forEach(([bx0, by0, bx1, by1], q) => {
      if (quads[q].length === 0) return;
      split(
        Uint32Array.from(quads[q]),
        candidates.filter((i) => inBuffered(i, bx0, by0, bx1, by1)),
        bx0,
        by0,
        bx1,
        by1,
      );
    });
  };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    minX = Math.min(minX, xs[i]);
    maxX = Math.max(maxX, xs[i]);
    minY = Math.min(minY, ys[i]);
    maxY = Math.max(maxY, ys[i]);
  }
  // A square root so the first split works on a square (no sliver tiles).
  const side = Math.max(maxX - minX, maxY - minY) + 1e-6;
  split(all, all, minX, minY, minX + side, minY + side);
  return tiles;
}

/**
 * Drops merged results for points that changed after the tool was given its
 * input (edits made during a long run), so they are not overwritten.
 *
 * @param merged - Output of {@link mergePrelabels} against `snapshot`.
 * @param snapshot - Classes when the run started.
 * @param current - Classes now.
 * @returns The results for points still at their snapshot class.
 */
export function keepUntouched(
  merged: { indices: Uint32Array; codes: Uint8Array },
  snapshot: Uint8Array,
  current: Uint8Array,
): { indices: Uint32Array; codes: Uint8Array } {
  const keep = merged.indices.map((i) => (current[i] === snapshot[i] ? 1 : 0));
  return {
    indices: merged.indices.filter((_, k) => keep[k] === 1),
    codes: merged.codes.filter((_, k) => keep[k] === 1),
  };
}
