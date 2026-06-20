/// <reference lib="webworker" />
import { parseOsmPbf } from "./osm-pbf";

// Parses OSM PBF bytes off the main thread (parsing a large extract can take
// seconds and allocate a lot of memory). Receives the file's ArrayBuffer and
// posts back the split GeoJSON layers, or an error message.
const worker = self as unknown as DedicatedWorkerGlobalScope;

worker.addEventListener("message", async (event: MessageEvent<ArrayBuffer>) => {
  try {
    const result = await parseOsmPbf(new Uint8Array(event.data), (progress) => {
      // Posted while the synchronous classification loop runs; the main thread
      // is free (parsing is here, off it) so these surface as live progress.
      worker.postMessage({ type: "progress", ...progress });
    });
    worker.postMessage({ ok: true, result });
  } catch (error) {
    worker.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
