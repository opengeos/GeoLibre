import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PointCloudStreamer,
  nodeBox,
  selectOctreeNodes,
  type OctreeSource,
  type StreamView,
} from "../packages/map/src/cesium-point-cloud-stream";
import type { DecodedPointCloud } from "../packages/map/src/cesium-point-cloud";

// View-dependent streaming of an EPT octree on the globe (issue #2261). The
// selection is pure; the streamer runs against a fake Cesium namespace and
// viewer, with the octree's nodes decoded from a table.

/** A 1024-unit cube whose root spacing is 1024 / 8 = 128 units. */
const CUBE: OctreeSource["cube"] = [0, 0, 0, 1024, 1024, 1024];

function counts(entries: Record<string, number>): Map<string, number> {
  return new Map(Object.entries(entries));
}

/** Every node of a full octree down to `depth` (z = 0 only), each with `n` points. */
function fullTree(depth: number, n: number): Map<string, number> {
  const map = new Map<string, number>();
  for (let d = 0; d <= depth; d++)
    for (let x = 0; x < 2 ** d; x++)
      for (let y = 0; y < 2 ** d; y++) map.set(`${d}-${x}-${y}-0`, n);
  return map;
}

const view = (box: StreamView["box"], unitsPerPixel: number, camera?: StreamView["camera"]) =>
  ({ box, unitsPerPixel, camera }) as StreamView;

describe("nodeBox", () => {
  it("divides the cube by the key's depth and indices", () => {
    assert.deepEqual(nodeBox(CUBE, "0-0-0-0"), [0, 0, 1024, 1024]);
    assert.deepEqual(nodeBox(CUBE, "1-1-0-0"), [512, 0, 1024, 512]);
    assert.deepEqual(nodeBox(CUBE, "2-3-2-1"), [768, 512, 1024, 768]);
  });
});

describe("selectOctreeNodes", () => {
  const source = { cube: CUBE, span: 8, counts: fullTree(4, 10) };

  it("keeps only the root without a view", () => {
    assert.deepEqual(selectOctreeNodes(source, view(null, 1)).keys, ["0-0-0-0"]);
  });

  it("descends only into nodes the view covers, until spacing meets the screen", () => {
    // A view over the first 100 units; 8 units per pixel stops at depth 3
    // (spacing 1024 / 8 / 8 = 16 = 8 × 2 pixels).
    const { keys } = selectOctreeNodes(source, view([0, 0, 100, 100], 8));
    assert.deepEqual(keys, ["0-0-0-0", "1-0-0-0", "2-0-0-0", "3-0-0-0"]);
  });

  it("stops descending once the in-view estimate reaches the budget", () => {
    const { keys } = selectOctreeNodes(source, view([0, 0, 1024, 1024], 0.01), 25);
    // Root (10) + two depth-1 nodes (20) would pass 25; one fits.
    assert.equal(keys.length, 2);
    assert.equal(keys[0], "0-0-0-0");
  });

  it("refines near the camera before far away when the budget is tight", () => {
    // Camera low over the left edge: left nodes are close, right ones far.
    const camera = { x: 0, y: 512, height: 10, pixelAngle: 0.01 };
    const { keys } = selectOctreeNodes(source, view([0, 0, 1024, 1024], 1, camera), 60);
    const deepest = keys.filter((k) => k.startsWith("3-") || k.startsWith("4-"));
    assert.ok(deepest.length > 0, "the budget reaches the finer levels near the camera");
    for (const key of deepest) assert.ok(nodeBox(CUBE, key)[0] < 512, `${key} is on the near side`);
  });

  it("reports unread subtrees instead of guessing their counts", () => {
    const partial = { cube: CUBE, span: 8, counts: counts({ "0-0-0-0": 5, "1-0-0-0": -1 }) };
    const { keys, pendingSubtrees } = selectOctreeNodes(partial, view([0, 0, 100, 100], 0.1));
    assert.deepEqual(keys, ["0-0-0-0"]);
    assert.deepEqual(pendingSubtrees, ["1-0-0-0"]);
  });

  it("caps the total points held whatever the view estimate", () => {
    const { keys } = selectOctreeNodes(source, view([0, 0, 1, 1], 0.001), 1e9, 35);
    // The root (10) plus two more nodes of 10 fit under 35.
    assert.equal(keys.length, 3);
  });
});

