import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import type { Feature, FeatureCollection } from "geojson";
import { DEFAULT_LAYER_STYLE, setActiveEllipsoidId, type GeoLibreLayer } from "@geolibre/core";
import {
  VECTOR_TOOLS,
  WORKER_VECTOR_TOOL_IDS,
  VECTOR_TOOL_WORKER_IDLE_MS,
  canRunVectorToolOnWorker,
  disposeVectorToolWorker,
  getVectorTool,
  runAlgorithmCapture,
  runAlgorithmInBackground,
  runModel,
  type ProcessingAlgorithm,
  type ProcessingContext,
} from "@geolibre/processing";
import {
  VECTOR_TOOL_CHUNK_FEATURES,
  createVectorToolSession,
  type VectorToolWorkerMessage,
  type VectorToolWorkerRequest,
} from "../packages/processing/src/vector-tool-protocol";

const originalWorker = globalThis.Worker;

/** Every message the fake carried, in each direction, for assertions. */
let toWorker: VectorToolWorkerRequest[] = [];
let spawned = 0;
let terminated = 0;

/**
 * An in-process stand-in for vector-tool.worker.ts: the same session handler,
 * with every message structured-cloned and delivered on a later task in both
 * directions, as a real worker boundary would. Module state is shared with the
 * test, so a fresh worker's Earth default is re-imposed before each run to catch
 * a request that forgets to carry the active body.
 */
class FakeWorker {
  private listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  private terminated = false;
  private handle = createVectorToolSession((message: VectorToolWorkerMessage) => {
    const data = structuredClone(message);
    setImmediate(() => {
      if (this.terminated) return;
      for (const listener of this.listeners.get("message") ?? []) {
        listener({ data } as MessageEvent);
      }
    });
  });

  constructor() {
    spawned += 1;
    // The real worker announces itself once its module has loaded.
    setImmediate(() => this.emit({ type: "ready" }));
  }

  /** Deliver a worker-side message to the main thread's listeners. */
  emit(data: unknown, type = "message") {
    if (this.terminated) return;
    for (const listener of this.listeners.get(type) ?? []) listener({ data } as MessageEvent);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(request: VectorToolWorkerRequest) {
    // Throws DataCloneError synchronously, like the real postMessage.
    const data = structuredClone(request);
    toWorker.push(data);
    setImmediate(() => {
      if (this.terminated) return;
      if (data.type === "run") setActiveEllipsoidId("earth");
      void this.handle(data);
    });
  }

  terminate() {
    this.terminated = true;
    terminated += 1;
  }
}

function installFakeWorker() {
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
}

afterEach(() => {
  // A clean run parks its worker; drop it so the next test spawns its own.
  disposeVectorToolWorker();
  if (originalWorker === undefined) delete (globalThis as { Worker?: typeof Worker }).Worker;
  else globalThis.Worker = originalWorker;
  setActiveEllipsoidId("earth");
  toWorker = [];
  spawned = 0;
  terminated = 0;
});

function layer(id: string, features: Feature[]): GeoLibreLayer {
  return {
    id,
    name: id,
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    geojson: { type: "FeatureCollection", features },
  };
}

function square(x: number, y: number, size: number, properties: Record<string, unknown>): Feature {
  return {
    type: "Feature",
    properties,
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [x, y],
          [x + size, y],
          [x + size, y + size],
          [x, y + size],
          [x, y],
        ],
      ],
    },
  };
}

function point(x: number, y: number, properties: Record<string, unknown>): Feature {
  return { type: "Feature", properties, geometry: { type: "Point", coordinates: [x, y] } };
}

