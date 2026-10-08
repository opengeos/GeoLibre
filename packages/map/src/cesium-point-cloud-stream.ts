import { getVectorColorRamp } from "@geolibre/core";
import type { CesiumWidget, PointPrimitive, PointPrimitiveCollection } from "@cesium/engine";
import {
  POINT_CLOUD_PIXEL_SIZE,
  pointCloudColor,
  type DecodedPointCloud,
  type EptSource,
} from "./cesium-point-cloud";

// View-dependent streaming of an octree point cloud on the globe (issue #2261).
//
// A one-shot preview samples the whole cloud from the top of its octree, which
// is fine for a city block but leaves a county-scale dataset (USGS 3DEP EPT
// runs to tens of billions of points) nearly empty once zoomed in. The
// streamer instead keeps the octree nodes that intersect the camera's view, at
// a depth whose point spacing matches the screen, and refreshes the selection
// whenever the camera settles. The root node always stays, so the cloud's
// outline is visible from any distance; finer nodes come and go with the view.
//
// Decoded nodes are cached (bounded by point count), so panning back and forth
// does not refetch, and primitives are added and removed per node rather than
// rebuilding the whole collection.

type CesiumNs = typeof import("@cesium/engine");

/** The octree a streamer reads; an {@link EptSource} satisfies it. */
export type OctreeSource = Pick<
  EptSource,
  "cube" | "span" | "project" | "counts" | "loadSubtree" | "loadNode"
>;

/** Points expected in view the streamer aims for. */
export const STREAM_VIEW_BUDGET = 600_000;

/** Points held as primitives at once, in view or not (each is a JS object). */
export const STREAM_MAX_SHOWN_POINTS = 1_500_000;

/** Decoded points kept for nodes no longer shown, so a pan back is free. */
const STREAM_CACHE_POINTS = 3_000_000;

/** Screen pixels a node's point spacing may cover before its children are wanted. */
const SPACING_PIXELS = 2;

/** Nodes fetched at once. */
const STREAM_CONCURRENCY = 4;

/** Camera settle time before a refresh, so a fling does not fetch every frame. */
const REFRESH_DELAY_MS = 250;

/** Subtree files read per refresh pass before the selection is recomputed. */
const MAX_SUBTREE_ROUNDS = 6;

const ROOT = "0-0-0-0";

/** `[minX, minY, maxX, maxY]` in the source CRS. */
export type SourceBox = [number, number, number, number];

/** What the camera sees, in source CRS terms. */
export interface StreamView {
  /** The view's footprint in the source CRS, or null when it cannot be computed. */
  box: SourceBox | null;
  /** Ground size of one screen pixel at the centre of view, in source units. */
  unitsPerPixel: number;
  /**
   * The camera's position in the source CRS (height in source units) and the
   * angle one pixel subtends, when known. A node's needed detail then follows
   * its own distance from the camera, so a tilted view loads the ground
   * underfoot finer than the horizon.
   */
  camera?: { x: number; y: number; height: number; pixelAngle: number };
}

/** Ground size of one pixel at a node, in source units. */
function nodeUnitsPerPixel(view: StreamView, box: SourceBox): number {
  const camera = view.camera;
  if (!camera) return view.unitsPerPixel;
  const dx = Math.max(box[0] - camera.x, 0, camera.x - box[2]);
  const dy = Math.max(box[1] - camera.y, 0, camera.y - box[3]);
  const distance = Math.hypot(dx, dy, camera.height);
  return distance * camera.pixelAngle;
}

/** Lets the browser paint and handle input between long synchronous steps. */
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A node's XY footprint in the source CRS, from the octree cube and its key. */
export function nodeBox(cube: OctreeSource["cube"], key: string): SourceBox {
  const [depth, x, y] = key.split("-").map(Number);
  const size = 2 ** depth;
  const width = (cube[3] - cube[0]) / size;
  const height = (cube[4] - cube[1]) / size;
  const minX = cube[0] + x * width;
  const minY = cube[1] + y * height;
  return [minX, minY, minX + width, minY + height];
}

