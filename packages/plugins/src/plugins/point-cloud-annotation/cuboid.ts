// Cuboid (3D bounding box) geometry for the point cloud annotator. Points are
// stored as lng/lat degree offsets from a cloud origin with Z in metres, so
// box math runs in a local east-north-up frame in metres around that origin.

/** A 3D box: centre in lng/lat/metres, size in metres, yaw about the vertical. */
export interface Cuboid {
  /** Box centre: longitude, latitude (degrees) and elevation (metres). */
  center: [number, number, number];
  /** Length (along the heading), width and height, in metres. */
  size: [number, number, number];
  /** Heading in radians, counter-clockwise from east. */
  yaw: number;
}

const EARTH_RADIUS = 6378137;
const DEG = Math.PI / 180;

/** Converts between degree offsets and local metres around a latitude. */
export interface LocalFrame {
  /** Metres per degree of longitude. */
  mx: number;
  /** Metres per degree of latitude. */
  my: number;
}

/**
 * The local metric frame at a latitude (spherical approximation, accurate to
 * well under a centimetre across a LiDAR tile).
 *
 * @param latitude - Latitude of the frame origin in degrees.
 * @returns Metres per degree along each axis.
 */
export function localFrame(latitude: number): LocalFrame {
  const my = EARTH_RADIUS * DEG;
  return { mx: my * Math.cos(latitude * DEG), my };
}

/**
 * Transforms a point into the cuboid's own frame: x along the heading, y to
 * its left, z up, all in metres from the box centre.
 *
 * @param cuboid - The box.
 * @param lng - Point longitude.
 * @param lat - Point latitude.
 * @param z - Point elevation (metres).
 * @param frame - Local frame at the box latitude.
 * @returns `[x, y, z]` in the box frame.
 */
export function toBoxFrame(
  cuboid: Cuboid,
  lng: number,
  lat: number,
  z: number,
  frame: LocalFrame = localFrame(cuboid.center[1]),
): [number, number, number] {
  const east = (lng - cuboid.center[0]) * frame.mx;
  const north = (lat - cuboid.center[1]) * frame.my;
  const cos = Math.cos(cuboid.yaw);
  const sin = Math.sin(cuboid.yaw);
  return [east * cos + north * sin, -east * sin + north * cos, z - cuboid.center[2]];
}

/**
 * Inverse of {@link toBoxFrame}.
 *
 * @param cuboid - The box.
 * @param x - Along the heading (metres).
 * @param y - To the left of the heading (metres).
 * @param z - Up from the box centre (metres).
 * @param frame - Local frame at the box latitude.
 * @returns `[lng, lat, z]`.
 */
export function fromBoxFrame(
  cuboid: Cuboid,
  x: number,
  y: number,
  z: number,
  frame: LocalFrame = localFrame(cuboid.center[1]),
): [number, number, number] {
  const cos = Math.cos(cuboid.yaw);
  const sin = Math.sin(cuboid.yaw);
  const east = x * cos - y * sin;
  const north = x * sin + y * cos;
  return [
    cuboid.center[0] + east / frame.mx,
    cuboid.center[1] + north / frame.my,
    cuboid.center[2] + z,
  ];
}

/**
 * The box's eight corners, bottom face first (counter-clockwise from the
 * back-right corner), then the top face in the same order.
 *
 * @param cuboid - The box.
 * @returns Corners as `[lng, lat, z]`.
 */
export function cuboidCorners(cuboid: Cuboid): [number, number, number][] {
  const [l, w, h] = cuboid.size;
  const frame = localFrame(cuboid.center[1]);
  const footprint: [number, number][] = [
    [-l / 2, -w / 2],
    [l / 2, -w / 2],
    [l / 2, w / 2],
    [-l / 2, w / 2],
  ];
  return [-h / 2, h / 2].flatMap((z) =>
    footprint.map(([x, y]) => fromBoxFrame(cuboid, x, y, z, frame)),
  );
}

/** The twelve edges of a box, as index pairs into {@link cuboidCorners}. */
export const CUBOID_EDGES: readonly [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 4],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
];

/** Points stored as offsets from an origin, as the LiDAR control holds them. */
export interface OffsetPoints {
  positions: Float32Array;
  coordinateOrigin: readonly [number, number, number];
  pointCount: number;
}