const POLYS = layer("polys", [
  square(0, 0, 2, { zone: "a", value: 1 }),
  square(1, 1, 2, { zone: "a", value: 2 }),
  square(5, 5, 1, { zone: "b", value: 3 }),
]);
const CLIP = layer("clip", [square(0.5, 0.5, 2, { name: "clip" })]);
const POINTS = layer("pts", [
  point(0.5, 0.5, { name: "p1", kind: "x", n: 4 }),
  point(1.5, 1.5, { name: "p2", kind: "y", n: 5 }),
  point(5.5, 5.5, { name: "p3", kind: "x", n: 6 }),
  point(9, 9, { name: "p4", kind: "y", n: 7 }),
]);
const POINTS_2 = layer("pts2", [point(3, 3, { name: "q1" })]);
const LINES = layer("lines", [
  {
    type: "Feature",
    properties: { name: "l1" },
    geometry: {
      type: "LineString",
      coordinates: [
        [0, 0],
        [0.3, 0.1],
        [0.6, 0.4],
        [1, 1],
      ],
    },
  },
]);
const LAYERS = [POLYS, CLIP, POINTS, POINTS_2, LINES];
// A geometry type Turf does not know, so a tool throws on it.
const BOGUS_LAYER = layer("bogus", [
  { type: "Feature", properties: {}, geometry: { type: "Bogus", coordinates: [] } } as never,
]);

/** Everything a run did to its context, in order. */
type Call = [string, ...unknown[]];

function recordingContext(
  parameters: Record<string, unknown>,
  layers: GeoLibreLayer[] = LAYERS,
): { ctx: ProcessingContext; calls: Call[] } {
  const calls: Call[] = [];
  const ctx: ProcessingContext = {
    layers,
    parameters,
    log: (message) => calls.push(["log", message]),
    fitBounds: (bounds) => calls.push(["fitBounds", bounds]),
    addResultLayer: (...args) => calls.push(["addResultLayer", ...args]),
    viewportBounds: () => [0, 0, 2, 2],
  };
  return { ctx, calls };
}

/** Run a tool directly and through the (fake) worker; return both call logs. */
async function runBoth(toolId: string, parameters: Record<string, unknown>) {
  const tool = getVectorTool(toolId);
  assert.ok(tool, toolId);
  const direct = recordingContext(parameters);
  await tool.run(direct.ctx);
  installFakeWorker();
  const background = recordingContext(parameters);
  await runAlgorithmInBackground(tool, background.ctx);
  return { direct: direct.calls, worker: background.calls };
}

const CASES: [string, Record<string, unknown>][] = [
  ["buffer", { layer: "pts", distance: 25, units: "kilometers" }],
  ["buffer", { layer: "polys", distance: 10, units: "kilometers", dissolve: true }],
  ["centroids", { layer: "polys" }],
  ["convex-hull", { layer: "pts" }],
  ["dissolve", { layer: "polys", field: "zone" }],
  ["bounding-box", { layer: "polys" }],
  ["simplify", { layer: "lines", tolerance: 0.2 }],
  ["clip", { layer: "polys", overlay: "clip" }],
  ["intersection", { layer: "polys", overlay: "clip" }],
  ["difference", { layer: "polys", overlay: "clip" }],
  ["union", { layer: "polys", overlay: "clip" }],
  ["spatial-join", { layer: "pts", overlay: "polys", predicate: "within", how: "left" }],
  ["select-by-value", { layer: "pts", field: "kind", operator: "eq", value: "x" }],
  ["select-by-location", { layer: "pts", overlay: "polys", predicate: "intersects" }],
  ["explode", { layer: "polys" }],
  ["aggregate", { layer: "polys", group_field: "zone", statistic: "sum", stat_field: "value" }],
  ["smooth", { layer: "lines", iterations: 2 }],
  ["extract-vertices", { layer: "lines" }],
  ["points-along-geometry", { layer: "lines", interval: 20, units: "kilometers" }],
  ["grid", { source: "viewport", cell_width: 50, cell_type: "polygon" }],
  ["voronoi", { layer: "pts", type: "voronoi" }],
  ["cell-sectors", { layer: "pts", azimuth: 45, radius: 3, beamwidth: 60, units: "kilometers" }],
  ["merge-layers", { layers: ["pts", "pts2"], addSourceField: true }],
  ["encode-polyline", { layer: "lines", precision: "5", targetField: "encoded" }],
  // A soft failure (logged, nothing added) must replay identically too.
  ["clip", { layer: "polys", overlay: "missing" }],
];

