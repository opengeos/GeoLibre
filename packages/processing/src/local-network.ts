import type { Feature, LineString, MultiLineString, Position } from "geojson";
import { getActiveMeanRadiusMeters } from "@geolibre/core";

/**
 * Client-side network graph over a user line layer: the engine behind the
 * local routing tools (shortest path, closest facility, service area) in
 * `network-tools.ts`. It needs no routing server, so it routes over any line
 * data the user has, such as trails, pipes, rivers, or a road extract.
 *
 * Topology rules:
 * - Every vertex of every line is a node, and vertices that coincide exactly
 *   are one node, so lines that share a vertex are connected there. Lines that
 *   merely cross without a shared vertex (a bridge over a road) stay apart.
 * - A line endpoint within the snap tolerance of another node merges into it,
 *   and a dangling endpoint within the tolerance of another line's segment
 *   splits that segment, which closes small digitizing gaps and T-junctions.
 *
 * Distances use the haversine formula on the active body's mean radius, so the
 * A* heuristic (straight-line distance times the cheapest cost per metre in the
 * graph) never overestimates and A* returns the same optimum as Dijkstra.
 */

/** How the cost of traversing an edge is derived. */
export type NetworkCostMode = "length" | "field" | "speed";

/** Which way travel is allowed along a line, relative to its digitized order. */
export type NetworkDirection = "both" | "forward" | "backward" | "closed";

/** Options for {@link buildLocalNetwork}. */
export interface LocalNetworkOptions {
  /**
   * `length`: cost is the length in metres. `field`: `costField` holds the
   * total cost of traversing the whole feature, spread over its parts by
   * length. `speed`: `costField` holds a speed in km/h and the cost is the
   * travel time in minutes.
   */
  costMode?: NetworkCostMode;
  /** Attribute read for the `field` and `speed` cost modes. */
  costField?: string;
  /** Optional one-way attribute, parsed by {@link parseDirection}. */
  directionField?: string;
  /** Endpoint snap tolerance in metres (0 disables snapping). */
  snapToleranceM?: number;
}

/** One directed-or-undirected straight segment of the network. */
export interface NetworkEdge {
  a: number;
  b: number;
  /** Cost of travelling a → b (Infinity when not allowed). */
  costAB: number;
  /** Cost of travelling b → a (Infinity when not allowed). */
  costBA: number;
  /** Segment length in metres. */
  length: number;
  /** Index of the source feature in the line layer. */
  feature: number;
}

/** Where a point lies on the network after {@link LocalNetwork.insertPoint}. */
export interface SnappedPoint {
  node: number;
  /** Distance from the input point to the network, in metres. */
  snapDistance: number;
}

/** A reconstructed route through the network. */
export interface NetworkPath {
  nodes: number[];
  coordinates: Position[];
  cost: number;
  length: number;
}

/** Result of a single-source (or multi-source) search. */
export interface SearchResult {
  dist: Float64Array;
  /** Edge used to reach each node (-1 for sources and unreached nodes). */
  prevEdge: Int32Array;
  /** Previous node on the best path (-1 for sources and unreached nodes). */
  prevNode: Int32Array;
}

const DEG = Math.PI / 180;
/** Signed shortest longitude offset, including the dateline seam. */
function longitudeDelta(from: number, to: number): number {
  if (Math.abs(to - from) <= 180) return to - from;
  return ((((to - from + 180) % 360) + 360) % 360) - 180;
}
/** Metres per degree of latitude on the active body. */
function metersPerDegree(): number {
  return getActiveMeanRadiusMeters() * DEG;
}

/** Great-circle distance between two lon/lat positions, in metres. */
export function haversineMeters(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * getActiveMeanRadiusMeters() * Math.asin(Math.min(1, Math.sqrt(h)));
}

const FORWARD_VALUES = new Set(["yes", "true", "1", "ft", "forward", "fwd", "oneway"]);
const BACKWARD_VALUES = new Set(["-1", "tf", "reverse", "backward", "back"]);
const CLOSED_VALUES = new Set(["n", "closed", "none", "no_travel"]);

/**
 * Maps a one-way attribute value to a travel direction. Accepts the common
 * conventions: OSM `oneway` (`yes`/`1`/`true`, `-1`/`reverse`, `no`) and
 * Esri `FT`/`TF`/`B`/`N`. Anything else (including empty) is two-way.
 *
 * @param value - Raw attribute value.
 * @returns The travel direction relative to the digitized order.
 */
