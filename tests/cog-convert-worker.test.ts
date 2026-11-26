import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { convertGeoTiffToCog } from "../packages/processing/src/cog-convert";
import type {
  CogConvertRequest,
  CogConvertResponse,
} from "../packages/processing/src/cog-convert.worker";

const originalWorker = globalThis.Worker;
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<CogConvertResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  request?: CogConvertRequest;
  terminated = false;
  terminateCalls = 0;
  constructor(
    readonly url: URL,
    readonly options: WorkerOptions,
  ) {
    FakeWorker.instances.push(this);
  }
  postMessage(request: CogConvertRequest, transfer: Transferable[]) {
    // Real transfer semantics: detach the sender and preserve exactly its view.
    this.request = structuredClone(request, { transfer });
  }
  answer(data: CogConvertResponse) {
    this.onmessage?.({ data } as MessageEvent<CogConvertResponse>);
  }
  terminate() {
    this.terminated = true;
    this.terminateCalls += 1;
  }
}

afterEach(() => {
  if (originalWorker === undefined) delete (globalThis as { Worker?: typeof Worker }).Worker;
  else globalThis.Worker = originalWorker;
  FakeWorker.instances = [];
});

function installWorker() {
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
}
function lastWorker() {
  return FakeWorker.instances.at(-1)!;
}

describe("COG conversion worker lifecycle", () => {
  it("keeps reusable source bytes intact, passes codecs/overviews, and releases the worker", async () => {
    installWorker();
    const source = Uint8Array.of(1, 2, 3);
    const controller = new AbortController();
    const run = convertGeoTiffToCog(source, {
      compression: "lzw",
      overviews: false,
      float64: true,
      signal: controller.signal,
    });
    const worker = lastWorker();
    assert.match(worker.url.pathname, /cog-convert\.worker\.ts$/);
    assert.equal(worker.options.type, "module");
    assert.deepEqual(source, Uint8Array.of(1, 2, 3));
    assert.deepEqual(worker.request?.bytes, source);
    assert.deepEqual(worker.request?.options, {
      compression: "lzw",
      overviews: false,
      float64: true,
    });
    const result = Uint8Array.of(4, 5);
    worker.answer({ ok: true, bytes: result });
    assert.equal(await run, result);
    assert.ok(worker.terminated);
    assert.equal(worker.onmessage, null);
    controller.abort();
    assert.equal(worker.terminateCalls, 1, "completed run removed its abort listener");
  });

  it("transfers an explicitly owned input without copying", async () => {
    installWorker();
    const source = Uint8Array.of(1, 2, 3);
    const run = convertGeoTiffToCog(source, { transferInput: true });
    assert.equal(source.byteLength, 0);
    assert.deepEqual(lastWorker().request?.bytes, Uint8Array.of(1, 2, 3));
    lastWorker().answer({ ok: true, bytes: Uint8Array.of(4) });
    await run;
  });

  it("copies only a subarray's range without detaching sibling views", async () => {
    installWorker();
    const source = Uint8Array.of(0, 1, 2, 3);
    const run = convertGeoTiffToCog(source.subarray(1, 3), {
      transferInput: true,
    });
    assert.deepEqual(source, Uint8Array.of(0, 1, 2, 3));
    assert.deepEqual(lastWorker().request?.bytes, Uint8Array.of(1, 2));
    lastWorker().answer({ ok: true, bytes: Uint8Array.of(4) });
    await run;
  });

  it("terminates synchronous work on abort and leaves the next conversion independent", async () => {
    installWorker();
    const controller = new AbortController();
    const run = convertGeoTiffToCog(Uint8Array.of(1), {
      signal: controller.signal,
    });
    const first = lastWorker();
    controller.abort();
    await assert.rejects(run, { name: "AbortError" });
    assert.ok(first.terminated);
    const next = convertGeoTiffToCog(Uint8Array.of(2));
    assert.notEqual(lastWorker(), first);
    lastWorker().answer({ ok: true, bytes: Uint8Array.of(3) });
    assert.deepEqual(await next, Uint8Array.of(3));
  });

  it("cancels one concurrent conversion without stopping another", async () => {
    installWorker();
    const controller = new AbortController();
    const first = convertGeoTiffToCog(Uint8Array.of(1), {
      signal: controller.signal,
    });
    const firstWorker = lastWorker();
    const second = convertGeoTiffToCog(Uint8Array.of(2));
    const secondWorker = lastWorker();
    controller.abort();
    await assert.rejects(first, { name: "AbortError" });
    assert.ok(firstWorker.terminated);
    assert.equal(secondWorker.terminated, false);
    secondWorker.answer({ ok: true, bytes: Uint8Array.of(3) });
    assert.deepEqual(await second, Uint8Array.of(3));
    assert.ok(secondWorker.terminated);
  });

  it("does not detach input or retry inline when worker creation fails", async () => {
    globalThis.Worker = class {
      constructor() {
        throw new Error("Worker blocked");
      }
    } as unknown as typeof Worker;
    const source = Uint8Array.of(1, 2);
    await assert.rejects(convertGeoTiffToCog(source, { transferInput: true }), /Worker blocked/);
    assert.equal(source.byteLength, 2);
  });

  it("does not spawn or detach data for a previously cancelled run", async () => {
    installWorker();
    const controller = new AbortController();
    controller.abort();
    const bytes = Uint8Array.of(1);
    await assert.rejects(
      convertGeoTiffToCog(bytes, {
        signal: controller.signal,
        transferInput: true,
      }),
      {
        name: "AbortError",
      },
    );
    assert.equal(FakeWorker.instances.length, 0);
    assert.equal(bytes.byteLength, 1);
  });

  for (const mode of ["engine", "load", "message", "send"] as const) {
    it(`rejects ${mode} errors and releases the worker without running inline`, async () => {
      installWorker();
      if (mode === "send") {
        globalThis.Worker = class extends FakeWorker {
          postMessage() {
            throw new Error("send failed");
          }
        } as unknown as typeof Worker;
      }
      const run = convertGeoTiffToCog(Uint8Array.of(1));
      const worker = lastWorker();
      if (mode === "engine") worker.answer({ ok: false, error: "Unsupported sample format" });
      if (mode === "load")
        worker.onerror?.({
          message: "load failed",
          preventDefault() {},
        } as ErrorEvent);
      if (mode === "message") worker.onmessageerror?.();
      await assert.rejects(run, /Unsupported sample format|load failed|response|send failed/);
      assert.ok(worker.terminated);
    });
  }
});