describe("runAlgorithmInBackground", () => {
  for (const [toolId, parameters] of CASES) {
    it(`matches direct execution: ${toolId} ${JSON.stringify(parameters)}`, async () => {
      const { direct, worker } = await runBoth(toolId, parameters);
      assert.ok(direct.length > 0);
      assert.deepEqual(worker, direct);
      assert.equal(spawned, 1);
      // A clean run parks its worker for the next one instead of terminating it.
      assert.equal(terminated, 0);
    });
  }

  it("carries the active planetary body into the worker", async () => {
    setActiveEllipsoidId("mars");
    const { direct, worker } = await runBoth("buffer", {
      layer: "pts",
      distance: 25,
      units: "kilometers",
    });
    assert.deepEqual(worker, direct);
    const earth = recordingContext({ layer: "pts", distance: 25, units: "kilometers" });
    setActiveEllipsoidId("earth");
    await getVectorTool("buffer")!.run(earth.ctx);
    // Sanity: the body actually changes the result, so the equality above
    // is not vacuous.
    assert.notDeepEqual(earth.calls, direct);
  });

  it("sends only the referenced layers, cut down to what the tools read", async () => {
    await runBoth("clip", { layer: "polys", overlay: "clip" });
    const headers = toWorker.filter((message) => message.type === "layer");
    assert.deepEqual(
      headers.map((message) => message.type === "layer" && Object.keys(message.layer).sort()),
      [
        ["geojson", "id", "name", "type"],
        ["geojson", "id", "name", "type"],
      ],
    );
    assert.deepEqual(
      headers.map((message) => message.type === "layer" && message.layer.id).sort(),
      ["clip", "polys"],
    );
  });

  it("chunks large inputs and results in both directions", async () => {
    const count = VECTOR_TOOL_CHUNK_FEATURES * 2 + 17;
    const many = layer(
      "many",
      Array.from({ length: count }, (_, i) => point((i % 360) - 180, (i % 170) - 85, { i })),
    );
    const tool = getVectorTool("buffer")!;
    const parameters = { layer: "many", distance: 1, units: "kilometers" };
    const direct = recordingContext(parameters, [many]);
    await tool.run(direct.ctx);
    installFakeWorker();
    const background = recordingContext(parameters, [many]);
    await runAlgorithmInBackground(tool, background.ctx);
    assert.deepEqual(background.calls, direct.calls);
    assert.equal(toWorker.filter((message) => message.type === "layer-features").length, 3);
    // The caller's layer was never mutated by the chunked send.
    assert.equal(many.geojson!.features.length, count);
  });

  it("runs inline when Workers are unavailable", async () => {
    delete (globalThis as { Worker?: typeof Worker }).Worker;
    const tool = getVectorTool("centroids")!;
    assert.equal(canRunVectorToolOnWorker(tool), false);
    const { ctx, calls } = recordingContext({ layer: "polys" });
    await runAlgorithmInBackground(tool, ctx);
    assert.equal(calls.filter(([kind]) => kind === "addResultLayer").length, 1);
    assert.equal(spawned, 0);
  });

  it("runs a caller's own algorithm inline even when it reuses a registry id", async () => {
    installFakeWorker();
    let ran = false;
    const impostor: ProcessingAlgorithm = {
      ...getVectorTool("buffer")!,
      run: () => {
        ran = true;
      },
    };
    assert.equal(canRunVectorToolOnWorker(impostor), false);
    await runAlgorithmInBackground(impostor, recordingContext({}).ctx);
    assert.ok(ran);
    assert.equal(spawned, 0);
  });

  it("runs DuckDB-backed tools inline", () => {
    installFakeWorker();
    for (const id of ["dggs-grid", "check-validity", "fix-topology", "reproject"]) {
      const tool = getVectorTool(id);
      assert.ok(tool, id);
      assert.equal(canRunVectorToolOnWorker(tool), false, id);
    }
  });

  it("falls back inline when the run cannot be structured-cloned", async () => {
    installFakeWorker();
    const parameters = { layer: "polys", notCloneable: () => 1 };
    const { ctx, calls } = recordingContext(parameters);
    await runAlgorithmInBackground(getVectorTool("centroids")!, ctx);
    assert.equal(calls.filter(([kind]) => kind === "addResultLayer").length, 1);
    assert.equal(terminated, 1);
    assert.equal(
      toWorker.some((message) => message.type === "run"),
      false,
    );
  });

  it("rejects with an AbortError and terminates the worker when aborted", async () => {
    installFakeWorker();
    const controller = new AbortController();
    const { ctx } = recordingContext({ layer: "polys" });
    ctx.signal = controller.signal;
    const run = runAlgorithmInBackground(getVectorTool("centroids")!, ctx);
    controller.abort();
    await assert.rejects(run, { name: "AbortError" });
    assert.equal(terminated, 1);
  });

  it("rejects before spawning when already aborted", async () => {
    installFakeWorker();
    const controller = new AbortController();
    controller.abort();
    const { ctx } = recordingContext({ layer: "polys" });
    ctx.signal = controller.signal;
    await assert.rejects(runAlgorithmInBackground(getVectorTool("centroids")!, ctx), {
      name: "AbortError",
    });
    assert.equal(spawned, 0);
  });

  it("rejects with the message of a tool that throws, as a direct run would", async () => {
    const tool = getVectorTool("centroids")!;
    const direct = recordingContext({ layer: "bogus" }, [BOGUS_LAYER]);
    let message = "";
    try {
      await tool.run(direct.ctx);
    } catch (error) {
      message = (error as Error).message;
    }
    assert.ok(message);
    installFakeWorker();
    const background = recordingContext({ layer: "bogus" }, [BOGUS_LAYER]);
    await assert.rejects(runAlgorithmInBackground(tool, background.ctx), { message });
    assert.deepEqual(background.calls, direct.calls);
    // The tool failed, not the worker: it finished the run and stays warm.
    assert.equal(terminated, 0);
  });

  it("falls back inline when the worker cannot be constructed", async () => {
    globalThis.Worker = class {
      constructor() {
        throw new Error("blocked by CSP");
      }
    } as unknown as typeof Worker;
    const { ctx, calls } = recordingContext({ layer: "polys" });
    await runAlgorithmInBackground(getVectorTool("centroids")!, ctx);
    assert.equal(calls.filter(([kind]) => kind === "addResultLayer").length, 1);
  });

  it("falls back inline when the worker fails to load before it is ready", async () => {
    globalThis.Worker = class extends FakeWorker {
      override emit(data: unknown, type = "message") {
        // The module never loads: an `error` arrives in place of `ready`.
        if (type === "message" && (data as { type?: string }).type === "ready") {
          super.emit(undefined, "error");
          return;
        }
        super.emit(data, type);
      }
    } as unknown as typeof Worker;
    const { ctx, calls } = recordingContext({ layer: "polys" });
    await runAlgorithmInBackground(getVectorTool("centroids")!, ctx);
    assert.equal(calls.filter(([kind]) => kind === "addResultLayer").length, 1);
    assert.equal(toWorker.length, 0, "nothing is posted before the worker is ready");
    assert.equal(terminated, 1);
  });

  it("is what runAlgorithmCapture uses", async () => {
    installFakeWorker();
    const output = await runAlgorithmCapture(
      getVectorTool("centroids")!,
      { layer: "polys" },
      { layers: LAYERS, log: () => {} },
    );
    assert.equal(output?.features.length, 3);
    assert.equal(spawned, 1);
  });
});