/**
 * Finds the points inside a box, optionally grown by a margin on every side.
 *
 * @param points - The cloud.
 * @param cuboid - The box.
 * @param margin - Metres added to each half-extent (0 for the box itself).
 * @returns Ascending indices of the points inside.
 */
export function pointsInCuboid(points: OffsetPoints, cuboid: Cuboid, margin = 0): Uint32Array {
  const frame = localFrame(cuboid.center[1]);
  const [lng0, lat0] = points.coordinateOrigin;
  // A millimetre of slack keeps points on a fitted box's faces inside despite
  // the Float32 rounding of their stored positions.
  const slack = margin + 1e-3;
  const hx = cuboid.size[0] / 2 + slack;
  const hy = cuboid.size[1] / 2 + slack;
  const hz = cuboid.size[2] / 2 + slack;
  // Offsets of the box centre from the cloud origin, so the per-point work
  // stays in small numbers.
  const cx = (cuboid.center[0] - lng0) * frame.mx;
  const cy = (cuboid.center[1] - lat0) * frame.my;
  const cos = Math.cos(cuboid.yaw);
  const sin = Math.sin(cuboid.yaw);
  const reach = Math.hypot(hx, hy);
  const inside: number[] = [];
  const count = Math.min(points.pointCount, Math.floor(points.positions.length / 3));
  for (let i = 0; i < count; i++) {
    const dz = points.positions[i * 3 + 2] - cuboid.center[2];
    if (dz < -hz || dz > hz) continue;
    const east = points.positions[i * 3] * frame.mx - cx;
    const north = points.positions[i * 3 + 1] * frame.my - cy;
    if (Math.abs(east) > reach || Math.abs(north) > reach) continue;
    const x = east * cos + north * sin;
    if (x < -hx || x > hx) continue;
    const y = -east * sin + north * cos;
    if (y < -hy || y > hy) continue;
    inside.push(i);
  }
  return Uint32Array.from(inside);
}

/** Andrew's monotone chain; returns the hull counter-clockwise. */
function convexHull(xs: Float64Array, ys: Float64Array): [number, number][] {
  const order = Array.from(xs.keys()).sort((a, b) => xs[a] - xs[b] || ys[a] - ys[b]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const i of order) {
    const p: [number, number] = [xs[i], ys[i]];
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let k = order.length - 1; k >= 0; k--) {
    const p: [number, number] = [xs[order[k]], ys[order[k]]];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
      upper.pop();
    upper.push(p);
  }
  // A lone (or all-duplicate) point: both chains hold just it, and dropping
  // the shared endpoints below would return an empty hull.
  if (lower.length === 1 && upper.length === 1) return lower;
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Fits the tightest box around a set of points: the minimum-area rectangle of
 * their horizontal convex hull (rotating calipers over the hull edges) and
 * their vertical extent. The heading follows the rectangle's longer side.
 *
 * @param points - The cloud.
 * @param indices - Points to enclose (at least one).
 * @returns The fitted box, or null for an empty selection.
 */
export function fitCuboid(points: OffsetPoints, indices: ArrayLike<number>): Cuboid | null {
  if (indices.length === 0) return null;
  const [lng0, lat0] = points.coordinateOrigin;
  let latSum = 0;
  for (let k = 0; k < indices.length; k++) latSum += points.positions[indices[k] * 3 + 1];
  const frame = localFrame(lat0 + latSum / indices.length);
  const xs = new Float64Array(indices.length);
  const ys = new Float64Array(indices.length);
  let zMin = Infinity;
  let zMax = -Infinity;
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    xs[k] = points.positions[i * 3] * frame.mx;
    ys[k] = points.positions[i * 3 + 1] * frame.my;
    const z = points.positions[i * 3 + 2];
    if (z < zMin) zMin = z;
    if (z > zMax) zMax = z;
  }
  const hull = convexHull(xs, ys);
  let best = { area: Infinity, angle: 0, minU: 0, maxU: 0, minV: 0, maxV: 0 };
  const candidates = hull.length >= 2 ? hull.length : 1;
  for (let e = 0; e < candidates; e++) {
    const a = hull[e] ?? [xs[0], ys[0]];
    const b = hull[(e + 1) % hull.length] ?? a;
    const angle = hull.length >= 2 ? Math.atan2(b[1] - a[1], b[0] - a[0]) : 0;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const [x, y] of hull.length ? hull : [[xs[0], ys[0]] as [number, number]]) {
      const u = x * cos + y * sin;
      const v = -x * sin + y * cos;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < best.area) best = { area, angle, minU, maxU, minV, maxV };
  }
  let { angle } = best;
  let length = best.maxU - best.minU;
  let width = best.maxV - best.minV;
  const cu = (best.minU + best.maxU) / 2;
  const cv = (best.minV + best.maxV) / 2;
  const cx = cu * Math.cos(angle) - cv * Math.sin(angle);
  const cy = cu * Math.sin(angle) + cv * Math.cos(angle);
  if (width > length) {
    [length, width] = [width, length];
    angle += Math.PI / 2;
  }
  // Normalise to (-pi, pi].
  angle = Math.atan2(Math.sin(angle), Math.cos(angle));
  return {
    center: [lng0 + cx / frame.mx, lat0 + cy / frame.my, (zMin + zMax) / 2],
    size: [Math.max(length, 0.01), Math.max(width, 0.01), Math.max(zMax - zMin, 0.01)],
    yaw: angle,
  };
}