export function parseDirection(value: unknown): NetworkDirection {
  if (value === null || value === undefined) return "both";
  if (typeof value === "boolean") return value ? "forward" : "both";
  const text = String(value).trim().toLowerCase();
  if (FORWARD_VALUES.has(text)) return "forward";
  if (BACKWARD_VALUES.has(text)) return "backward";
  if (CLOSED_VALUES.has(text)) return "closed";
  return "both";
}

/** Union-find over node ids, used to merge snapped endpoints. */
class UnionFind {
  private parent: number[] = [];
  add(): number {
    this.parent.push(this.parent.length);
    return this.parent.length - 1;
  }
  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[x] !== root) {
      const next = this.parent[x];
      this.parent[x] = root;
      x = next;
    }
    return root;
  }
  /** Merges `x` into `into`, keeping `into`'s root as the representative. */
  union(x: number, into: number): void {
    const rx = this.find(x);
    const ri = this.find(into);
    if (rx !== ri) this.parent[rx] = ri;
  }
}

/** Min binary heap of (priority, node) pairs with lazy deletion. */
class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size(): number {
    return this.keys.length;
  }
  push(key: number, val: number): void {
    const keys = this.keys;
    const vals = this.vals;
    let i = keys.length;
    keys.push(key);
    vals.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = key;
    vals[i] = val;
  }
  pop(): [number, number] | undefined {
    const keys = this.keys;
    const vals = this.vals;
    if (!keys.length) return undefined;
    const topKey = keys[0];
    const topVal = vals[0];
    const lastKey = keys.pop() as number;
    const lastVal = vals.pop() as number;
    if (keys.length) {
      let i = 0;
      const n = keys.length;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && keys[r] < keys[l] ? r : l;
        if (keys[c] >= lastKey) break;
        keys[i] = keys[c];
        vals[i] = vals[c];
        i = c;
      }
      keys[i] = lastKey;
      vals[i] = lastVal;
    }
    return [topKey, topVal];
  }
}

/**
 * Projects point p onto segment a-b in a local equirectangular frame (x scaled
 * by cos(latitude)), returning the clamped parameter and the distance in
 * degrees of latitude.
 */
function projectOnSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { t: number; distDeg: number } {
  const k = Math.cos(py * DEG);
  const ux = longitudeDelta(ax, bx) * k;
  const uy = by - ay;
  const wx = longitudeDelta(ax, px) * k;
  const wy = py - ay;
  const len2 = ux * ux + uy * uy;
  let t = len2 > 0 ? (wx * ux + wy * uy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = wx - t * ux;
  const dy = wy - t * uy;
  return { t, distDeg: Math.sqrt(dx * dx + dy * dy) };
}

/** A uniform lon/lat grid bucketing ids by the cells their bbox covers. */
class GridIndex {
  private cells = new Map<string, number[]>();
  private boxes = new Map<number, [number, number, number, number]>();
  private overflow = new Set<number>();
  constructor(
    readonly cell: number,
    readonly originX: number,
    readonly originY: number,
  ) {}
  private key(ix: number, iy: number): string {
    return `${ix},${iy}`;
  }
  cellOf(x: number, y: number): [number, number] {
    return [Math.floor((x - this.originX) / this.cell), Math.floor((y - this.originY) / this.cell)];
  }
  insert(id: number, minX: number, minY: number, maxX: number, maxY: number): void {
    this.boxes.set(id, [minX, minY, maxX, maxY]);
    const [x0, y0] = this.cellOf(minX, minY);
    const [x1, y1] = this.cellOf(maxX, maxY);
    if (![x0, y0, x1, y1].every(Number.isSafeInteger) || (x1 - x0 + 1) * (y1 - y0 + 1) > 256) {
      this.overflow.add(id);
      return;
    }
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        const key = this.key(ix, iy);
        const bucket = this.cells.get(key);
        if (bucket) bucket.push(id);
        else this.cells.set(key, [id]);
      }
    }
  }
  /** Ids in the cells covering [minX, maxX] x [minY, maxY] (may repeat). */
  query(minX: number, minY: number, maxX: number, maxY: number, out: number[]): void {
    const [x0, y0] = this.cellOf(minX, minY);
    const [x1, y1] = this.cellOf(maxX, maxY);
    const scan =
      ![x0, y0, x1, y1].every(Number.isSafeInteger) || (x1 - x0 + 1) * (y1 - y0 + 1) > 4096;
    for (const id of scan ? this.boxes.keys() : this.overflow) {
      const box = this.boxes.get(id)!;
      if (box[0] <= maxX && box[2] >= minX && box[1] <= maxY && box[3] >= minY) out.push(id);
    }
    if (scan) return;
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        const bucket = this.cells.get(this.key(ix, iy));
        if (bucket) for (const id of bucket) out.push(id);
      }
    }
  }
  /** Ids in the ring of cells at Chebyshev distance `r` around (cx, cy). */
  ring(cx: number, cy: number, r: number, out: number[]): void {
    for (const id of this.overflow) out.push(id);
    for (let ix = cx - r; ix <= cx + r; ix++) {
      for (let iy = cy - r; iy <= cy + r; iy++) {
        if (r > 0 && Math.abs(ix - cx) !== r && Math.abs(iy - cy) !== r) continue;
        const bucket = this.cells.get(this.key(ix, iy));
        if (bucket) for (const id of bucket) out.push(id);
      }
    }
  }
}

