// Screen-space point selection for the point cloud annotator: project every
// resident point with the LiDAR overlay's live viewport and keep those that
// fall inside a drawn rectangle or lasso.

/** The slice of a deck.gl `WebMercatorViewport` the projector needs. */
export interface ProjectionViewport {
  width: number;
  height: number;
  pixelProjectionMatrix: ArrayLike<number>;
  projectPosition(xyz: number[]): number[];
  getDistanceScales(coordinateOrigin?: number[]): {
    unitsPerDegree: number[];
    unitsPerDegree2?: number[];
  };
}

/** Projects one point, given as offsets from the cloud origin, to screen pixels. */
export type OffsetProjector = (dLng: number, dLat: number, z: number, out: Float64Array) => boolean;

/**
 * Builds a projector for points stored as `LNGLAT_OFFSETS` from `origin`, using
 * the same linearisation deck.gl's shader applies to that coordinate system,
 * so a point lands on the pixel it is drawn at without a per-point Mercator
 * transform.
 *
 * @param viewport - The overlay's current viewport.
 * @param origin - The cloud's coordinate origin `[lng, lat, z]`.
 * @returns A projector writing `[x, y]` CSS pixels (top-left origin) into `out`;
 *   it returns false for a point behind the camera.
 */
export function createOffsetProjector(
  viewport: ProjectionViewport,
  origin: readonly [number, number, number],
): OffsetProjector {
  const base = viewport.projectPosition([origin[0], origin[1], 0]);
  const scales = viewport.getDistanceScales([origin[0], origin[1]]);
  const upd = scales.unitsPerDegree;
  const upd2 = scales.unitsPerDegree2 ?? [0, 0, 0];
  const m = Array.from(viewport.pixelProjectionMatrix);
  const bx = base[0];
  const by = base[1];
  return (dLng, dLat, z, out) => {
    const cx = bx + dLng * (upd[0] + upd2[0] * dLat);
    const cy = by + dLat * (upd[1] + upd2[1] * dLat);
    const cz = z * (upd[2] + upd2[2] * dLat);
    const w = m[3] * cx + m[7] * cy + m[11] * cz + m[15];
    if (!(w > 0)) return false;
    out[0] = (m[0] * cx + m[4] * cy + m[8] * cz + m[12]) / w;
    out[1] = (m[1] * cx + m[5] * cy + m[9] * cz + m[13]) / w;
    return true;
  };
}

/** A shape drawn on screen, in CSS pixels relative to the map container. */
export type SelectionShape =
  | { kind: "rect"; x0: number; y0: number; x1: number; y1: number }
  | { kind: "polygon"; points: ReadonlyArray<readonly [number, number]> };

/** The per-point data selection reads. */
export interface SelectableCloud {
  /** `[dLng, dLat, z]` offsets from the cloud origin, three per point. */
  positions: Float32Array;
  classifications?: Uint8Array;
  pointCount: number;
  /** Added to each Z before projecting, as the renderer does. */
  zOffset: number;
}

/** Restrictions applied on top of the drawn shape. */
export interface SelectionFilters {
  /** Inclusive true-Z range (before any display offset). */
  minZ?: number | null;
  maxZ?: number | null;
  /** When set, only points currently in one of these classes are selected. */
  onlyClasses?: ReadonlySet<number> | null;
  /** Points in these classes are never selected (e.g. hidden classes). */
  skipClasses?: ReadonlySet<number> | null;
}

/** An axis-aligned pixel mask covering a shape's bounding box. */
interface ShapeMask {
  x0: number;
  y0: number;
  width: number;
  height: number;
  /** Null for a rectangle, whose mask is the full box. */
  bits: Uint8Array | null;
}

/**
 * Rasterises a shape into a pixel mask (even-odd fill for polygons), so each
 * point test is one array read however many vertices the lasso has.
 *
 * @param shape - Rectangle or polygon in CSS pixels.
 * @returns The mask, or null when the shape encloses no pixels.
 */
