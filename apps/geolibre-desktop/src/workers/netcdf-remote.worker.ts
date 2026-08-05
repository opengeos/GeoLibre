/// <reference lib="webworker" />
// Imported from the reader module directly, never the package barrel: the
// barrel reaches maplibre-gl, deck.gl and other modules that touch
// window/document while evaluating, which throws in a worker and leaves this
// file never installing its message handler.
import {
  openRemoteNetcdf,
  type LocalNetcdfAxis,
  type LocalNetcdfFile,
  type LocalNetcdfGrid,
  type LocalNetcdfProfile,
  type LocalNetcdfVariable,
} from "@geolibre/plugins/local-netcdf";

/**
 * Hosts {@link openRemoteNetcdf} off the main thread.
 *
 * The lazy filesystem it uses reads by **synchronous** `XMLHttpRequest`, which
 * browsers permit only in a worker, so this file exists to give it somewhere
 * legal to run. That also keeps the long latency-bound reads (a band plane of a
 * 1.1 GB cube is ~20 s of sequential range requests) off the UI thread.
 *
 * One file per worker: the caller creates a worker per remote dataset and
 * terminates it to release the mount.
 */

/** A request from the client, tagged so replies can be matched to it. */
type Request =
  | { id: number; type: "open"; url: string }
  | { id: number; type: "listAxes"; variable: string }
  | { id: number; type: "readGrid"; variable: string; selector: Record<string, number> }
  | {
      id: number;
      type: "readProfile";
      variable: string;
      axis: string;
      row: number;
      column: number;
      selector: Record<string, number>;
    };

/** A reply, carrying either the result or the failure's message. */
export type NetcdfWorkerResponse =
  | { ready: true }
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

let file: LocalNetcdfFile | null = null;

/** The open file, or a thrown explanation when `open` has not run. */
function requireFile(): LocalNetcdfFile {
  if (!file) throw new Error("No remote NetCDF file is open in this worker.");
  return file;
}

async function handle(request: Request): Promise<unknown> {
  switch (request.type) {
    case "open": {
      file?.close();
      file = await openRemoteNetcdf(request.url);
      const variables: LocalNetcdfVariable[] = file.listVariables();
      return variables;
    }
    case "listAxes": {
      const axes: LocalNetcdfAxis[] = requireFile().listAxes(request.variable);
      return axes;
    }
    case "readGrid": {
      const grid: LocalNetcdfGrid = requireFile().readGrid(request.variable, request.selector);
      return grid;
    }
    case "readProfile": {
      const profile: LocalNetcdfProfile = requireFile().readProfile(request.variable, {
        axis: request.axis,
        row: request.row,
        column: request.column,
        selector: request.selector,
      });
      return profile;
    }
  }
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data;
  try {
    const result = await handle(request);
    // The typed arrays in a grid are the bulk of the payload; hand their buffers
    // over rather than structured-cloning tens of megabytes.
    const transfer =
      request.type === "readGrid"
        ? [
            (result as LocalNetcdfGrid).values.buffer,
            (result as LocalNetcdfGrid).lat.buffer,
            (result as LocalNetcdfGrid).lon.buffer,
          ].filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer)
        : [];
    (self as DedicatedWorkerGlobalScope).postMessage(
      { id: request.id, ok: true, result } satisfies NetcdfWorkerResponse,
      transfer,
    );
  } catch (error) {
    (self as DedicatedWorkerGlobalScope).postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies NetcdfWorkerResponse);
  }
};

// Announce that the module evaluated and the handler is installed. Without this
// a module that fails to load would leave the client waiting on a reply that can
// never come, which reads as a dialog stuck on "Loading...".
(self as DedicatedWorkerGlobalScope).postMessage({ ready: true } satisfies NetcdfWorkerResponse);
