import type {
  LocalNetcdfAxis,
  LocalNetcdfGrid,
  LocalNetcdfProfile,
  LocalNetcdfVariable,
  LocalNetcdfWindow,
} from "@geolibre/plugins";
import type { NetcdfWorkerResponse } from "../workers/netcdf-remote.worker";

/**
 * A remote NetCDF/HDF file read over HTTP by range request, through a worker.
 *
 * The same operations as the local reader, but asynchronous: every call is a
 * round trip to the worker that owns the mount. Reads are latency-bound (see
 * `openRemoteNetcdf`), so callers should show progress rather than assume these
 * return promptly.
 */
export interface RemoteNetcdfFile {
  /** Renderable variables, read from the file's metadata alone. */
  variables: LocalNetcdfVariable[];
  /** The variable's leading axes, with coordinate values where present. */
  listAxes(variable: string): Promise<LocalNetcdfAxis[]>;
  /** One 2-D slice plus its coordinates and packing, optionally windowed. */
  readGrid(
    variable: string,
    selector?: Record<string, number>,
    window?: LocalNetcdfWindow,
  ): Promise<LocalNetcdfGrid>;
  /** One pixel's values along a leading axis. */
  readProfile(
    variable: string,
    options: { axis: string; row: number; column: number; selector?: Record<string, number> },
  ): Promise<LocalNetcdfProfile>;
  /** Terminate the worker, releasing the mount. */
  close(): void;
}

/**
 * How long to wait for the worker to report that its module evaluated. Only a
 * load failure takes longer than a moment, and without a bound that failure is
 * indistinguishable from a slow open.
 */
const WORKER_READY_TIMEOUT_MS = 20_000;

/** Extensions that name a file this reader can open. */
const REMOTE_EXTENSIONS = [".nc", ".nc4", ".h5", ".hdf5", ".cdf"];

/**
 * Whether a URL looks like a NetCDF/HDF file rather than a kerchunk manifest.
 *
 * Decided from the path alone: the dialog has to route the input before it can
 * fetch anything, and a HEAD would cost a round trip on every keystroke. Query
 * strings (a presigned URL) are ignored.
 *
 * @param url - The URL the user entered.
 * @returns True when it names a NetCDF/HDF file.
 */
export function isNetcdfFileUrl(url: string): boolean {
  let path = url.trim();
  try {
    path = new URL(path).pathname;
  } catch {
    // Not absolute; fall back to trimming any query/fragment by hand.
    path = path.split(/[?#]/)[0];
  }
  const lower = path.toLowerCase();
  return REMOTE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * Open a remote NetCDF/HDF file for range-request reading.
 *
 * @param url - The file's URL. Its server must allow cross-origin range requests.
 * @returns The open file; call {@link RemoteNetcdfFile.close} to release it.
 * @throws If the worker cannot open the URL as HDF5.
 */
export async function openRemoteNetcdfFile(url: string): Promise<RemoteNetcdfFile> {
  const worker = new Worker(new URL("../workers/netcdf-remote.worker.ts", import.meta.url), {
    type: "module",
  });

  let nextId = 0;
  const pending = new Map<
    number,
    { resolve: (value: never) => void; reject: (e: Error) => void }
  >();
  /**
   * Why the worker is gone, once it is.
   *
   * Rejecting only what is already pending is not enough: a cube read yields to
   * the event loop between planes, so a close can land in that gap and the
   * *next* plane would then register a fresh request against a terminated
   * worker — the same silent hang, one plane later. This latch makes every read
   * after the end fail immediately instead.
   */
  let terminalError: Error | null = null;

  let markReady: (() => void) | null = null;
  // Kept so `onerror` can fail the startup wait itself. A module-load failure
  // happens before the first `send()`, when `pending` is still empty, so
  // rejecting only pending entries would leave the dialog sitting out the whole
  // ready timeout for a failure already known.
  let failStartup: ((error: Error) => void) | null = null;
  let readyTimer: number | null = null;
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    failStartup = reject;
    readyTimer = window.setTimeout(
      () => reject(new Error("The NetCDF reader worker did not start.")),
      WORKER_READY_TIMEOUT_MS,
    );
  });

  /** Settle the startup wait once, releasing its timer. */
  const settleReady = (error?: Error): void => {
    if (readyTimer !== null) {
      window.clearTimeout(readyTimer);
      readyTimer = null;
    }
    if (error) failStartup?.(error);
    else markReady?.();
    markReady = null;
    failStartup = null;
  };

  worker.onmessage = (event: MessageEvent<NetcdfWorkerResponse>) => {
    if ("ready" in event.data) {
      settleReady();
      return;
    }
    const entry = pending.get(event.data.id);
    if (!entry) return;
    pending.delete(event.data.id);
    if (event.data.ok) entry.resolve(event.data.result as never);
    else entry.reject(new Error(event.data.error));
  };
  /** Fail everything outstanding, refuse everything later, and let the worker go. */
  const shutDown = (error: Error): void => {
    if (terminalError) return;
    terminalError = error;
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
    worker.terminate();
  };

  worker.onerror = (event) => {
    // A worker-level failure (a bad module load) never resolves the in-flight
    // request, so fail them all rather than hanging the dialog — and the startup
    // wait too, in case the failure landed before the first request.
    const error = new Error(event.message || "The NetCDF reader worker failed.");
    settleReady(error);
    // Nothing can be read through it again — every later `send` would hang on a
    // reply that cannot come — and it owns a lazy-filesystem mount, so let it go
    // rather than leaking it for the rest of the session. A `close()` after this
    // is harmless: `shutDown` is idempotent.
    shutDown(error);
  };

  const send = <T>(message: Record<string, unknown>): Promise<T> => {
    if (terminalError) return Promise.reject(terminalError);
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: never) => void, reject });
      worker.postMessage({ ...message, id });
    });
  };

  try {
    await ready;
    const variables = await send<LocalNetcdfVariable[]>({ type: "open", url });
    return {
      variables,
      listAxes: (variable) => send<LocalNetcdfAxis[]>({ type: "listAxes", variable }),
      readGrid: (variable, selector = {}, window) =>
        send<LocalNetcdfGrid>({ type: "readGrid", variable, selector, window }),
      readProfile: (variable, options) =>
        send<LocalNetcdfProfile>({
          type: "readProfile",
          variable,
          axis: options.axis,
          row: options.row,
          column: options.column,
          selector: options.selector ?? {},
        }),
      // Fail the reads rather than just terminating. `terminate()` silently
      // drops replies, so a caller awaiting one would otherwise wait forever: a
      // cube read issues dozens of sequential `readGrid` calls, and closing the
      // layer (or opening a second cube, which releases the first file) lands
      // in the middle of one. The read loop would hang with its progress bar
      // frozen and its abort checks never reached.
      close: () => shutDown(new Error("The NetCDF reader worker was closed.")),
    };
  } catch (error) {
    worker.terminate();
    throw error;
  }
}