export function rasterizeShape(shape: SelectionShape): ShapeMask | null {
  if (shape.kind === "rect") {
    const x0 = Math.min(shape.x0, shape.x1);
    const y0 = Math.min(shape.y0, shape.y1);
    const width = Math.abs(shape.x1 - shape.x0);
    const height = Math.abs(shape.y1 - shape.y0);
    if (width < 1 || height < 1) return null;
    return { x0, y0, width, height, bits: null };
  }
  const points = shape.points;
  if (points.length < 3) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const x0 = Math.floor(minX);
  const y0 = Math.floor(minY);
  const width = Math.ceil(maxX) - x0 + 1;
  const height = Math.ceil(maxY) - y0 + 1;
  if (width < 2 || height < 2) return null;
  const bits = new Uint8Array(width * height);
  const crossings: number[] = [];
  for (let row = 0; row < height; row++) {
    const sampleY = y0 + row + 0.5;
    crossings.length = 0;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, yi] = points[i];
      const [xj, yj] = points[j];
      if (yi > sampleY !== yj > sampleY) {
        crossings.push(xi + ((sampleY - yi) / (yj - yi)) * (xj - xi));
      }
    }
    crossings.sort((a, b) => a - b);
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const start = Math.max(0, Math.ceil(crossings[k] - x0 - 0.5));
      const end = Math.min(width - 1, Math.floor(crossings[k + 1] - x0 - 0.5));
      bits.fill(1, row * width + start, row * width + end + 1);
    }
  }
  return { x0, y0, width, height, bits };
}

/**
 * Selects the points whose projected position falls inside `shape` and that
 * pass `filters`. Points are selected through all depths, like Segments.ai's
 * default, so narrow the Z range or class filter to avoid occluded points.
 *
 * @param cloud - The resident points.
 * @param project - Projector from {@link createOffsetProjector}.
 * @param shape - The drawn rectangle or lasso.
 * @param filters - Z range and class restrictions.
 * @returns Ascending indices of the selected points.
 */
export function selectPointsInShape(
  cloud: SelectableCloud,
  project: OffsetProjector,
  shape: SelectionShape,
  filters: SelectionFilters = {},
): Uint32Array {
  const mask = rasterizeShape(shape);
  if (!mask) return new Uint32Array(0);
  const { positions, classifications, zOffset } = cloud;
  const count = Math.min(cloud.pointCount, Math.floor(positions.length / 3));
  const minZ = filters.minZ ?? -Infinity;
  const maxZ = filters.maxZ ?? Infinity;
  const only = filters.onlyClasses && filters.onlyClasses.size > 0 ? filters.onlyClasses : null;
  const skip = filters.skipClasses && filters.skipClasses.size > 0 ? filters.skipClasses : null;
  const out = new Float64Array(2);
  const selected: number[] = [];
  const { x0, y0, width, height, bits } = mask;
  for (let i = 0; i < count; i++) {
    const z = positions[i * 3 + 2];
    if (z < minZ || z > maxZ) continue;
    if (classifications && (only || skip)) {
      const code = classifications[i];
      if (only && !only.has(code)) continue;
      if (skip && skip.has(code)) continue;
    }
    if (!project(positions[i * 3], positions[i * 3 + 1], z + zOffset, out)) continue;
    const px = out[0] - x0;
    const py = out[1] - y0;
    if (px < 0 || py < 0 || px >= width || py >= height) continue;
    if (bits && bits[Math.floor(py) * width + Math.floor(px)] === 0) continue;
    selected.push(i);
  }
  return Uint32Array.from(selected);
}

/** How a new selection combines with the current one. */
export type SelectionMode = "replace" | "add" | "subtract";

/**
 * Combines two ascending index sets.
 *
 * @param current - The existing selection (ascending).
 * @param next - The newly drawn selection (ascending).
 * @param mode - Replace, union or difference.
 * @returns The combined ascending selection.
 */
export function combineSelection(
  current: Uint32Array,
  next: Uint32Array,
  mode: SelectionMode,
): Uint32Array {
  if (mode === "replace") return next;
  const result: number[] = [];
  let i = 0;
  let j = 0;
  if (mode === "add") {
    while (i < current.length || j < next.length) {
      if (j >= next.length || (i < current.length && current[i] < next[j]))
        result.push(current[i++]);
      else if (i >= current.length || next[j] < current[i]) result.push(next[j++]);
      else {
        result.push(current[i]);
        i++;
        j++;
      }
    }
    return Uint32Array.from(result);
  }
  while (i < current.length) {
    while (j < next.length && next[j] < current[i]) j++;
    if (j >= next.length || next[j] !== current[i]) result.push(current[i]);
    i++;
  }
  return Uint32Array.from(result);
}
