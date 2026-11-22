/// <reference lib="webworker" />
// Imported from the reader modules directly, never the package barrel: the
// barrel reaches maplibre-gl, deck.gl and other modules that touch
// window/document while evaluating, which throws in a worker.
import {
  createRangeFile,
  mountLocalFile,
  openAtl03,
  type Atl03Beam,
  type Atl03File,
  type Atl03Photons,
  type Atl03ReadOptions,
} from "@geolibre/plugins/atl03";
import { loadH5wasm } from "@geolibre/plugins/local-netcdf";
import { setH5wasmUrl } from "./h5wasm-url";

/**
 * Hosts the ATL03 photon reader off the main thread.
 *
 * ATL03 granules are 1-7 GB, so the reader opens them lazily: a local File is
 * mounted with WORKERFS (FileReaderSync), a URL is read in byte ranges by
 * synchronous XMLHttpRequest. Both are only allowed in a worker, and both keep
 * the slow, sequential reads off the UI thread. One granule per worker; the
 * client terminates the worker to release it.
 */

/** Where the granule comes from. */
export type Atl03Source =
  | { kind: "file"; file: File }
  | { kind: "url"; url: string; headers?: Record<string, string> };

type Request =
  | { id: number; type: "open"; source: Atl03Source; h5wasmUrl?: string | null }
  | { id: number; type: "read"; options: Atl03ReadOptions };

/** A reply, carrying either the result or the failure's message. */
export type Atl03WorkerResponse =
  | { ready: true }
  /** Bytes returned by one range request, for a progress readout. */
  | { progress: number }
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

let file: Atl03File | null = null;
let dispose: (() => void) | null = null;

async function handle(request: Request): Promise<unknown> {
  switch (request.type) {
    case "open": {
      setH5wasmUrl(request.h5wasmUrl);
      file?.close();
      dispose?.();
      file = null;
      dispose = null;
      const mod = await loadH5wasm();
      const mounted =
        request.source.kind === "file"
          ? mountLocalFile(mod, request.source.file)
          : createRangeFile(mod, request.source.url, {
              headers: request.source.headers,
              onFetch: (bytes) =>
                (self as DedicatedWorkerGlobalScope).postMessage({
                  progress: bytes,
                } satisfies Atl03WorkerResponse),
            });
      dispose = mounted.dispose;
      try {
        file = openAtl03(mod, mounted.path);
      } catch (error) {
        mounted.dispose();
        dispose = null;
        throw error;
      }
      const beams: Atl03Beam[] = file.beams;
      return beams;
    }
    case "read": {
      if (!file) throw new Error("No ATL03 granule is open in this worker.");
      const photons: Atl03Photons = file.readPhotons(request.options);
      return photons;
    }
  }
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data;
  try {
    const result = await handle(request);
    (self as DedicatedWorkerGlobalScope).postMessage({
      id: request.id,
      ok: true,
      result,
    } satisfies Atl03WorkerResponse);
  } catch (error) {
    (self as DedicatedWorkerGlobalScope).postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies Atl03WorkerResponse);
  }
};

// Announce that the module evaluated and the handler is installed, so a module
// that fails to load does not leave the client waiting forever.
(self as DedicatedWorkerGlobalScope).postMessage({ ready: true } satisfies Atl03WorkerResponse);
