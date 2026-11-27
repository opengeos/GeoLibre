// The browser raster tools worker (issue #3701): its message protocol, the
// runner's cancellation, and that a worker run returns exactly what a direct
// call does.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Feature, FeatureCollection } from "geojson";
import {
  runRasterToolClientAsync,
  type ClientToolProgress,
  type RasterData,
} from "../packages/processing/src/raster-client";
import {
  handleRasterToolRequest,
  rasterTransferables,
  type RasterToolWorkerMessage,
  type RasterToolWorkerRequest,
} from "../packages/processing/src/raster-tool-protocol";
import { runRasterToolInBackground } from "../packages/processing/src/raster-tool-runner";

const originalWorker = globalThis.Worker;

afterEach(() => {
  if (originalWorker === undefined) delete (globalThis as { Worker?: typeof Worker }).Worker;
  else globalThis.Worker = originalWorker;
});

const M = 1 / 111_320; // degrees per metre at the equator

/** A rectangular footprint at the equator, in metres east/north of (0, 0). */
function box(x0: number, y0: number, x1: number, y1: number, height: number): Feature {
  return {
    type: "Feature",
    properties: { height },
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [x0 * M, y0 * M],
          [x1 * M, y0 * M],
          [x1 * M, y1 * M],
          [x0 * M, y1 * M],
          [x0 * M, y0 * M],
        ],
      ],
    },
  };
}

const buildings: FeatureCollection = {
  type: "FeatureCollection",
  features: [box(0, 0, 10, 10, 30), box(25, 5, 35, 20, 12)],
};

const sunHoursParams = {
  mode: "sun-hours",
  date: "2026-06-21",
  utc_offset: 0,
  step_minutes: 30,
  cell_size: 1,
  margin: 15,
};

/** A small projected DEM: a tilted plane with a bump, in EPSG:32631. */
function dem(): RasterData {
  const width = 24;
  const height = 18;
  const band = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      band[y * width + x] = 100 + 2 * x + y + 15 * Math.exp(-((x - 12) ** 2 + (y - 9) ** 2) / 20);
    }
  }
  return {
    bands: [band],
    width,
    height,
    originX: 500_000,
    originY: 4_000_000,
    resX: 10,
    resY: 10,
    nodata: -9999,
    geoKeys: { GTModelTypeGeoKey: 1, ProjectedCSTypeGeoKey: 32631 },
  };
}

/**
 * A Worker that runs the real protocol handler on a later task, with the
 * structured clone (and transfer) a real postMessage does in both directions.
 */
class LoopbackWorker {
  static instances: LoopbackWorker[] = [];
  terminated = false;
  private listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor() {
    LoopbackWorker.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message: RasterToolWorkerRequest, transfer: Transferable[] = []) {
    const request = structuredClone(message, { transfer });
    setTimeout(() => {
      void handleRasterToolRequest(request, (reply, replyTransfer) => {
        if (this.terminated) return;
        const data = structuredClone(reply, { transfer: replyTransfer });
        for (const listener of this.listeners.get("message") ?? []) listener({ data });
      });
    }, 0);
  }

  terminate() {
    this.terminated = true;
  }
}

/** A worker that never answers, so only cancellation can end the run. */
class HangingWorker {
  static terminated = 0;
  static spawned = 0;
  constructor() {
    HangingWorker.spawned += 1;
  }
  addEventListener() {}
  removeEventListener() {}
  postMessage() {}
  terminate() {
    HangingWorker.terminated += 1;
  }
}

describe("raster tool worker protocol", () => {
  it("posts one progress message per sun position, then the result with its buffers", async () => {
    const messages: { message: RasterToolWorkerMessage; transfer: ArrayBuffer[] }[] = [];
    await handleRasterToolRequest(
      {
        toolId: "building-shadows",
        inputs: { vectors: { input: buildings } },
        parameters: sunHoursParams,
      },
      (message, transfer) => messages.push({ message, transfer }),
    );
    const progress = messages
      .map(({ message }) => message)
      .filter((message) => message.type === "progress")
      .map((message) => message.progress);
    assert.ok(progress.length > 10, `${progress.length} progress messages`);
    progress.forEach((step, index) => {
      assert.equal(step.stage, "sun-positions");
      assert.equal(step.done, index + 1);
      assert.equal(step.total, progress.length);
    });
    const last = messages.at(-1)!;
    assert.equal(last.message.type, "result");
    if (last.message.type !== "result" || last.message.result.kind !== "raster") {
      throw new Error("expected a raster result");
    }
    const { raster, bytes } = last.message.result;
    assert.deepEqual(last.transfer, [raster.bands[0].buffer, bytes]);
  });

  it("posts an error with the thrown error's name and message", async () => {
    const messages: RasterToolWorkerMessage[] = [];
    await handleRasterToolRequest(
      { toolId: "no-such-tool", inputs: { raster: dem() }, parameters: {} },
      (message) => messages.push(message),
    );
    assert.deepEqual(messages, [
      {
        type: "error",
        name: "Error",
        message: '"no-such-tool" has no client-side implementation.',
      },
    ]);
  });

  it("lists each band buffer once and skips shared memory", () => {
    const shared = new ArrayBuffer(32);
    const a: RasterData = { ...dem(), bands: [new Float32Array(shared, 0, 4)] };
    const b: RasterData = { ...dem(), bands: [new Float32Array(shared, 16, 4)] };
    const c: RasterData = {
      ...dem(),
      bands: [new Float32Array(new SharedArrayBuffer(16) as unknown as ArrayBuffer)],
    };
    assert.deepEqual(rasterTransferables([a, b, c, undefined]), [shared]);
  });
});