// --- PointCloudStreamer -----------------------------------------------------

/** One decoded point per node, at the node's centre in degrees. */
function decoded(key: string): DecodedPointCloud {
  const [x0, y0, x1, y1] = nodeBox(CUBE, key);
  return {
    positions: new Float64Array([(x0 + x1) / 2, (y0 + y1) / 2, 5]),
    colors: null,
    count: 1,
    zMin: 0,
    zMax: 10,
    truncated: false,
  };
}

function fakeCesium() {
  class Collection {
    points = new Set<object>();
    show = true;
    get length() {
      return this.points.size;
    }
    add(p: object) {
      this.points.add(p);
      return p;
    }
    remove(p: object) {
      return this.points.delete(p);
    }
  }
  return {
    PointPrimitiveCollection: Collection,
    Cartesian3: { fromDegrees: (x: number, y: number, z: number) => ({ x, y, z }) },
    Color: class {
      constructor(
        public red: number,
        public green: number,
        public blue: number,
        public alpha: number,
      ) {}
    },
    // Rectangles are given in source units; 16 units to the "degree" keeps
    // the whole test cube (64°) under the streamer's 90° view guard.
    Math: { toDegrees: (r: number) => r / UNITS_PER_DEGREE },
  };
}

const UNITS_PER_DEGREE = 16;

/** A viewer whose view rectangle (in source units) the test sets. */
function fakeViewer() {
  const listeners: (() => void)[] = [];
  const state = { rect: { west: 0, south: 0, east: 1024, north: 1024 }, height: 1e6 };
  const viewer = {
    camera: {
      moveEnd: {
        addEventListener: (fn: () => void) => listeners.push(fn),
        removeEventListener: (fn: () => void) => listeners.splice(listeners.indexOf(fn), 1),
      },
      computeViewRectangle: () => state.rect,
      get positionCartographic() {
        const r = state.rect;
        return {
          longitude: (r.west + r.east) / 2,
          latitude: (r.south + r.north) / 2,
          height: state.height,
        };
      },
      frustum: { fovy: Math.PI / 3 },
      pitch: -Math.PI / 2,
    },
    scene: { canvas: { clientHeight: 1000 }, globe: { ellipsoid: {} }, requestRender: () => {} },
  };
  return { viewer, state, listeners };
}

function streamSource(tree: Map<string, number>, loads: string[]): OctreeSource {
  const project = ((x: number, y: number, z: number) => [x, y, z]) as OctreeSource["project"];
  project.inverse = (lng, lat) => [lng * UNITS_PER_DEGREE, lat * UNITS_PER_DEGREE];
  project.metresPerUnit = 1;
  return {
    cube: CUBE,
    span: 8,
    project,
    counts: tree,
    loadSubtree: async () => {},
    loadNode: async (key) => {
      loads.push(key);
      return decoded(key);
    },
  };
}