/**
 * A fake worker that runs the tool but withholds its `done`, so a test can
 * abort a run whose results have already arrived on the main thread.
 */
class StallingWorker extends FakeWorker {
  /** Called once the run's last result message has reached the main thread. */
  static resultsArrived: () => void = () => {};
  constructor() {
    super();
    super.addEventListener("message", (event: MessageEvent) => {
      if ((event.data as { type?: string }).type === "result-end") StallingWorker.resultsArrived();
    });
  }
  override addEventListener(type: string, listener: (event: MessageEvent) => void) {
    if (type !== "message") return super.addEventListener(type, listener);
    super.addEventListener(type, (event) => {
      if ((event.data as { type?: string }).type === "done") return;
      listener(event);
    });
  }
}

describe("runAlgorithmInBackground cancellation", () => {
  it("leaves the context untouched when aborted after the results arrived", async () => {
    globalThis.Worker = StallingWorker as unknown as typeof Worker;
    const arrived = new Promise<void>((resolve) => {
      StallingWorker.resultsArrived = resolve;
    });
    const controller = new AbortController();
    const { ctx, calls } = recordingContext({ layer: "pts", distance: 25, units: "kilometers" });
    ctx.signal = controller.signal;
    const run = runAlgorithmInBackground(getVectorTool("buffer")!, ctx);
    await arrived;
    controller.abort();
    await assert.rejects(run, { name: "AbortError" });
    assert.deepEqual(calls, [], "no log, result layer or fitBounds from a cancelled run");
    assert.equal(terminated, 1);
  });

  it("does not add a result when aborted while the inputs are still being posted", async () => {
    installFakeWorker();
    const big = layer(
      "big",
      Array.from({ length: VECTOR_TOOL_CHUNK_FEATURES * 3 }, (_, i) =>
        point(i % 10, Math.floor(i / 10) % 10, { i }),
      ),
    );
    const controller = new AbortController();
    const { ctx, calls } = recordingContext({ layer: "big" }, [big]);
    ctx.signal = controller.signal;
    const run = runAlgorithmInBackground(getVectorTool("centroids")!, ctx);
    // Abort once the first input chunk is on its way, before `run` is posted.
    while (!toWorker.some((message) => message.type === "layer-features")) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    controller.abort();
    await assert.rejects(run, { name: "AbortError" });
    assert.deepEqual(calls, []);
    assert.equal(
      toWorker.some((message) => message.type === "run"),
      false,
    );
    assert.equal(terminated, 1);
  });

  it("spawns a fresh worker for the run after an aborted one", async () => {
    installFakeWorker();
    // Warm a worker with a clean run first.
    await runAlgorithmInBackground(
      getVectorTool("centroids")!,
      recordingContext({ layer: "polys" }).ctx,
    );
    assert.equal(spawned, 1);
    const controller = new AbortController();
    const aborted = recordingContext({ layer: "polys" });
    aborted.ctx.signal = controller.signal;
    const run = runAlgorithmInBackground(getVectorTool("centroids")!, aborted.ctx);
    controller.abort();
    await assert.rejects(run, { name: "AbortError" });
    // The aborted run used (and killed) the warm worker.
    assert.equal(spawned, 1);
    assert.equal(terminated, 1);
    const next = recordingContext({ layer: "polys" });
    await runAlgorithmInBackground(getVectorTool("centroids")!, next.ctx);
    assert.equal(spawned, 2);
    assert.equal(next.calls.filter(([kind]) => kind === "addResultLayer").length, 1);
  });
});

