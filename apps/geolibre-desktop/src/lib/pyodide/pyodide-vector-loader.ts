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
// large enough for slow connections, small enough to escape a dead CDN. This
// guards initialization only — a run itself is not timed, since geoprocessing
// can legitimately take a while.
const PYODIDE_INIT_TIMEOUT_MS = 120_000;

interface PendingRun {
  resolve: (result: VectorToolResult) => void;
  reject: (error: Error) => void;
}

interface WorkerHandle {
  worker: Worker;
  /** Resolves when the runtime + GeoPandas have finished loading. */
  ready: Promise<void>;
}

let handlePromise: Promise<WorkerHandle> | null = null;
let nextRunId = 0;
const pending = new Map<number, PendingRun>();
const progressListeners = new Set<ProgressListener>();
let lastPhase: string | null = null;

/**
 * Subscribe to Pyodide load-progress phases ("Downloading Python runtime",
 * "Loading GeoPandas"). Fires immediately with the last known phase if loading
 * is already in flight. Returns an unsubscribe function.
 */
export function onPyodideProgress(listener: ProgressListener): () => void {
  progressListeners.add(listener);
  if (lastPhase) listener(lastPhase);
  return () => progressListeners.delete(listener);
}

function emitProgress(phase: string): void {
  lastPhase = phase;
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
    const failWorker = (message: string) => {
      if (initTimer) clearTimeout(initTimer);
      worker.terminate();
      handlePromise = null;
      lastPhase = null;
      for (const [id, run] of pending) {
        pending.delete(id);
        run.reject(new Error(message));
      }
    };

    // Bound the one-time runtime download/init so a hung or unreachable CDN
    // cannot leave the dialog spinning forever; clears once the worker is ready.
    initTimer = setTimeout(() => {
      const message =
        "Timed out loading the Python runtime. Check your connection and try again.";
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
          // Clear the last phase so a later subscriber (a warm re-run) is not
          // replayed a stale "Loading…" line after loading has finished.
          if (initTimer) clearTimeout(initTimer);
          lastPhase = null;
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

  return ready.then(() => ({ worker, ready }));
}

function getHandle(): Promise<WorkerHandle> {
  // Clear the memo on failure so a later call re-initializes (cf.
  // ensureSpatialExtension in duckdb-vector-loader.ts).
  handlePromise ??= createHandle().catch((error) => {
    handlePromise = null;
    lastPhase = null;
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
    pending.set(id, { resolve, reject });
    worker.postMessage({ type: "run", id, request });
  });
}
