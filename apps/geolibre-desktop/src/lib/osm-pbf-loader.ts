import type { OsmPbfLayers, OsmPbfProgress } from "./osm-pbf";

export type { OsmPbfLayers, OsmPbfProgress } from "./osm-pbf";

/**
 * Thrown when a parse exceeds {@link OSM_PBF_PARSE_TIMEOUT_MS} or the worker
 * dies (typically a silent out-of-memory kill on a whole-country extract). The
 * UI maps this to an actionable "the extract is too large" message rather than
 * the generic parse-failure hint.
 */
export class OsmPbfTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OsmPbfTooLargeError";
  }
}

/**
 * Files at or above this size prompt a confirmation before parsing: a
 * whole-region OSM extract can exhaust browser memory even off the main thread.
 */
export const OSM_PBF_SIZE_WARN_BYTES = 50 * 1024 * 1024; // 50 MB

// Hard cap so a worker that the browser silently OOM-kills (firing no event)
// cannot leave the promise — and the loading dialog — pending forever. Whole-
// country extracts can take a couple of minutes, so the cap is generous.
const OSM_PBF_PARSE_TIMEOUT_MS = 5 * 60 * 1000;

// Trade-off: a bare ".pbf" also names Mapbox Vector Tiles (protobuf-encoded
// tiles), so dragging an MVT ".pbf" file routes it here and produces an OSM
// parse error. We accept the rare collision because most OSM extracts (and the
// ones users drag in) are named ".osm.pbf" or ".pbf"; vector tiles are normally
// served as tiles, not dropped as files.
const OSM_PBF_EXTENSIONS = [".osm.pbf", ".pbf"];

/** Does this file name look like an OSM PBF file? */
export function isOsmPbfFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return OSM_PBF_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Strip the .osm.pbf / .pbf extension to get a base layer name. */
export function osmPbfBaseName(name: string): string {
  const lower = name.toLowerCase();
  for (const ext of OSM_PBF_EXTENSIONS) {
    if (lower.endsWith(ext)) return name.slice(0, name.length - ext.length);
  }
  return name;
}

/**
 * Add the non-empty split layers to the map as separate GeoJSON layers, named
 * "<base> polygons/lines/points". Polygons go in first and points last so
 * points render on top. Returns the number of layers added.
 */
export function addOsmPbfLayers(
  addGeoJsonLayer: (
    name: string,
    geojson: OsmPbfLayers["points"],
    sourcePath?: string,
  ) => unknown,
  baseName: string,
  sourcePath: string,
  layers: OsmPbfLayers,
): number {
  let added = 0;
  const groups: Array<[string, OsmPbfLayers["points"]]> = [
    ["polygons", layers.polygons],
    ["lines", layers.lines],
    ["points", layers.points],
  ];
  for (const [suffix, collection] of groups) {
    if (collection.features.length === 0) continue;
    addGeoJsonLayer(`${baseName} ${suffix}`, collection, sourcePath);
    added += 1;
  }
  return added;
}

interface OsmPbfWorkerSuccess {
  ok: true;
  result: OsmPbfLayers;
}
interface OsmPbfWorkerFailure {
  ok: false;
  error: string;
}
interface OsmPbfWorkerProgress extends OsmPbfProgress {
  type: "progress";
}
type OsmPbfWorkerMessage =
  | OsmPbfWorkerSuccess
  | OsmPbfWorkerFailure
  | OsmPbfWorkerProgress;

/**
 * Parse OSM PBF bytes into split GeoJSON layers on a Web Worker. The buffer is
 * transferred (not copied) to the worker; do not reuse it after calling.
 *
 * @param onProgress - Called as the worker classifies entities, so the UI can
 *   show that a large extract is still progressing rather than appearing frozen.
 */
export function loadOsmPbf(
  bytes: ArrayBuffer,
  signal?: AbortSignal,
  onProgress?: (progress: OsmPbfProgress) => void,
): Promise<OsmPbfLayers> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("OSM PBF load aborted.", "AbortError"));
      return;
    }
    const worker = new Worker(
      new URL("./osm-pbf.worker.ts", import.meta.url),
      { type: "module" },
    );
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new OsmPbfTooLargeError("OSM PBF parsing timed out."));
    }, OSM_PBF_PARSE_TIMEOUT_MS);
    const onAbort = () => {
      finish();
      reject(new DOMException("OSM PBF load aborted.", "AbortError"));
    };
    const finish = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.addEventListener(
      "message",
      (event: MessageEvent<OsmPbfWorkerMessage>) => {
        const data = event.data;
        // The terminal message (success or failure) is the one carrying `ok`;
        // identify it by that so a future field can't be mistaken for it.
        if (data && "ok" in data) {
          finish();
          if (data.ok) resolve(data.result);
          else
            reject(new Error(data.error || "Could not parse the OSM PBF file."));
          return;
        }
        // Anything else is a progress update streamed before the terminal
        // message; forward it and keep the worker alive.
        if (data && "type" in data && data.type === "progress") {
          onProgress?.({ processed: data.processed, total: data.total });
        }
      },
    );
    worker.addEventListener("error", (event) => {
      finish();
      reject(new Error(event.message || "The OSM PBF worker failed."));
    });
    // `error` does not fire if the worker is OOM-killed or the response message
    // fails to deserialize; messageerror covers the latter and the timeout above
    // covers a silent OOM kill, so the promise can't hang forever.
    worker.addEventListener("messageerror", () => {
      finish();
      reject(new Error("The OSM PBF worker posted an undeserializable message."));
    });
    worker.postMessage(bytes, [bytes]);
  });
}
