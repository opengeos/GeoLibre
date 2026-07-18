import type { VectorToolRequest, VectorToolResult } from "@geolibre/processing";
import vectorOpsSource from "./vector_ops.generated.py?raw";
import { getPyodideIndexUrl } from "./pyodide-config";

// In-browser GeoPandas/Shapely vector engine, backed by Pyodide running in a
// classic Web Worker. Mirrors the memoized-singleton pattern of
// duckdb-vector-loader.ts: the worker (and the multi-MB Pyodide download) is
// created lazily on first use and reused for every subsequent run. The worker
// runs the exact backend `vector_ops.py` (loaded here via ?raw and handed over
// in the init message), so results match the "Sidecar (GeoPandas)" engine.

type ProgressListener = (phase: string) => void;

// Generous bound on the one-time runtime download (tens of MB on a cold cache);
// large enough for slow connections, small enough to escape a dead CDN.
const PYODIDE_INIT_TIMEOUT_MS = 120_000;

// Per-run wall-clock bound so a pathological operation (e.g. one that exhausts
// WASM memory without raising) can't leave the dialog stuck on "Running…"
// forever. Generous, since MAX_FEATURES already caps the input size. On expiry
// the worker is torn down and the next run re-initializes.
const PYODIDE_RUN_TIMEOUT_MS = 300_000;

interface PendingRun {
  resolve: (result: VectorToolResult) => void;
  reject: (error: Error) => void;
}

interface WorkerHandle {
  worker: Worker;
}

let handlePromise: Promise<WorkerHandle> | null = null;
let nextRunId = 0;
const pending = new Map<number, PendingRun>();
const progressListeners = new Set<ProgressListener>();

/**
 * Subscribe to Pyodide load-progress phases ("Downloading Python runtime",
 * "Loading GeoPandas") as they happen. Returns an unsubscribe function.
 *
 * Phases are delivered live only — there is no replay of an already-emitted
 * phase, so a subscriber sees the chronological order alongside its own log
 * lines (a subscriber that attaches mid-init simply picks up the next phase).
 */
export function onPyodideProgress(listener: ProgressListener): () => void {
  progressListeners.add(listener);
  return () => progressListeners.delete(listener);
}

function emitProgress(phase: string): void {
  for (const listener of progressListeners) listener(phase);
}

function workerUrl(): string {
  // public/ assets are served under the app base path; BASE_URL ends with "/".
  return `${import.meta.env.BASE_URL}pyodide/pyodide-worker.js`;
}

function createHandle(): Promise<WorkerHandle> {
  const worker = new Worker(workerUrl());
  const ready = new Promise<void>((resolve, reject) => {
    // A fatal worker failure (failed init, or a crash after init): tear down
    // the dead worker, drop the cached singleton so the next call rebuilds it,
    // and fail every in-flight run so nothing hangs behind a broken worker.
    let initTimer: ReturnType<typeof setTimeout> | undefined;
    // Both the init "error" message and worker.onerror can fire for the same
    // failure; the guard makes the second call a no-op.
    let settled = false;
    const failWorker = (message: string) => {
      if (settled) return;
      settled = true;
      if (initTimer) clearTimeout(initTimer);
      worker.terminate();
      handlePromise = null;
      for (const [id, run] of pending) {
        pending.delete(id);
        run.reject(new Error(message));
      }
    };

    // Bound the one-time runtime download/init so a hung or unreachable CDN
    // cannot leave the dialog spinning forever; clears once the worker is ready.
    initTimer = setTimeout(() => {
      const message = "Timed out loading the Python runtime. Check your connection and try again.";
      failWorker(message);
      reject(new Error(message));
    }, PYODIDE_INIT_TIMEOUT_MS);

    worker.onmessage = (event: MessageEvent) => {
      const data = event.data ?? {};
      switch (data.type) {
        case "progress":
          emitProgress(data.phase);
          break;
        case "ready":
          // Note: do not set `settled` here — a crash after init must still be
          // able to run failWorker(). The init timer is no longer relevant.
          if (initTimer) clearTimeout(initTimer);
          resolve();
          break;
        case "result": {
          const run = pending.get(data.id);
          if (run) {
            pending.delete(data.id);
            run.resolve({ geojson: data.geojson, messages: data.messages });
          }
          break;
        }
        case "error": {
          const message = data.message || "Pyodide error";
          if (data.id === undefined) {
            // An init failure (no run id): tear down and fail any in-flight runs.
            failWorker(message);
            reject(new Error(message));
          } else {
            const run = pending.get(data.id);
            if (run) {
              pending.delete(data.id);
              run.reject(new Error(message));
            }
          }
          break;
        }
        default:
          break;
      }
    };
    worker.onerror = (event) => {
      const message = event.message || "Pyodide worker failed";
      failWorker(message);
      reject(new Error(message));
    };
  });

  worker.postMessage({
    type: "init",
    indexURL: getPyodideIndexUrl(),
    vectorOpsSource,
  });

  return ready.then(() => ({ worker }));
}

function getHandle(): Promise<WorkerHandle> {
  // Clear the memo on failure so a later call re-initializes (cf.
  // ensureSpatialExtension in duckdb-vector-loader.ts).
  handlePromise ??= createHandle().catch((error) => {
    handlePromise = null;
    throw error;
  });
  return handlePromise;
}

/**
 * Run a single vector tool in the browser via Pyodide (GeoPandas/Shapely).
 *
 * On first call this downloads and initializes the Python runtime (reported via
 * onPyodideProgress); subsequent calls reuse the warm worker.
 *
 * Args:
 *   request: The tool request ({tool_id, geojson, overlay?, parameters?}),
 *     identical to the sidecar's `runVectorTool` contract.
 *
 * Returns:
 *   The resulting GeoJSON FeatureCollection plus log messages.
 */
export async function runVectorToolInPyodide(
  request: VectorToolRequest,
): Promise<VectorToolResult> {
  const { worker } = await getHandle();
  const id = nextRunId++;
  return new Promise<VectorToolResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      // Presume the worker is wedged: tear it down so the next run re-inits,
      // and fail any other in-flight runs too.
      worker.terminate();
      handlePromise = null;
      for (const [otherId, run] of pending) {
        pending.delete(otherId);
        run.reject(new Error("Pyodide worker was reset after a timeout."));
      }
      reject(new Error("The Python (Pyodide) operation timed out."));
    }, PYODIDE_RUN_TIMEOUT_MS);
    // Wrap the callbacks so the timer is always cleared, whether the run
    // resolves, errors, or is rejected by failWorker on a crash.
    pending.set(id, {
      resolve: (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    worker.postMessage({ type: "run", id, request });
  });
}