describe("PointCloudStreamer", () => {
  it("loads the view's nodes, swaps them as the camera moves, and caches revisits", async () => {
    const loads: string[] = [];
    const { viewer, state, listeners } = fakeViewer();
    const streamer = new PointCloudStreamer(
      fakeCesium() as never,
      viewer as never,
      streamSource(fullTree(3, 1), loads),
      { opacity: () => 0.5 },
    );
    // Close over the bottom-left corner: fine nodes there.
    state.rect = { west: 0, south: 0, east: 100, north: 100 };
    state.height = 50;
    await streamer.start();
    assert.equal(listeners.length, 1, "follows the camera");
    const first = streamer.shownKeys;
    assert.ok(first.includes("0-0-0-0"));
    assert.ok(first.includes("3-0-0-0"));
    assert.equal(streamer.pointCount, first.length);

    // Move to the top-right corner: the old fine nodes go, new ones come.
    state.rect = { west: 924, south: 924, east: 1024, north: 1024 };
    await streamer.refresh();
    const second = streamer.shownKeys;
    assert.ok(second.includes("3-7-7-0"));
    assert.ok(!second.includes("3-0-0-0"));
    assert.ok(second.includes("0-0-0-0"), "the root outline stays");

    // Back again: nothing is fetched twice.
    const before = loads.length;
    state.rect = { west: 0, south: 0, east: 100, north: 100 };
    await streamer.refresh();
    assert.equal(loads.length, before);
    assert.deepEqual(new Set(streamer.shownKeys), new Set(first));

    streamer.destroy();
    assert.equal(listeners.length, 0, "stops following the camera");
  });

  it("drops a refresh that a newer one overtook", async () => {
    const loads: string[] = [];
    const { viewer, state } = fakeViewer();
    const source = streamSource(fullTree(3, 1), loads);
    let release: () => void = () => {};
    const slow = source.loadNode;
    source.loadNode = async (key, signal) => {
      if (key === "3-0-0-0") await new Promise<void>((r) => (release = r));
      return slow(key, signal);
    };
    const streamer = new PointCloudStreamer(fakeCesium() as never, viewer as never, source, {
      opacity: () => 1,
    });
    state.rect = { west: 0, south: 0, east: 100, north: 100 };
    state.height = 50;
    const stale = streamer.refresh();
    state.rect = { west: 924, south: 924, east: 1024, north: 1024 };
    const fresh = streamer.refresh();
    await fresh;
    release();
    await stale;
    assert.ok(!streamer.shownKeys.includes("3-0-0-0"), "the overtaken view is not shown");
    assert.ok(streamer.shownKeys.includes("3-7-7-0"));
  });

  it("keeps the primitives under the cap while a newer refresh is still loading", async () => {
    const { viewer, state } = fakeViewer();
    // Header counts of 1 let every node through the selection; decoded, each
    // non-root node is 250k points, so two views' worth overflow the 1.5M cap.
    const source = streamSource(fullTree(4, 1), []);
    const big = (): DecodedPointCloud => ({
      positions: new Float64Array(250_000 * 3),
      colors: null,
      count: 250_000,
      zMin: 0,
      zMax: 1,
      truncated: false,
    });
    // Once armed, the fifth load (the first of the second four-node batch)
    // waits until released.
    let calls = -1;
    let release: (() => void) | null = null;
    source.loadNode = async (key) => {
      if (calls >= 0 && ++calls === 5) await new Promise<void>((r) => (release = r));
      return key === "0-0-0-0" ? decoded(key) : big();
    };
    const streamer = new PointCloudStreamer(fakeCesium() as never, viewer as never, source, {
      opacity: () => 1,
    });
    state.height = 50;
    // View A spans two depth-4 nodes in the bottom-left: root + 5 nodes.
    state.rect = { west: 0, south: 0, east: 120, north: 50 };
    await streamer.refresh();
    const viewA = streamer.shownKeys;
    assert.equal(viewA.length, 6);
    assert.equal(streamer.pointCount, 1 + 5 * 250_000);

    // View B in the top-right needs five new nodes, two batches. Its second
    // batch is held back, so the refresh shows its first four and then
    // waits, before it could drop view A at the end.
    state.rect = { west: 904, south: 974, east: 1024, north: 1024 };
    calls = 0;
    const pending = streamer.refresh();
    for (let i = 0; i < 100 && !release; i++) await new Promise((r) => setTimeout(r, 0));
    assert.ok(release, "view B is waiting on its second batch");
    assert.ok(streamer.pointCount <= 1_500_000, `${streamer.pointCount} points held mid-refresh`);
    assert.ok(
      viewA.some((key) => key !== "0-0-0-0" && !streamer.shownKeys.includes(key)),
      "trim dropped nodes only view A wanted",
    );
    (release as unknown as () => void)();
    await pending;
    assert.equal(streamer.shownKeys.length, 6, "view B complete: root + 5 nodes");
    assert.ok(!viewA.some((key) => key !== "0-0-0-0" && streamer.shownKeys.includes(key)));
  });

  it("reports a failed scheduled refresh instead of swallowing it", async () => {
    const { viewer, state, listeners } = fakeViewer();
    // Close in, so the walk reaches the unread subtree.
    state.rect = { west: 0, south: 0, east: 100, north: 100 };
    state.height = 50;
    const source = streamSource(counts({ "0-0-0-0": 1, "1-0-0-0": -1 }), []);
    source.loadSubtree = async () => {
      throw new Error("hierarchy 500");
    };
    const errors: string[] = [];
    const streamer = new PointCloudStreamer(fakeCesium() as never, viewer as never, source, {
      opacity: () => 1,
      onError: (message) => errors.push(message),
    });
    await streamer.start().catch(() => {});
    errors.length = 0;
    listeners[0]();
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(errors, ["hierarchy 500"]);
    streamer.destroy();
  });

  it("never downloads a hierarchy page for a subtree out of view", async () => {
    const { viewer, state } = fakeViewer();
    const tree = counts({ "0-0-0-0": 1, "1-0-0-0": -1, "1-1-1-0": -1 });
    const source = streamSource(tree, []);
    const read: string[] = [];
    source.loadSubtree = async (key) => {
      read.push(key);
      tree.set(key, 1);
    };
    const streamer = new PointCloudStreamer(fakeCesium() as never, viewer as never, source, {
      opacity: () => 1,
    });
    state.rect = { west: 0, south: 0, east: 100, north: 100 };
    state.height = 50;
    await streamer.refresh();
    assert.deepEqual(read, ["1-0-0-0"], "only the subtree under the view is read");
  });

  it("recolours fallback-coloured nodes once the root loads", async () => {
    const { viewer, state } = fakeViewer();
    const source = streamSource(fullTree(1, 1), []);
    let rootFails = true;
    source.loadNode = async (key) => {
      if (key === "0-0-0-0" && rootFails) throw new Error("root 503");
      const node = decoded(key);
      // The child's own range is far from the root's, so its colour moves.
      return key === "0-0-0-0"
        ? { ...node, zMin: 0, zMax: 10 }
        : { ...node, positions: new Float64Array([0, 0, 5]), zMin: 5, zMax: 9 };
    };
    const streamer = new PointCloudStreamer(fakeCesium() as never, viewer as never, source, {
      opacity: () => 0.7,
    });
    state.height = 1;
    await streamer.refresh();
    const collection = streamer.collection as unknown as {
      points: Set<{ color: { red: number; alpha: number } }>;
    };
    const child = [...collection.points][0];
    const before = child.color.red;
    rootFails = false;
    await streamer.refresh();
    assert.notEqual(child.color.red, before, "the child's colour moved to the root's scale");
    assert.equal(child.color.alpha, 0.7, "alpha is kept");
  });

  it("does nothing to the collection once destroyed", async () => {
    const { viewer, state } = fakeViewer();
    const source = streamSource(fullTree(1, 1), []);
    const waiting: (() => void)[] = [];
    const load = source.loadNode;
    source.loadNode = async (key, signal) => {
      if (key !== "0-0-0-0") await new Promise<void>((r) => waiting.push(r));
      return load(key, signal);
    };
    const streamer = new PointCloudStreamer(fakeCesium() as never, viewer as never, source, {
      opacity: () => 1,
    });
    state.height = 1;
    const pending = streamer.refresh();
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    const collection = streamer.collection as unknown as { remove: () => boolean };
    streamer.destroy();
    collection.remove = () => {
      throw new Error("collection already destroyed");
    };
    for (const go of waiting) go();
    await pending;
  });

  it("reports a node that fails to load and keeps the rest", async () => {
    const loads: string[] = [];
    const { viewer, state } = fakeViewer();
    const source = streamSource(fullTree(1, 1), loads);
    const ok = source.loadNode;
    source.loadNode = async (key, signal) => {
      if (key === "1-0-0-0") throw new Error("HTTP 503");
      return ok(key, signal);
    };
    const errors: string[] = [];
    const streamer = new PointCloudStreamer(fakeCesium() as never, viewer as never, source, {
      opacity: () => 1,
      onError: (message) => errors.push(message),
    });
    state.height = 1;
    await streamer.refresh();
    assert.deepEqual(errors, ["HTTP 503"]);
    assert.ok(streamer.shownKeys.includes("0-0-0-0"));
    assert.ok(!streamer.shownKeys.includes("1-0-0-0"));
  });
});