/** The eight children of an octree key. */
function children(key: string): string[] {
  const [d, x, y, z] = key.split("-").map(Number);
  const out: string[] = [];
  for (let dx = 0; dx < 2; dx++)
    for (let dy = 0; dy < 2; dy++)
      for (let dz = 0; dz < 2; dz++) out.push(`${d + 1}-${2 * x + dx}-${2 * y + dy}-${2 * z + dz}`);
  return out;
}

/** Fraction of `a` covered by `b`, 0 when they do not intersect. */
function overlap(a: SourceBox, b: SourceBox): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const area = (a[2] - a[0]) * (a[3] - a[1]);
  return area > 0 ? (w * h) / area : 0;
}

/** The result of {@link selectOctreeNodes}. */
export interface OctreeSelection {
  /** Nodes to show, coarsest first. */
  keys: string[];
  /** Subtrees the walk reached whose counts are not read yet. */
  pendingSubtrees: string[];
}

/**
 * Choose the octree nodes to show for a view: breadth-first from the root,
 * keeping nodes that intersect the view and descending while a node's point
 * spacing is coarser than the screen resolution, until the in-view point
 * estimate (each node's count scaled by the share of it in view) reaches the
 * budget or the shown total reaches its cap. The root is always kept, so the
 * whole cloud has an outline; with no view only the root is chosen.
 *
 * @param source - The octree (cube, span, known counts).
 * @param view - The view in source CRS terms.
 * @param budget - In-view points to aim for.
 * @param maxShown - Total points (whole nodes) to hold at most.
 * @returns The chosen keys and the subtrees still to read.
 */
export function selectOctreeNodes(
  source: Pick<OctreeSource, "cube" | "span" | "counts">,
  view: StreamView,
  budget = STREAM_VIEW_BUDGET,
  maxShown = STREAM_MAX_SHOWN_POINTS,
): OctreeSelection {
  const keys: string[] = [];
  const pendingSubtrees: string[] = [];
  const cubeWidth = source.cube[3] - source.cube[0];
  // How coarse a node looks on screen: its point spacing over the ground size
  // of a pixel there, in units of SPACING_PIXELS. Above 1 it wants refining.
  const error = (key: string, box: SourceBox) => {
    const depth = Number(key.split("-")[0]);
    const spacing = cubeWidth / 2 ** depth / source.span;
    return spacing / (nodeUnitsPerPixel(view, box) * SPACING_PIXELS);
  };
  let inView = 0;
  let shown = 0;
  // Most-needed first: the coarsest-looking node is refined next, so a
  // tilted view spends the budget on the ground near the camera before the
  // horizon. A node is only queued once its parent has been visited, so
  // parents still precede their children in the result.
  const queue: { key: string; error: number }[] = [{ key: ROOT, error: Number.POSITIVE_INFINITY }];
  while (queue.length) {
    let best = 0;
    for (let i = 1; i < queue.length; i++) if (queue[i].error > queue[best].error) best = i;
    const { key } = queue.splice(best, 1)[0];
    const count = source.counts.get(key);
    if (count === undefined) continue;
    const isRoot = key === ROOT;
    const box = nodeBox(source.cube, key);
    const share = view.box ? overlap(box, view.box) : isRoot ? 1 : 0;
    // Out of view first: an unread subtree off screen must not cost a
    // hierarchy download, nor one of the refresh's subtree rounds.
    if (!isRoot && share === 0) continue;
    if (count === -1) {
      pendingSubtrees.push(key);
      continue;
    }
    if (count > 0) {
      const estimate = count * share;
      if (!isRoot && (inView + estimate > budget || shown + count > maxShown)) continue;
      keys.push(key);
      inView += estimate;
      shown += count;
    }
    if (!view.box || error(key, box) <= 1) continue;
    for (const child of children(key)) {
      const childBox = nodeBox(source.cube, child);
      // Out-of-view children never enter the queue, which keeps its linear
      // scan short on a deep, dense tree.
      if (overlap(childBox, view.box) === 0) continue;
      queue.push({ key: child, error: error(child, childBox) });
    }
  }
  return { keys, pendingSubtrees };
}

