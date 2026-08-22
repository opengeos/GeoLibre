import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { runWhiteboxToolWasm, type WhiteboxLayerInput } from "@geolibre/processing";
import { releaseIdleWasmToolWorkers } from "../packages/processing/src/wasm-tool-runner";

const originalWorker = globalThis.Worker;
const originalFetch = globalThis.fetch;
let posted: { args: string[]; input: Record<string, Uint8Array> } | undefined;

class FakeWorker {
  private listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.get(type)?.delete(listener);
  }
  postMessage(request: { args: string[]; input: Record<string, Uint8Array> }) {
    posted = request;
    const output = new TextEncoder().encode(
      JSON.stringify({ type: "FeatureCollection", features: [] }),
    );
    queueMicrotask(() => {
      for (const listener of this.listeners.get("message") ?? []) {
        listener({
          data: {
            ok: true,
            result: {
              exitCode: 0,
              stdout: [],
              files: { "merge_vectors_output.geojson": output },
            },
          },
        } as MessageEvent);
      }
    });
  }
  terminate() {}
}

afterEach(() => {
  releaseIdleWasmToolWorkers();
  if (originalWorker === undefined) delete (globalThis as { Worker?: typeof Worker }).Worker;
  else globalThis.Worker = originalWorker;
  globalThis.fetch = originalFetch;
  posted = undefined;
});

describe("runWhiteboxToolWasm multi-input staging", () => {
  it("stages every vector and passes one comma-delimited argument", async () => {
    globalThis.Worker = FakeWorker as unknown as typeof Worker;

    const collection = { type: "FeatureCollection", features: [] } as const;
    const inputs: WhiteboxLayerInput[] = ["a", "b"].map((name) => ({
      name,
      kind: "vector_in",
      geojson: collection,
    }));
    const result = await runWhiteboxToolWasm({
      tool_id: "merge_vectors",
      parameters: {},
      layer_inputs: { inputs },
      tool: {
        id: "merge_vectors",
        params: [
          { name: "inputs", kind: "vector_in", required: true },
          { name: "output", kind: "vector_out", required: true },
        ],
      },
    });

    assert.equal(result.status, "succeeded");
    assert.ok(posted);
    assert.deepEqual(Object.keys(posted.input), ["inputs_1.geojson", "inputs_2.geojson"]);
    assert.ok(posted.args.includes("--inputs=/work/inputs_1.geojson,/work/inputs_2.geojson"));
  });

  it("splits and fetches a typed comma-delimited vector path list", async () => {
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ type: "FeatureCollection", features: [] }), {
        status: 200,
      });

    const result = await runWhiteboxToolWasm({
      tool_id: "merge_vectors",
      parameters: { inputs: "https://example.com/a.geojson,https://example.com/b.geojson" },
      tool: {
        id: "merge_vectors",
        params: [
          {
            name: "inputs",
            description: "Array of input vector paths.",
            kind: "vector_in",
            required: true,
          },
          { name: "output", kind: "vector_out", required: true },
        ],
      },
    });

    assert.equal(result.status, "succeeded");
    assert.ok(posted);
    assert.deepEqual(Object.keys(posted.input), ["inputs_1.geojson", "inputs_2.geojson"]);
    assert.ok(posted.args.includes("--inputs=/work/inputs_1.geojson,/work/inputs_2.geojson"));
  });
});
