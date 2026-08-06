import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isNetcdfFileUrl,
  openRemoteNetcdfFile,
} from "../apps/geolibre-desktop/src/lib/netcdf-remote-client";

/**
 * Run `body` with a stub `Worker` and the `window` timer functions the client
 * uses, restoring both afterwards. Node has neither.
 *
 * @param WorkerStub - The constructor to answer `new Worker(...)` with.
 * @param body - Receives the ids passed to `window.clearTimeout`.
 */
async function withWorkerStub(
  WorkerStub: unknown,
  body: (cleared: number[]) => Promise<void>,
): Promise<void> {
  const globals = globalThis as Record<string, unknown>;
  const had = { window: "window" in globals, Worker: "Worker" in globals };
  const previous = { window: globals.window, Worker: globals.Worker };
  const cleared: number[] = [];
  globals.window = {
    setTimeout: (fn: () => void, ms?: number) => Number(setTimeout(fn, ms)),
    clearTimeout: (id: number) => {
      cleared.push(id);
      clearTimeout(id);
    },
  };
  globals.Worker = WorkerStub;
  try {
    await body(cleared);
  } finally {
    if (had.window) globals.window = previous.window;
    else delete globals.window;
    if (had.Worker) globals.Worker = previous.Worker;
    else delete globals.Worker;
  }
}

describe("isNetcdfFileUrl", () => {
  it("recognizes the NetCDF/HDF extensions the reader opens", () => {
    for (const extension of ["nc", "nc4", "h5", "hdf5", "cdf"]) {
      assert.equal(isNetcdfFileUrl(`https://example.com/data/scene.${extension}`), true, extension);
    }
  });

  it("ignores a query string, so a presigned URL still routes", () => {
    assert.equal(
      isNetcdfFileUrl("https://example.com/scene.nc?X-Amz-Signature=abc&X-Amz-Expires=900"),
      true,
    );
    assert.equal(isNetcdfFileUrl("https://example.com/scene.nc#band=1"), true);
  });

  it("is case-insensitive", () => {
    assert.equal(isNetcdfFileUrl("https://example.com/SCENE.NC"), true);
  });

  it("rejects a kerchunk manifest, which goes to the reference loader instead", () => {
    assert.equal(isNetcdfFileUrl("https://example.com/air-temperature.kerchunk.json"), false);
  });

  it("rejects other stores and unrelated URLs", () => {
    assert.equal(isNetcdfFileUrl("https://example.com/store.zarr"), false);
    assert.equal(isNetcdfFileUrl("https://example.com/scene.tif"), false);
    assert.equal(isNetcdfFileUrl("https://example.com/"), false);
  });

  it("tolerates a relative path with no parseable origin", () => {
    assert.equal(isNetcdfFileUrl("/data/scene.nc"), true);
    assert.equal(isNetcdfFileUrl("  /data/scene.nc?v=2  "), true);
  });

  it("does not match an extension that merely appears mid-path", () => {
    assert.equal(isNetcdfFileUrl("https://example.com/nc/readme.txt"), false);
  });
});

describe("openRemoteNetcdfFile startup", () => {
  it("fails as soon as the worker errors, without waiting out the ready timeout", async () => {
    /** A worker whose module fails to load: it errors before any request is sent. */
    class FailingWorker {
      onmessage: ((event: unknown) => void) | null = null;
      onerror: ((event: { message: string }) => void) | null = null;
      terminated = false;
      constructor() {
        // After the caller has attached its handlers, as a real load failure is.
        setTimeout(() => this.onerror?.({ message: "module load failed" }), 0);
      }
      postMessage(): void {}
      terminate(): void {
        this.terminated = true;
      }
    }

    await withWorkerStub(FailingWorker, async () => {
      const started = Date.now();
      await assert.rejects(
        openRemoteNetcdfFile("https://example.com/scene.nc"),
        /module load failed/,
      );
      // The readiness timeout is 20 s; the point of the fix is not paying it for a
      // failure already reported. `pending` is still empty at this stage, so
      // rejecting only pending requests would leave nothing to reject.
      assert.ok(Date.now() - started < 2_000, `took ${Date.now() - started}ms`);
    });
  });

  it("releases the readiness timer once the worker reports ready", async () => {
    /** A worker that starts normally and answers `open` with no variables. */
    class ReadyWorker {
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: ((event: { message: string }) => void) | null = null;
      constructor() {
        setTimeout(() => this.onmessage?.({ data: { ready: true } }), 0);
      }
      postMessage(message: { id: number }): void {
        setTimeout(() => this.onmessage?.({ data: { id: message.id, ok: true, result: [] } }), 0);
      }
      terminate(): void {}
    }

    await withWorkerStub(ReadyWorker, async (cleared) => {
      const file = await openRemoteNetcdfFile("https://example.com/scene.nc");
      assert.deepEqual(file.variables, []);
      // Left armed, the timer would reject an already-resolved promise 20 s later
      // and hold the event loop open for that long.
      assert.equal(cleared.length, 1);
      file.close();
    });
  });

  it("fails the in-flight reads when the file is closed", async () => {
    /** A worker that answers `open` but never replies to anything after it. */
    class SilentWorker {
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: ((event: { message: string }) => void) | null = null;
      terminated = false;
      constructor() {
        setTimeout(() => this.onmessage?.({ data: { ready: true } }), 0);
      }
      postMessage(message: { id: number; type: string }): void {
        if (message.type !== "open") return;
        setTimeout(() => this.onmessage?.({ data: { id: message.id, ok: true, result: [] } }), 0);
      }
      terminate(): void {
        this.terminated = true;
      }
    }

    await withWorkerStub(SilentWorker, async () => {
      const file = await openRemoteNetcdfFile("https://example.com/scene.nc");
      const inFlight = file.readGrid("reflectance");
      // A cube read issues dozens of these in sequence, and closing the layer
      // (or opening a second cube, which releases the first file) lands in the
      // middle of one. `terminate()` drops the reply, so without rejecting here
      // the awaiting read would hang forever with its progress bar frozen and
      // its abort checks never reached.
      file.close();
      await assert.rejects(inFlight, /closed/);
    });
  });

  it("fails a read that starts after the file is closed", async () => {
    /** A worker that answers `open` but never replies to anything after it. */
    class SilentWorker {
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: ((event: { message: string }) => void) | null = null;
      constructor() {
        setTimeout(() => this.onmessage?.({ data: { ready: true } }), 0);
      }
      postMessage(message: { id: number; type: string }): void {
        if (message.type !== "open") return;
        setTimeout(() => this.onmessage?.({ data: { id: message.id, ok: true, result: [] } }), 0);
      }
      terminate(): void {}
    }

    await withWorkerStub(SilentWorker, async () => {
      const file = await openRemoteNetcdfFile("https://example.com/scene.nc");
      file.close();
      // Rejecting what was already pending is not enough on its own: a cube
      // read yields to the event loop between planes, so a close lands in that
      // gap and the next plane would register a fresh request against a worker
      // that is already gone — the same hang, one plane later.
      await assert.rejects(file.readGrid("reflectance"), /closed/);
      await assert.rejects(file.listAxes("reflectance"), /closed/);
    });
  });
});
