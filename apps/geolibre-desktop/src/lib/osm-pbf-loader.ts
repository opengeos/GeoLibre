import type { OsmPbfLayers } from "./osm-pbf";

export type { OsmPbfLayers } from "./osm-pbf";

/**
 * Files at or above this size prompt a confirmation before parsing: a
 * whole-region OSM extract can exhaust browser memory even off the main thread.
 */
export const OSM_PBF_SIZE_WARN_BYTES = 50 * 1024 * 1024; // 50 MB

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
type OsmPbfWorkerMessage = OsmPbfWorkerSuccess | OsmPbfWorkerFailure;

/**
 * Parse OSM PBF bytes into split GeoJSON layers on a Web Worker. The buffer is
 * transferred (not copied) to the worker; do not reuse it after calling.
 */
export function loadOsmPbf(bytes: ArrayBuffer): Promise<OsmPbfLayers> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./osm-pbf.worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.addEventListener(
      "message",
      (event: MessageEvent<OsmPbfWorkerMessage>) => {
        worker.terminate();
        const data = event.data;
        if (data?.ok) resolve(data.result);
        else reject(new Error(data?.error || "Could not parse the OSM PBF file."));
      },
    );
    worker.addEventListener("error", (event) => {
      worker.terminate();
      reject(new Error(event.message || "The OSM PBF worker failed."));
    });
    worker.postMessage(bytes, [bytes]);
  });
}