/** Query both longitude representations when a snap window crosses the seam. */
function queryWrapped(
  index: GridIndex,
  x: number,
  y: number,
  padX: number,
  padY: number,
  out: number[],
): void {
  index.query(x - padX, y - padY, x + padX, y + padY, out);
  if (x - padX < -180) index.query(x - padX + 360, y - padY, 180, y + padY, out);
  if (x + padX > 180) index.query(-180, y - padY, x + padX - 360, y + padY, out);
}

/** Result counters from {@link buildLocalNetwork}, for the tool log. */
export interface NetworkBuildStats {
  features: number;
  skippedFeatures: number;
  snappedEndpoints: number;
  splitSegments: number;
}

/**
 * An in-memory routable network. Build one with {@link buildLocalNetwork}.
 * Points are attached with {@link insertPoint}, which splits the nearest edge,
 * so later searches start and end exactly at the projected locations.
 */
export class LocalNetwork {
  readonly lon: number[] = [];
  readonly lat: number[] = [];
  readonly edges: NetworkEdge[] = [];
  readonly adj: number[][] = [];
  /** Smallest finite cost per metre over all edges (the A* heuristic scale). */
  minCostPerMeter = Infinity;
  stats: NetworkBuildStats = {
    features: 0,
    skippedFeatures: 0,
    snappedEndpoints: 0,
    splitSegments: 0,
  };
  private index: GridIndex | null = null;
  private extent = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };

  get nodeCount(): number {
    return this.lon.length;
  }

  /** @internal Adds a node and returns its id. */
  addNode(lon: number, lat: number): number {
    this.lon.push(lon);
    this.lat.push(lat);
    this.adj.push([]);
    if (lon < this.extent.minX) this.extent.minX = lon;
    if (lat < this.extent.minY) this.extent.minY = lat;
    if (lon > this.extent.maxX) this.extent.maxX = lon;
    if (lat > this.extent.maxY) this.extent.maxY = lat;
    return this.lon.length - 1;
  }

  /** @internal Adds an edge and returns its id. */
  addEdge(edge: NetworkEdge): number {
    const id = this.edges.length;
    this.edges.push(edge);
    this.adj[edge.a].push(id);
    this.adj[edge.b].push(id);
    this.updateHeuristic(edge);
    this.index?.insert(id, ...this.edgeBox(id));
    return id;
  }

  private updateHeuristic(edge: NetworkEdge): void {
    const direct = haversineMeters(
      this.lon[edge.a],
      this.lat[edge.a],
      this.lon[edge.b],
      this.lat[edge.b],
    );
    if (direct > 0) {
      for (const cost of [edge.costAB, edge.costBA]) {
        if (Number.isFinite(cost)) {
          this.minCostPerMeter = Math.min(this.minCostPerMeter, cost / direct);
        }
      }
    }
  }

  private edgeBox(id: number): [number, number, number, number] {
    const { a, b } = this.edges[id];
    return [
      Math.min(this.lon[a], this.lon[b]),
      Math.min(this.lat[a], this.lat[b]),
      Math.max(this.lon[a], this.lon[b]),
      Math.max(this.lat[a], this.lat[b]),
    ];
  }

  /** @internal Builds the edge spatial index once the edges are in. */
  buildIndex(): void {
    this.minCostPerMeter = Infinity;
    for (const edge of this.edges) this.updateHeuristic(edge);
    const { minX, minY, maxX, maxY } = this.extent;
    let total = 0;
    for (const edge of this.edges) {
      total += Math.max(
        Math.abs(this.lon[edge.a] - this.lon[edge.b]),
        Math.abs(this.lat[edge.a] - this.lat[edge.b]),
      );
    }
    const mean = this.edges.length ? total / this.edges.length : 0;
    const span = Math.max(maxX - minX, maxY - minY, 1e-9);
    // About two mean segments per cell, bounded so the grid stays sane.
    const cell = Math.min(span, Math.max(mean * 2, span / 512, 1e-9));
    this.index = new GridIndex(
      cell,
      Number.isFinite(minX) ? minX : 0,
      Number.isFinite(minY) ? minY : 0,
    );
    for (let id = 0; id < this.edges.length; id++) this.index.insert(id, ...this.edgeBox(id));
  }

  /**
   * Finds the closest edge to a point.
   *
   * @param lon - Longitude of the point.
   * @param lat - Latitude of the point.
   * @returns The edge id, the clamped position along it (0 at `a`, 1 at `b`),
   *   and the distance in metres, or null when the network has no edges.
   */
  nearestEdge(lon: number, lat: number): { edge: number; t: number; distance: number } | null {
    if (!this.index || !this.edges.length) return null;
    const index = this.index;
    const [cx, cy] = index.cellOf(lon, lat);
    const { minX, minY, maxX, maxY } = this.extent;
    const [ex0, ey0] = index.cellOf(minX, minY);
    const [ex1, ey1] = index.cellOf(maxX, maxY);
    const maxRing =
      Math.max(Math.abs(cx - ex0), Math.abs(cx - ex1), Math.abs(cy - ey0), Math.abs(cy - ey1)) + 1;
    // A ring r away is at least (r - 1) cells away in both axes; longitude
    // cells shrink by cos(lat) in the local frame used for distances.
    const cellReach = index.cell * Math.max(Math.cos(lat * DEG), 1e-6);
    let best: { edge: number; t: number; distDeg: number } | null = null;
    const seen = new Set<number>();
    const candidates: number[] = [];
    for (let r = 0; r <= Math.min(maxRing, 32); r++) {
      if (best && best.distDeg < (r - 1) * cellReach) break;
      candidates.length = 0;
      index.ring(cx, cy, r, candidates);
      for (const id of candidates) {
        if (seen.has(id)) continue;
        seen.add(id);
        const { a, b } = this.edges[id];
        const hit = projectOnSegment(lon, lat, this.lon[a], this.lat[a], this.lon[b], this.lat[b]);
        if (!best || hit.distDeg < best.distDeg)
          best = { edge: id, t: hit.t, distDeg: hit.distDeg };
      }
    }
    // Bound empty-ring work. Distant points and seam-adjacent queries use
    // one edge scan instead of walking arbitrarily many empty cells.
    if (!best || best.distDeg >= 30 * cellReach || Math.abs(lon) > 170 || maxX - minX > 180) {
      for (let id = 0; id < this.edges.length; id++) {
        const { a, b } = this.edges[id];
        const hit = projectOnSegment(lon, lat, this.lon[a], this.lat[a], this.lon[b], this.lat[b]);
        if (!best || hit.distDeg < best.distDeg)
          best = { edge: id, t: hit.t, distDeg: hit.distDeg };
      }
    }
    if (!best) return null;
    const { a, b } = this.edges[best.edge];
    const px = this.lon[a] + best.t * longitudeDelta(this.lon[a], this.lon[b]);
    const py = this.lat[a] + best.t * (this.lat[b] - this.lat[a]);
    return { edge: best.edge, t: best.t, distance: haversineMeters(lon, lat, px, py) };
  }

  /**
   * Splits edge `id` at parameter `t` with a new node and returns that node.
   * Costs and length are apportioned linearly.
   */
  splitEdge(id: number, t: number): number {
    const edge = this.edges[id];
    const lon = longitudeDelta(
      0,
      this.lon[edge.a] + t * longitudeDelta(this.lon[edge.a], this.lon[edge.b]),
    );
    const lat = this.lat[edge.a] + t * (this.lat[edge.b] - this.lat[edge.a]);
    return this.splitEdgeAt(id, t, this.addNode(lon, lat));
  }

  /** Splits edge `id` at parameter `t` through an existing node. */
  private splitEdgeAt(id: number, t: number, node: number): number {
    const edge = this.edges[id];
    const tail: NetworkEdge = {
      a: node,
      b: edge.b,
      costAB: edge.costAB * (1 - t),
      costBA: edge.costBA * (1 - t),
      length: edge.length * (1 - t),
      feature: edge.feature,
    };
    // Re-point the far end's adjacency from the old edge to the new tail.
    const farAdj = this.adj[edge.b];
    const at = farAdj.indexOf(id);
    if (at >= 0) farAdj.splice(at, 1);
    edge.b = node;
    edge.costAB *= t;
    edge.costBA *= t;
    edge.length *= t;
    this.updateHeuristic(edge);
    this.adj[node].push(id);
    this.addEdge(tail);
    return node;
  }

  /**
   * Attaches a point to the network at the closest location on the closest
   * edge, splitting that edge unless the point projects onto a node.
   *
   * @param lon - Longitude of the point.
   * @param lat - Latitude of the point.
   * @returns The node now representing the point, or null for an empty network.
   */
  insertPoint(lon: number, lat: number): SnappedPoint | null {
    const hit = this.nearestEdge(lon, lat);
    if (!hit) return null;
    const edge = this.edges[hit.edge];
    // Within a millimetre of an end, reuse the existing node.
    const eps = edge.length > 0 ? 0.001 / edge.length : 1;
    if (hit.t <= eps) return { node: edge.a, snapDistance: hit.distance };
    if (hit.t >= 1 - eps) return { node: edge.b, snapDistance: hit.distance };
    return { node: this.splitEdge(hit.edge, hit.t), snapDistance: hit.distance };
  }

  /** The node at the other end of `edge` from `node`, with the travel cost. */
  private step(edgeId: number, node: number, reverse: boolean): [number, number] {
    const edge = this.edges[edgeId];
    if (edge.a === node) return [edge.b, reverse ? edge.costBA : edge.costAB];
    return [edge.a, reverse ? edge.costAB : edge.costBA];
  }

  /**
   * Dijkstra (or A* when `target` is given and `astar` is true) from one or
   * more sources.
   *
   * @param sources - Start nodes (cost 0).
   * @param options.target - Stop once this node is settled.
   * @param options.astar - Use the haversine A* heuristic toward `target`.
   * @param options.maxCost - Do not expand past this cost.
   * @param options.reverse - Follow edges against their allowed direction,
   *   which gives costs *to* the sources rather than from them.
   * @param options.onSettle - Called per settled node; return true to stop.
   * @returns Distances and predecessor links.
   */
  search(
    sources: number[],
    options: {
      target?: number;
      astar?: boolean;
      maxCost?: number;
      reverse?: boolean;
      onSettle?: (node: number, cost: number) => boolean | void;
    } = {},
  ): SearchResult {
    const n = this.nodeCount;
    const dist = new Float64Array(n).fill(Infinity);
    const prevEdge = new Int32Array(n).fill(-1);
    const prevNode = new Int32Array(n).fill(-1);
    const settled = new Uint8Array(n);
    const heap = new MinHeap();
    const maxCost = options.maxCost ?? Infinity;
    const target = options.target;
    const useHeuristic =
      options.astar === true &&
      target !== undefined &&
      Number.isFinite(this.minCostPerMeter) &&
      this.minCostPerMeter > 0;
    const tLon = target !== undefined ? this.lon[target] : 0;
    const tLat = target !== undefined ? this.lat[target] : 0;
    const h = (node: number): number =>
      useHeuristic
        ? haversineMeters(this.lon[node], this.lat[node], tLon, tLat) * this.minCostPerMeter
        : 0;
    for (const s of sources) {
      if (dist[s] === 0) continue;
      dist[s] = 0;
      heap.push(h(s), s);
    }
    while (heap.size) {
      const [, u] = heap.pop() as [number, number];
      if (settled[u]) continue;
      settled[u] = 1;
      if (options.onSettle?.(u, dist[u])) break;
      if (u === target) break;
      for (const e of this.adj[u]) {
        const [v, cost] = this.step(e, u, options.reverse === true);
        if (!Number.isFinite(cost) || settled[v]) continue;
        const nd = dist[u] + cost;
        if (nd > maxCost) continue;
        if (nd < dist[v]) {
          dist[v] = nd;
          prevEdge[v] = e;
          prevNode[v] = u;
          heap.push(nd + h(v), v);
        }
      }
    }
    return { dist, prevEdge, prevNode };
  }

  /**
   * Walks predecessor links back from `target`.
   *
   * @returns The path from the search source to `target`, or null if unreached.
   */
  pathTo(result: SearchResult, target: number): NetworkPath | null {
    if (!Number.isFinite(result.dist[target])) return null;
    const nodes: number[] = [target];
    let length = 0;
    let cur = target;
    while (result.prevNode[cur] >= 0) {
      length += this.edges[result.prevEdge[cur]].length;
      cur = result.prevNode[cur];
      nodes.push(cur);
    }
    nodes.reverse();
    return {
      nodes,
      coordinates: nodes.map((node) => [this.lon[node], this.lat[node]]),
      cost: result.dist[target],
      length,
    };
  }

  /**
   * Shortest path between two nodes.
   *
   * @param from - Start node.
   * @param to - End node.
   * @param astar - Use A* (same optimum as Dijkstra, fewer nodes settled).
   * @returns The path, or null when `to` is unreachable.
   */
  shortestPath(from: number, to: number, astar = true): NetworkPath | null {
    return this.pathTo(this.search([from], { target: to, astar }), to);
  }

  /**
   * Portions of every edge reachable within `maxCost` of the sources, given a
   * finished search. Each piece is a straight sub-segment.
   *
   * @param result - A search from the service-area facilities.
   * @param maxCost - The break value.
   * @param reverse - Whether the search ran with `reverse` (travel toward the
   *   facilities), which flips which edge cost applies from each end.
   * @returns Line pieces as coordinate pairs.
   */
  reachableSegments(result: SearchResult, maxCost: number, reverse = false): Position[][] {
    const pieces: Position[][] = [];
    const lerp = (edge: NetworkEdge, t: number): Position => [
      longitudeDelta(0, this.lon[edge.a] + t * longitudeDelta(this.lon[edge.a], this.lon[edge.b])),
      this.lat[edge.a] + t * (this.lat[edge.b] - this.lat[edge.a]),
    ];
    const reach = (start: number, cost: number): number => {
      if (!Number.isFinite(start) || start > maxCost) return 0;
      if (!Number.isFinite(cost)) return 0;
      if (cost <= 0) return 1;
      return Math.min(1, (maxCost - start) / cost);
    };
    for (const edge of this.edges) {
      // Costs of leaving each end: a toward b and b toward a.
      const fromA = reach(result.dist[edge.a], reverse ? edge.costBA : edge.costAB);
      const fromB = reach(result.dist[edge.b], reverse ? edge.costAB : edge.costBA);
      if (fromA + fromB >= 1) {
        pieces.push([lerp(edge, 0), lerp(edge, 1)]);
        continue;
      }
      if (fromA > 0) pieces.push([lerp(edge, 0), lerp(edge, fromA)]);
      if (fromB > 0) pieces.push([lerp(edge, 1 - fromB), lerp(edge, 1)]);
    }
    return pieces;
  }
}

function numeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Splits a feature's geometry into its line parts, dropping repeated vertices. */
function lineParts(feature: Feature): Position[][] {
  const geometry = feature.geometry;
  if (!geometry) return [];
  const raw =
    geometry.type === "LineString"
      ? [(geometry as LineString).coordinates]
      : geometry.type === "MultiLineString"
        ? (geometry as MultiLineString).coordinates
        : [];
  const parts: Position[][] = [];
  for (const line of raw) {
    if (!Array.isArray(line)) continue;
    const clean: Position[] = [];
    for (const pos of line) {
      if (!Array.isArray(pos) || !Number.isFinite(pos[0]) || !Number.isFinite(pos[1])) continue;
      const last = clean[clean.length - 1];
      if (last && last[0] === pos[0] && last[1] === pos[1]) continue;
      clean.push(pos);
    }
    if (clean.length >= 2) parts.push(clean);
  }
  return parts;
}

interface RawSegment {
  a: number;
  b: number;
  feature: number;
  /** Cost per metre, travel allowed in digitized order. */
  rateAB: number;
  /** Cost per metre, travel allowed against digitized order. */
  rateBA: number;
}

/**
 * Builds a routable network from line features.
 *
 * @param features - LineString / MultiLineString features (others are skipped).
 * @param options - Cost, direction, and snapping options.
 * @returns The network, with build counters in `stats`.
 */