/** Options for a {@link PointCloudStreamer}. */
export interface PointCloudStreamerOptions {
  /** The layer's current effective opacity, read when points are created. */
  opacity: () => number;
  /** Metres added to every point's height. */
  altitudeOffset?: number;
  /** Reports a load failure (the first node that fails, or the root). */
  onError?: (message: string) => void;
}

/**
 * Streams an octree point cloud into one `PointPrimitiveCollection`, keeping
 * the nodes the camera needs. Call {@link start} once, {@link destroy} when the
 * layer goes.
 */
export class PointCloudStreamer {
  readonly collection: PointPrimitiveCollection;
  private readonly shown = new Map<string, PointPrimitive[]>();
  private readonly cache = new Map<string, DecodedPointCloud>();
  private cachedPoints = 0;
  private readonly inflight = new Map<string, Promise<DecodedPointCloud>>();
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly abort = new AbortController();
  private removeListener: (() => void) | null = null;
  private zRange: { zMin: number; zMax: number } | null = null;
  /** Whether {@link zRange} came from the root rather than a fallback node. */
  private rootRange = false;
  private readonly ramp = getVectorColorRamp("viridis").colors;
  private destroyed = false;
  /** The nodes the newest refresh selected, which {@link trim} keeps. */
  private latest = new Set<string>();

  constructor(
    private readonly Cesium: CesiumNs,
    private readonly viewer: CesiumWidget,
    private readonly source: OctreeSource,
    private readonly options: PointCloudStreamerOptions,
  ) {
    this.collection = new Cesium.PointPrimitiveCollection();
  }

  /** Loads the first selection and starts following the camera. */
  async start(): Promise<void> {
    const camera = this.viewer.camera as unknown as {
      moveEnd?: {
        addEventListener(fn: () => void): unknown;
        removeEventListener(fn: () => void): unknown;
      };
    };
    const onMoveEnd = () => this.schedule();
    camera.moveEnd?.addEventListener(onMoveEnd);
    this.removeListener = () => camera.moveEnd?.removeEventListener(onMoveEnd);
    await this.refresh();
  }

  /** Points currently held as primitives. */
  get pointCount(): number {
    return this.collection.length;
  }

  /** Keys of the nodes currently shown (for tests and diagnostics). */
  get shownKeys(): string[] {
    return [...this.shown.keys()];
  }

