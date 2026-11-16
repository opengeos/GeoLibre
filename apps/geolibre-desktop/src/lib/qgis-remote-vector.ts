/**
 * Host side of the QGIS importer's remote vector layers: reads a downloaded
 * file that is not GeoJSON (a GeoParquet, GeoPackage, FlatGeobuf, KML, ...)
 * with the same readers a dropped file goes through. Kept apart from
 * `qgis-project-import.ts` so the parser stays free of DuckDB and runs under
 * `node --test`.
 */
import type { FeatureCollection } from "geojson";
import { isLoadedVectorLayer } from "./file-io/loaded-layer";
import { loadDuckDbVector, mergeFeatureCollections } from "./file-io/vector-shared";
import {
  MAX_REMOTE_VECTOR_BYTES,
  REMOTE_DOWNLOAD_TIMEOUT_MS,
  REMOTE_READ_TIMEOUT_MS,
  withTimeout,
  type QgisRemoteVectorReader,
} from "./qgis-project-import";
import { isTauri } from "./is-tauri";

/**
 * Read one remote QGIS layer's file into features.
 *
 * A layer that names its table (`layername=` in QGIS) reads that table
 * through DuckDB; any other file goes through the dropped-file loader, which
 * also knows the formats DuckDB does not read directly (KMZ, zipped
 * Shapefiles).
 *
 * @param file - The downloaded file and the table it should read.
 * @returns Every feature of the layer, in WGS84.
 * @throws When the file holds no readable vector data.
 */
export const readQgisRemoteVector: QgisRemoteVectorReader = (file) => {
  // The importer downloads several layers at once; their reads run one at a
  // time, which keeps DuckDB's memory to one file. Each read registers under
  // a name of its own, since a read that times out keeps running (DuckDB
  // cannot cancel it) and two layers may share a file name. The time bound
  // sits inside the queue, so it covers the read and not the wait for it,
  // and a stalled read releases the queue for the next layer. That read
  // still holds its file until DuckDB finishes with it, so after a timeout
  // more than one file can be in memory at once; the 250 MB download ceiling
  // bounds each of them.
  const name = `qgis-${++readCount}-${file.name}`;
  const next = readQueue.then(() =>
    withTimeout(readOne({ ...file, name }), REMOTE_READ_TIMEOUT_MS),
  );
  readQueue = next.catch(() => undefined);
  return next;
};

let readQueue: Promise<unknown> = Promise.resolve();
let readCount = 0;

const readOne: QgisRemoteVectorReader = async ({ name, extension, data, sourceLayer }) => {
  if (sourceLayer) {
    return loadDuckDbVector({ name, extension, data }, { layer: sourceLayer });
  }
  const { loadDroppedVectorFiles } = await import("./file-io/vector-loader");
  const vectors = (await loadDroppedVectorFiles([new File([data], name)])).filter(
    isLoadedVectorLayer,
  );
  if (vectors.length === 0) throw new Error(`${name} holds no vector features.`);
  const collections: FeatureCollection[] = vectors.map((layer) => layer.data);
  return collections.length === 1 ? collections[0] : mergeFeatureCollections(collections);
};

/**
 * Download a remote QGIS layer's file. The desktop app goes through its
 * native HTTP client, which CORS does not apply to (the webview's `fetch`
 * would refuse a server that sends no CORS headers), with a download-sized
 * budget and the importer's byte ceiling; the browser build uses `fetch`.
 *
 * @param input - The file's URL.
 * @param init - Request options, passed to `fetch` in the browser. The native
 *   request carries its own time budget instead of the abort signal.
 * @returns The response, whole.
 */
export async function qgisRemoteFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  if (!isTauri()) return fetch(input, init);
  const { fetchUrlBytes } = await import("./native-http");
  const url = input instanceof Request ? input.url : String(input);
  const bytes = await fetchUrlBytes(url, {
    context: "QGIS remote layer",
    timeoutSecs: REMOTE_DOWNLOAD_TIMEOUT_MS / 1000,
    maxBytes: MAX_REMOTE_VECTOR_BYTES,
  });
  // Tauri hands back a typed array for binary bodies; copy only a plain array.
  const body = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  return new Response(body as Uint8Array<ArrayBuffer>);
}