describe("runRasterToolInBackground", () => {
  it("runs inline where there is no Worker, with the direct call's result", async () => {
    delete (globalThis as { Worker?: typeof Worker }).Worker;
    const direct = await runRasterToolClientAsync("hillshade", { raster: dem() }, {});
    const background = await runRasterToolInBackground("hillshade", { raster: dem() }, {});
    assert.deepEqual(background, direct);
  });

  for (const [toolId, inputs, parameters] of [
    ["hillshade", () => ({ raster: dem() }), { azimuth: 300, altitude: 40 }],
    ["slope", () => ({ raster: dem() }), { units: "percent" }],
    ["contour", () => ({ raster: dem() }), { interval: 5 }],
    ["building-shadows", () => ({ vectors: { input: buildings } }), sunHoursParams],
  ] as const) {
    it(`returns what a direct call does on a worker (${toolId})`, async () => {
      globalThis.Worker = LoopbackWorker as unknown as typeof Worker;
      LoopbackWorker.instances = [];
      const direct = await runRasterToolClientAsync(toolId, inputs(), { ...parameters });
      const progress: ClientToolProgress[] = [];
      const sent = inputs();
      const background = await runRasterToolInBackground(
        toolId,
        sent,
        { ...parameters },
        {
          onProgress: (step) => progress.push(step),
        },
      );
      assert.deepEqual(background, direct);
      assert.equal(LoopbackWorker.instances.length, 1);
      assert.equal(LoopbackWorker.instances[0].terminated, true, "the worker ends with the run");
      if ("raster" in sent && sent.raster) {
        // The input bands moved to the worker rather than being copied.
        assert.equal(sent.raster.bands[0].buffer.byteLength, 0);
      }
      if (toolId === "building-shadows") {
        assert.ok(progress.length > 10);
        assert.equal(progress.at(-1)!.done, progress.at(-1)!.total);
      } else {
        assert.equal(progress.length, 0);
      }
    });
  }

  it("rejects with the worker's error", async () => {
    globalThis.Worker = LoopbackWorker as unknown as typeof Worker;
    await assert.rejects(
      runRasterToolInBackground("no-such-tool", { raster: dem() }, {}),
      /no client-side implementation/,
    );
  });

  it("terminates the worker and rejects with an AbortError when cancelled", async () => {
    globalThis.Worker = HangingWorker as unknown as typeof Worker;
    HangingWorker.terminated = 0;
    const controller = new AbortController();
    const run = runRasterToolInBackground(
      "hillshade",
      { raster: dem() },
      {},
      {
        signal: controller.signal,
      },
    );
    controller.abort();
    await assert.rejects(run, (error: Error) => error.name === "AbortError");
    assert.equal(HangingWorker.terminated, 1);
  });

  it("stops a long shadow run mid-way: no result and no progress after Cancel", async () => {
    globalThis.Worker = LoopbackWorker as unknown as typeof Worker;
    LoopbackWorker.instances = [];
    const controller = new AbortController();
    const progress: ClientToolProgress[] = [];
    const run = runRasterToolInBackground(
      "building-shadows",
      { vectors: { input: buildings } },
      { ...sunHoursParams },
      { signal: controller.signal, onProgress: (step) => progress.push(step) },
    );
    controller.abort();
    await assert.rejects(run, (error: Error) => error.name === "AbortError");
    assert.equal(LoopbackWorker.instances[0].terminated, true);
    // Let the loopback finish its task: its replies must not surface.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(progress.length, 0);
  });

  it("does not start a run whose signal is already aborted", async () => {
    globalThis.Worker = HangingWorker as unknown as typeof Worker;
    HangingWorker.spawned = 0;
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      runRasterToolInBackground("hillshade", { raster: dem() }, {}, { signal: controller.signal }),
      (error: Error) => error.name === "AbortError",
    );
    assert.equal(HangingWorker.spawned, 0);
  });
});