/**
 * Grows a cluster from a seed point: every point reachable through hops of at
 * most `radius` metres, skipping points below `minZ`. A voxel hash keeps each
 * hop to the neighbouring cells, so a click costs only the cluster's size.
 *
 * @param points - The cloud.
 * @param seed - Index of the clicked point.
 * @param options - Hop radius (m), a floor to exclude ground, and a size cap.
 * @returns Indices of the cluster, including the seed.
 */
export function growCluster(
  points: OffsetPoints,
  seed: number,
  options: {
    radius?: number;
    minZ?: number;
    maxPoints?: number;
    searchRadius?: number;
    /** Points never joined to the cluster (e.g. ground or noise classes). */
    skip?: (index: number) => boolean;
  } = {},
): Uint32Array {
  const radius = options.radius ?? 0.5;
  const minZ = options.minZ ?? -Infinity;
  const maxPoints = options.maxPoints ?? 200_000;
  const search = options.searchRadius ?? 30;
  const [, lat0] = points.coordinateOrigin;
  const frame = localFrame(lat0);
  const px = points.positions[seed * 3] * frame.mx;
  const py = points.positions[seed * 3 + 1] * frame.my;
  // Hash only the neighbourhood of the seed, not the whole cloud.
  const cells = new Map<string, number[]>();
  const key = (x: number, y: number, z: number) =>
    `${Math.floor(x / radius)},${Math.floor(y / radius)},${Math.floor(z / radius)}`;
  const count = Math.min(points.pointCount, Math.floor(points.positions.length / 3));
  for (let i = 0; i < count; i++) {
    const x = points.positions[i * 3] * frame.mx;
    const y = points.positions[i * 3 + 1] * frame.my;
    const z = points.positions[i * 3 + 2];
    if (Math.abs(x - px) > search || Math.abs(y - py) > search || z < minZ) continue;
    if (options.skip?.(i) && i !== seed) continue;
    const k = key(x, y, z);
    let cell = cells.get(k);
    if (!cell) cells.set(k, (cell = []));
    cell.push(i);
  }
  const visited = new Set<number>([seed]);
  const queue = [seed];
  const r2 = radius * radius;
  while (queue.length > 0 && visited.size < maxPoints) {
    const i = queue.pop()!;
    const x = points.positions[i * 3] * frame.mx;
    const y = points.positions[i * 3 + 1] * frame.my;
    const z = points.positions[i * 3 + 2];
    const cx = Math.floor(x / radius);
    const cy = Math.floor(y / radius);
    const cz = Math.floor(z / radius);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const cell = cells.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!cell) continue;
          for (const j of cell) {
            if (visited.has(j)) continue;
            const ex = points.positions[j * 3] * frame.mx - x;
            const ey = points.positions[j * 3 + 1] * frame.my - y;
            const ez = points.positions[j * 3 + 2] - z;
            if (ex * ex + ey * ey + ez * ez > r2) continue;
            visited.add(j);
            queue.push(j);
          }
        }
  }
  return Uint32Array.from([...visited].sort((a, b) => a - b));
}
