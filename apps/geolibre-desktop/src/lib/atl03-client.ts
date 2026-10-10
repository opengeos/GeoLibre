import {
  mergeAtl03Photons,
  type Atl03Beam,
  type Atl03Photons,
  type Atl03ReadOptions,
} from "@geolibre/plugins/atl03";
import type { Atl03Source, Atl03WorkerResponse } from "../workers/atl03.worker";
import { h5wasmChunkUrl } from "./h5wasm-chunk-url";

/** An ATL03 granule opened lazily in one or more workers. */
export interface Atl03Granule {
  beams: Atl03Beam[];
  /**
   * Read the photons of an area.
   *
   * @param options What to read.
   * @param onProgress Called with the total bytes fetched so far (remote only).
   */
  readPhotons(
    options: Atl03ReadOptions,
    onProgress?: (bytes: number) => void,
  ): Promise<Atl03Photons>;
  /** Terminate the workers, releasing the granule. */
  close(): void;
}

/** How long to wait for a worker module to evaluate before calling it failed. */
const WORKER_READY_TIMEOUT_MS = 20_000;
/**
 * Workers reading a remote granule at once. Each range request to NASA's
 * storage costs about half a second and synchronous reads cannot overlap, so
 * splitting the beams across workers is what makes a remote read interactive.
 */
const REMOTE_WORKERS = 6;

/** One worker holding the granule open. */
interface ReaderWorker {
  beams: Atl03Beam[];
  read(options: Atl03ReadOptions): Promise<Atl03Photons>;
  /** Receives the bytes of each range request this worker makes. */
  onFetch: ((bytes: number) => void) | null;
  close(): void;
}

async function spawnReader(source: Atl03Source): Promise<ReaderWorker> {
  const worker = new Worker(new URL("../workers/atl03.worker.ts", import.meta.url), {
    type: "module",
  });
  let nextId = 0;
  const pending = new Map<
    number,
    { resolve: (value: never) => void; reject: (e: Error) => void }
  >();
  let terminalError: Error | null = null;
  let settleReady: ((error?: Error) => void) | null = null;
  const ready = new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error("The ATL03 reader worker did not start.")),
      WORKER_READY_TIMEOUT_MS,
    );
    settleReady = (error) => {
      window.clearTimeout(timer);
      if (error) reject(error);
      else resolve();
      settleReady = null;
    };
  });
  const reader: ReaderWorker = {
    beams: [],
    read: () => Promise.reject(new Error("not open")),
    onFetch: null,
    close: () => shutDown(new Error("The ATL03 reader worker was closed.")),
  };
  const shutDown = (error: Error): void => {
    if (terminalError) return;
    terminalError = error;
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
    worker.terminate();
  };
  worker.onmessage = (event: MessageEvent<Atl03WorkerResponse>) => {
    const data = event.data;
    if ("ready" in data) {
      settleReady?.();
      return;
    }
    if ("progress" in data) {
      reader.onFetch?.(data.progress);
      return;
    }
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.ok) entry.resolve(data.result as never);
    else entry.reject(new Error(data.error));
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || "The ATL03 reader worker failed.");
    settleReady?.(error);
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
    reader.beams = await send<Atl03Beam[]>({ type: "open", source, h5wasmUrl: h5wasmChunkUrl });
    reader.read = (options) => send<Atl03Photons>({ type: "read", options });
    return reader;
  } catch (error) {
    worker.terminate();
    throw error;
  }
}

/**
 * Split beams into at most `parts` contiguous groups, keeping beam order so
 * the merged photons stay grouped by beam.
 */
export function splitBeams(beams: string[], parts: number): string[][] {
  const count = Math.max(1, Math.min(parts, beams.length));
  const groups: string[][] = [];
  for (let i = 0; i < count; i += 1) {
    groups.push(
      beams.slice(
        Math.floor((i * beams.length) / count),
        Math.floor(((i + 1) * beams.length) / count),
      ),
    );
  }
  return groups.filter((group) => group.length > 0);
}

/**
 * Open an ATL03 granule in a worker, from a local File or a URL that serves
 * byte ranges with CORS (the Earthdata relay for NASA granules). A remote
 * granule's photons are read by several workers in parallel, one group of
 * beams each.
 *
 * @param source The granule's source.
 * @returns The open granule; call {@link Atl03Granule.close} to release it.
 * @throws If the worker cannot open it as ATL03.
 */
export async function openAtl03Granule(source: Atl03Source): Promise<Atl03Granule> {
  const primary = await spawnReader(source);
  const helpers: Promise<ReaderWorker>[] = [];
  let closed = false;
  return {
    beams: primary.beams,
    async readPhotons(options, onProgress) {
      const beams = options.beams ?? primary.beams.map((beam) => beam.name);
      const groups = source.kind === "url" ? splitBeams(beams, REMOTE_WORKERS) : [beams];
      // Open the extra readers on the first read (each opens the file once).
      while (helpers.length < groups.length - 1) helpers.push(spawnReader(source));
      const readers = [primary, ...(await Promise.all(helpers.slice(0, groups.length - 1)))];
      if (closed) throw new Error("The ATL03 granule was closed.");
      let bytes = 0;
      for (const reader of readers) {
        reader.onFetch = (n) => {
          bytes += n;
          onProgress?.(bytes);
        };
      }
      try {
        const parts = await Promise.all(
          groups.map((group, i) => readers[i].read({ ...options, beams: group, maxPoints: 0 })),
        );
        return mergeAtl03Photons(parts, options.maxPoints);
      } finally {
        for (const reader of readers) reader.onFetch = null;
      }
    },
    close() {
      closed = true;
      primary.close();
      for (const helper of helpers)
        void helper.then(
          (reader) => reader.close(),
          () => undefined,
        );
    },
  };
}