export function buildLocalNetwork(
  features: Feature[],
  options: LocalNetworkOptions = {},
): LocalNetwork {
  const costMode = options.costMode ?? "length";
  const tolerance = Math.max(0, options.snapToleranceM ?? 0);
  const net = new LocalNetwork();
  const uf = new UnionFind();
  const nodeByKey = new Map<string, number>();
  const rawLon: number[] = [];
  const rawLat: number[] = [];
  const segments: RawSegment[] = [];
  /** Endpoint node ids with the ids of their neighbor vertex on the same part. */
  const endpoints: { node: number; neighbor: number }[] = [];
  const stats: NetworkBuildStats = {
    features: 0,
    skippedFeatures: 0,
    snappedEndpoints: 0,
    splitSegments: 0,
  };

  const vertexNode = (pos: Position): number => {
    const key = `${pos[0]},${pos[1]}`;
    let id = nodeByKey.get(key);
    if (id === undefined) {
      id = uf.add();
      rawLon.push(pos[0]);
      rawLat.push(pos[1]);
      nodeByKey.set(key, id);
    }
    return id;
  };

  features.forEach((feature, featureIndex) => {
    const parts = lineParts(feature);
    if (!parts.length) return;
    let featureLength = 0;
    for (const part of parts) {
      for (let i = 1; i < part.length; i++) {
        featureLength += haversineMeters(part[i - 1][0], part[i - 1][1], part[i][0], part[i][1]);
      }
    }
    const props = feature.properties ?? {};
    let rate = 1;
    if (costMode === "field") {
      const total = numeric(options.costField ? props[options.costField] : null);
      if (total === null || total < 0 || !(featureLength > 0)) {
        stats.skippedFeatures++;
        return;
      }
      rate = total / featureLength;
    } else if (costMode === "speed") {
      const speed = numeric(options.costField ? props[options.costField] : null);
      if (speed === null || !(speed > 0)) {
        stats.skippedFeatures++;
        return;
      }
      // Minutes per metre at `speed` km/h.
      rate = 60 / (speed * 1000);
    }
    const direction = options.directionField
      ? parseDirection(props[options.directionField])
      : "both";
    if (direction === "closed") {
      stats.skippedFeatures++;
      return;
    }
    stats.features++;
    const rateAB = direction === "backward" ? Infinity : rate;
    const rateBA = direction === "forward" ? Infinity : rate;
    for (const part of parts) {
      const ids = part.map(vertexNode);
      for (let i = 1; i < ids.length; i++) {
        segments.push({ a: ids[i - 1], b: ids[i], feature: featureIndex, rateAB, rateBA });
      }
      endpoints.push({ node: ids[0], neighbor: ids[1] });
      endpoints.push({ node: ids[ids.length - 1], neighbor: ids[ids.length - 2] });
    }
  });

  const toleranceDeg = tolerance / metersPerDegree();
  /** Raw vertex ids that a dangling endpoint should split a segment at. */
  const splits = new Map<number, { t: number; node: number }[]>();

  if (toleranceDeg > 0 && rawLon.length) {
    // Node-to-node: snap each endpoint onto the nearest other vertex in range.
    const minLon = rawLon.reduce((min, value) => Math.min(min, value), Infinity);
    const minLat = rawLat.reduce((min, value) => Math.min(min, value), Infinity);
    const nodeIndex = new GridIndex(toleranceDeg, minLon, minLat);
    for (let id = 0; id < rawLon.length; id++) {
      nodeIndex.insert(id, rawLon[id], rawLat[id], rawLon[id], rawLat[id]);
    }
    const near: number[] = [];
    for (const { node, neighbor } of endpoints) {
      near.length = 0;
      const x = rawLon[node];
      const y = rawLat[node];
      const padX = toleranceDeg / Math.max(Math.cos(y * DEG), 1e-6);
      queryWrapped(nodeIndex, x, y, padX, toleranceDeg, near);
      let best = -1;
      let bestD = Infinity;
      for (const other of near) {
        if (other === node || other === neighbor) continue;
        if (uf.find(other) === uf.find(node)) continue;
        const d = haversineMeters(x, y, rawLon[other], rawLat[other]);
        if (d <= tolerance && d < bestD) {
          bestD = d;
          best = other;
        }
      }
      if (best >= 0) {
        uf.union(node, best);
        stats.snappedEndpoints++;
      }
    }

    // Node-to-segment: a still-dangling endpoint near another segment splits it.
    const degree = new Map<number, number>();
    for (const seg of segments) {
      const a = uf.find(seg.a);
      const b = uf.find(seg.b);
      if (a === b) continue;
      degree.set(a, (degree.get(a) ?? 0) + 1);
      degree.set(b, (degree.get(b) ?? 0) + 1);
    }
    const segIndex = new GridIndex(Math.max(toleranceDeg * 4, 1e-7), minLon, minLat);
    segments.forEach((seg, id) => {
      const ax = rawLon[uf.find(seg.a)];
      const ay = rawLat[uf.find(seg.a)];
      const bx = rawLon[uf.find(seg.b)];
      const by = rawLat[uf.find(seg.b)];
      const seam = Math.abs(bx - ax) > 180;
      segIndex.insert(
        id,
        seam ? -180 : Math.min(ax, bx),
        Math.min(ay, by),
        seam ? 180 : Math.max(ax, bx),
        Math.max(ay, by),
      );
    });
    const candidates: number[] = [];
    const handled = new Set<number>();
    for (const { node } of endpoints) {
      const root = uf.find(node);
      if ((degree.get(root) ?? 0) !== 1 || handled.has(root)) continue;
      handled.add(root);
      const x = rawLon[root];
      const y = rawLat[root];
      candidates.length = 0;
      const padX = toleranceDeg / Math.max(Math.cos(y * DEG), 1e-6);
      queryWrapped(segIndex, x, y, padX, toleranceDeg, candidates);
      let best: { seg: number; t: number; d: number } | null = null;
      for (const segId of new Set(candidates)) {
        const seg = segments[segId];
        const sa = uf.find(seg.a);
        const sb = uf.find(seg.b);
        if (sa === root || sb === root) continue;
        const hit = projectOnSegment(x, y, rawLon[sa], rawLat[sa], rawLon[sb], rawLat[sb]);
        if (hit.t <= 0 || hit.t >= 1) continue;
        const px = rawLon[sa] + hit.t * longitudeDelta(rawLon[sa], rawLon[sb]);
        const py = rawLat[sa] + hit.t * (rawLat[sb] - rawLat[sa]);
        const d = haversineMeters(x, y, px, py);
        if (d <= tolerance && (!best || d < best.d)) best = { seg: segId, t: hit.t, d };
      }
      if (best) {
        const list = splits.get(best.seg) ?? [];
        list.push({ t: best.t, node: root });
        splits.set(best.seg, list);
        stats.splitSegments++;
      }
    }
  }

  // Materialize representative nodes, then edges (splitting where recorded).
  const finalId = new Map<number, number>();
  const nodeFor = (raw: number): number => {
    const root = uf.find(raw);
    let id = finalId.get(root);
    if (id === undefined) {
      id = net.addNode(rawLon[root], rawLat[root]);
      finalId.set(root, id);
    }
    return id;
  };
  const pushEdge = (a: number, b: number, seg: RawSegment): void => {
    if (a === b) return;
    const length = haversineMeters(net.lon[a], net.lat[a], net.lon[b], net.lat[b]);
    net.addEdge({
      a,
      b,
      costAB: Number.isFinite(seg.rateAB) ? seg.rateAB * length : Infinity,
      costBA: Number.isFinite(seg.rateBA) ? seg.rateBA * length : Infinity,
      length,
      feature: seg.feature,
    });
  };
  segments.forEach((seg, id) => {
    const chain = [nodeFor(seg.a)];
    const cuts = splits.get(id);
    if (cuts) {
      cuts.sort((p, q) => p.t - q.t);
      for (const cut of cuts) chain.push(nodeFor(cut.node));
    }
    chain.push(nodeFor(seg.b));
    for (let i = 1; i < chain.length; i++) pushEdge(chain[i - 1], chain[i], seg);
  });
  if (costMode === "field") {
    // Topology can move endpoints. Preserve each declared feature total
    // across its surviving pieces after all snapping and splits are final.
    const lengths = new Map<number, number>();
    for (const edge of net.edges)
      lengths.set(edge.feature, (lengths.get(edge.feature) ?? 0) + edge.length);
    for (const edge of net.edges) {
      const total = numeric(features[edge.feature].properties?.[options.costField ?? ""]);
      const length = lengths.get(edge.feature)!;
      const cost = total !== null && length > 0 ? (total * edge.length) / length : 0;
      if (Number.isFinite(edge.costAB)) edge.costAB = cost;
      if (Number.isFinite(edge.costBA)) edge.costBA = cost;
    }
  }
  net.stats = stats;
  net.buildIndex();
  return net;
}