describe("warm vector tool worker", () => {
  it("reuses one worker for consecutive runs, with identical results", async () => {
    installFakeWorker();
    for (const [toolId, parameters] of CASES.slice(0, 6)) {
      const tool = getVectorTool(toolId)!;
      const direct = recordingContext(parameters);
      await tool.run(direct.ctx);
      const background = recordingContext(parameters);
      await runAlgorithmInBackground(tool, background.ctx);
      assert.deepEqual(background.calls, direct.calls, toolId);
    }
    assert.equal(spawned, 1);
    assert.equal(terminated, 0);
  });

  it("does not carry one run's input layers into the next", async () => {
    const posted: VectorToolWorkerMessage[] = [];
    const handle = createVectorToolSession((message) => posted.push(message));
    await handle({ type: "layer", layer: { ...POLYS } });
    const run = {
      type: "run" as const,
      toolId: "centroids",
      parameters: { layer: "polys" },
      viewportBounds: null,
      ellipsoidId: "earth",
    };
    await handle(run);
    assert.ok(posted.some((message) => message.type === "result-start"));
    // The same run again without re-sending the layer: the session no longer
    // has it, exactly as a fresh worker would not.
    const fresh: VectorToolWorkerMessage[] = [];
    await createVectorToolSession((message) => fresh.push(message))(run);
    posted.length = 0;
    await handle(run);
    assert.deepEqual(posted, fresh);
    assert.ok(!posted.some((message) => message.type === "result-start"));
  });

  it("terminates the parked worker after the idle timeout", async () => {
    installFakeWorker();
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      await runAlgorithmInBackground(
        getVectorTool("centroids")!,
        recordingContext({ layer: "polys" }).ctx,
      );
      assert.equal(terminated, 0);
      mock.timers.tick(VECTOR_TOOL_WORKER_IDLE_MS - 1);
      assert.equal(terminated, 0);
      mock.timers.tick(1);
      assert.equal(terminated, 1);
    } finally {
      mock.timers.reset();
    }
    await runAlgorithmInBackground(
      getVectorTool("centroids")!,
      recordingContext({ layer: "polys" }).ctx,
    );
    assert.equal(spawned, 2);
  });

  it("keeps one warm worker when runs overlap", async () => {
    installFakeWorker();
    await Promise.all([
      runAlgorithmInBackground(
        getVectorTool("centroids")!,
        recordingContext({ layer: "polys" }).ctx,
      ),
      runAlgorithmInBackground(getVectorTool("explode")!, recordingContext({ layer: "polys" }).ctx),
    ]);
    assert.equal(spawned, 2);
    assert.equal(terminated, 1);
  });

  it("serves a chained Model Builder run from one worker", async () => {
    installFakeWorker();
    const results = await runModel(
      {
        id: "m",
        name: "chain",
        steps: [
          { id: "s1", toolId: "centroids", parameters: { layer: "polys" } },
          { id: "s2", toolId: "buffer", parameters: { distance: 10, units: "kilometers" } },
          { id: "s3", toolId: "convex-hull", parameters: {} },
        ],
      },
      { layers: LAYERS, log: () => {} },
    );
    assert.equal(results.length, 3);
    assert.ok(results.every((result) => !result.error && result.output));
    assert.equal(spawned, 1);
  });
});