  private schedule(): void {
    if (this.destroyed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh().catch((error) => {
        // A failed subtree read would otherwise leave the view stuck at a
        // coarse level with nothing said; destroy()'s abort is not a failure.
        if (this.destroyed) return;
        this.options.onError?.(error instanceof Error ? error.message : String(error));
      });
    }, REFRESH_DELAY_MS);
  }

  /** The camera's view in source CRS terms. */
  view(): StreamView {
    const { Cesium, viewer, source } = this;
    const inverse = source.project.inverse;
    const unitMetres = source.project.metresPerUnit ?? 1;
    const camera = viewer.camera;
    const canvasHeight = viewer.scene.canvas.clientHeight || 1;
    const rect = camera.computeViewRectangle?.(viewer.scene.globe?.ellipsoid);
    const height = camera.positionCartographic?.height ?? Number.POSITIVE_INFINITY;
    const fovy = (camera.frustum as { fovy?: number } | undefined)?.fovy ?? Math.PI / 3;
    // Looking obliquely, the ground at the centre of view is further than the
    // camera's height; a floor on the sine keeps a horizon view finite.
    const sinPitch = Math.max(Math.abs(Math.sin(camera.pitch ?? -Math.PI / 2)), 0.3);
    const metresPerPixel = (((2 * height) / sinPitch) * Math.tan(fovy / 2)) / canvasHeight;
    if (!rect || !inverse || !Number.isFinite(metresPerPixel)) {
      return { box: null, unitsPerPixel: Number.POSITIVE_INFINITY };
    }
    const toDeg = Cesium.Math.toDegrees;
    const [west, south, east, north] = [rect.west, rect.south, rect.east, rect.north].map(toDeg);
    // A view across the antimeridian or the whole globe has no useful box.
    if (east <= west || east - west > 90)
      return { box: null, unitsPerPixel: Number.POSITIVE_INFINITY };
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    // Projections bend straight lines, so sample a grid, not just the corners.
    for (let i = 0; i <= 4; i++) {
      for (let j = 0; j <= 4; j++) {
        const [x, y] = inverse(west + ((east - west) * i) / 4, south + ((north - south) * j) / 4);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    if (!Number.isFinite(minX)) return { box: null, unitsPerPixel: Number.POSITIVE_INFINITY };
    const position = camera.positionCartographic;
    if (!position) return { box: null, unitsPerPixel: Number.POSITIVE_INFINITY };
    const [cx, cy] = inverse(toDeg(position.longitude), toDeg(position.latitude));
    const pixelAngle = (2 * Math.tan(fovy / 2)) / canvasHeight;
    return {
      box: [minX, minY, maxX, maxY],
      unitsPerPixel: metresPerPixel / unitMetres,
      ...(Number.isFinite(cx) && Number.isFinite(cy)
        ? { camera: { x: cx, y: cy, height: Math.max(height, 1) / unitMetres, pixelAngle } }
        : {}),
    };
  }

  /** Recompute the selection for the current view and reconcile the primitives. */
  async refresh(): Promise<void> {
    if (this.destroyed) return;
    const generation = ++this.generation;
    const signal = this.abort.signal;
    const view = this.view();
    let selection = selectOctreeNodes(this.source, view);
    // Read the subtree files the walk reached, then walk again with their counts.
    for (let round = 0; round < MAX_SUBTREE_ROUNDS && selection.pendingSubtrees.length; round++) {
      await Promise.all(
        selection.pendingSubtrees.map((key) => this.source.loadSubtree(key, signal)),
      );
      if (this.stale(generation)) return this.trim();
      selection = selectOctreeNodes(this.source, view);
    }
    const wanted = new Set(selection.keys);
    this.latest = wanted;
    const missing = selection.keys.filter((key) => !this.shown.has(key));
    // Fetch coarse to fine and show each batch as it lands, so the view fills
    // in progressively rather than all at once at the end.
    for (let start = 0; start < missing.length; start += STREAM_CONCURRENCY) {
      const batch = missing.slice(start, start + STREAM_CONCURRENCY);
      const nodes = await Promise.all(
        batch.map((key) =>
          this.node(key).catch((error) => {
            if (!this.destroyed)
              this.options.onError?.(error instanceof Error ? error.message : String(error));
            return null;
          }),
        ),
      );
      if (this.stale(generation)) return this.trim();
      for (let i = 0; i < batch.length; i++) {
        const node = nodes[i];
        if (!node || this.shown.has(batch[i])) continue;
        this.show(batch[i], node);
        this.trim();
        this.viewer.scene?.requestRender?.();
        // Creating a node's primitives is synchronous (a position and a
        // colour per point); yield between nodes so a batch of large ones
        // does not hold the main thread for the whole batch.
        await yieldToBrowser();
        if (this.stale(generation)) return this.trim();
      }
      this.viewer.scene?.requestRender?.();
    }
    // Only now drop what the new view no longer needs, so a move never flashes empty.
    for (const key of [...this.shown.keys()]) if (!wanted.has(key)) this.hide(key);
    this.viewer.scene?.requestRender?.();
  }

  /**
   * Keep the primitives under {@link STREAM_MAX_SHOWN_POINTS} while refreshes
   * overtake one another: a refresh only drops old nodes when it completes,
   * so a user panning faster than nodes load would otherwise pile up every
   * partly applied selection. Nodes the newest selection does not want go
   * first, oldest first; what it wants is itself under the cap.
   */
  private trim(): void {
    // After destroy() the entry may already have removed the collection.
    if (this.destroyed || this.collection.length <= STREAM_MAX_SHOWN_POINTS) return;
    for (const key of [...this.shown.keys()]) {
      if (this.collection.length <= STREAM_MAX_SHOWN_POINTS) break;
      if (!this.latest.has(key)) this.hide(key);
    }
  }

  private stale(generation: number): boolean {
    return this.destroyed || generation !== this.generation;
  }

  /** A decoded node, from the cache, an in-flight load, or a fresh one. */
  private node(key: string): Promise<DecodedPointCloud> {
    const cached = this.cache.get(key);
    if (cached) {
      // Refresh its place in the LRU order.
      this.cache.delete(key);
      this.cache.set(key, cached);
      return Promise.resolve(cached);
    }
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.source.loadNode(key, this.abort.signal).then((node) => {
        this.inflight.delete(key);
        this.remember(key, node);
        return node;
      });
      pending.catch(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  private remember(key: string, node: DecodedPointCloud): void {
    this.cache.set(key, node);
    this.cachedPoints += node.count;
    // Evict the least recently used nodes that are not on screen.
    for (const [k, n] of this.cache) {
      if (this.cachedPoints <= STREAM_CACHE_POINTS) break;
      if (this.shown.has(k)) continue;
      this.cache.delete(k);
      this.cachedPoints -= n.count;
    }
  }

  private show(key: string, node: DecodedPointCloud): void {
    const { Cesium } = this;
    // The height ramp spans the root's sample of the whole cloud, so every
    // node colours on one scale and a node's colour never changes as others
    // load. Should the root be empty or fail, the first node shown stands in.
    if (key === ROOT && node.count > 0) {
      const fallback = this.zRange && !this.rootRange;
      this.zRange = { zMin: node.zMin, zMax: node.zMax };
      this.rootRange = true;
      // Nodes shown on a fallback range while the root was failing take
      // the root's scale now, so the whole cloud colours consistently.
      if (fallback) this.recolorShown();
    } else this.zRange ??= { zMin: node.zMin, zMax: node.zMax };
    const ramp = { ...node, ...this.zRange };
    const alpha = Math.min(1, Math.max(0, this.options.opacity()));
    const lift = Number.isFinite(this.options.altitudeOffset)
      ? (this.options.altitudeOffset as number)
      : 0;
    const points: PointPrimitive[] = [];
    for (let i = 0; i < node.count; i++) {
      const [r, g, b] = pointCloudColor(ramp, i, this.ramp);
      points.push(
        this.collection.add({
          position: Cesium.Cartesian3.fromDegrees(
            node.positions[i * 3],
            node.positions[i * 3 + 1],
            node.positions[i * 3 + 2] + lift,
          ),
          pixelSize: POINT_CLOUD_PIXEL_SIZE,
          color: new Cesium.Color(r / 255, g / 255, b / 255, alpha),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        }),
      );
    }
    this.shown.set(key, points);
  }

  /** Re-apply the height ramp to every shown node, keeping each point's alpha. */
  private recolorShown(): void {
    const { Cesium } = this;
    for (const [key, points] of this.shown) {
      const node = this.cache.get(key);
      if (!node || !this.zRange) continue;
      const ramp = { ...node, ...this.zRange };
      points.forEach((point, i) => {
        const [r, g, b] = pointCloudColor(ramp, i, this.ramp);
        point.color = new Cesium.Color(r / 255, g / 255, b / 255, point.color.alpha);
      });
    }
  }

  private hide(key: string): void {
    const points = this.shown.get(key);
    if (!points) return;
    for (const point of points) this.collection.remove(point);
    this.shown.delete(key);
  }

  /** Stops following the camera and cancels pending loads. The collection is the caller's to remove. */
  destroy(): void {
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.removeListener?.();
    this.removeListener = null;
    this.abort.abort();
  }
}