describe("createVectorToolSession", () => {
  it("reports a malformed layer message as an error instead of going silent", async () => {
    const posted: VectorToolWorkerMessage[] = [];
    const handle = createVectorToolSession((message) => posted.push(message));
    await handle({ type: "layer", layer: null } as unknown as VectorToolWorkerRequest);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].type, "error");
  });

  it("reports an unknown tool as an error message", async () => {
    const posted: VectorToolWorkerMessage[] = [];
    const handle = createVectorToolSession((message) => posted.push(message));
    await handle({
      type: "run",
      toolId: "no-such-tool",
      parameters: {},
      viewportBounds: null,
      ellipsoidId: "earth",
    });
    assert.deepEqual(posted, [{ type: "error", message: 'Unknown tool "no-such-tool"' }]);
  });

  it("reports a tool that throws with its message", async () => {
    const posted: VectorToolWorkerMessage[] = [];
    const handle = createVectorToolSession((message) => posted.push(message));
    await handle({ type: "layer", layer: BOGUS_LAYER });
    await handle({
      type: "run",
      toolId: "centroids",
      parameters: { layer: "bogus" },
      viewportBounds: null,
      ellipsoidId: "earth",
    });
    assert.equal(posted.length, 1);
    assert.equal(posted[0].type, "error");
  });
});

describe("WORKER_VECTOR_TOOL_IDS", () => {
  it("names only registered vector tools", () => {
    const ids = new Set(VECTOR_TOOLS.map((tool) => tool.id));
    for (const id of WORKER_VECTOR_TOOL_IDS) assert.ok(ids.has(id), id);
  });

  it("is the reviewed worker-safe list", () => {
    assert.deepEqual([...WORKER_VECTOR_TOOL_IDS].sort(), [
      "aggregate",
      "attribute-join",
      "bounding-box",
      "buffer",
      "cell-sectors",
      "centroids",
      "clip",
      "convex-hull",
      "decode-polyline",
      "detect-stops",
      "difference",
      "dissolve",
      "encode-polyline",
      "explode",
      "extract-vertices",
      "grid",
      "intersection",
      "merge-layers",
      "points-along-geometry",
      "random-extract",
      "select-by-location",
      "select-by-value",
      "simplify",
      "smooth",
      "space-time-proximity",
      "spatial-join",
      "trajectory-speed",
      "union",
      "voronoi",
    ]);
  });

  it("resolves each id to the registry's own tool", () => {
    for (const id of WORKER_VECTOR_TOOL_IDS) {
      const tool = getVectorTool(id);
      assert.ok(tool && canRunVectorToolOnWorkerWhenAvailable(tool), id);
    }
  });
});

/** canRunVectorToolOnWorker with a Worker constructor present. */
function canRunVectorToolOnWorkerWhenAvailable(tool: ProcessingAlgorithm): boolean {
  installFakeWorker();
  return canRunVectorToolOnWorker(tool);
}
