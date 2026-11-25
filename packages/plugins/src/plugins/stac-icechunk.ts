/**
 * Reading an Icechunk repository: a manifest rather than a Zarr hierarchy, so it reaches the
 * renderer through {@link ZarrRasterLayerOptions.store}, as a kerchunk store or a local folder does.
 *
 * `icechunk-js` rather than `@earthmover/icechunk`, whose browser build is WASI and fails with
 * `SharedArrayBuffer transfer requires self.crossOriginIsolated` — app-wide isolation next to a
 * 6.8 MB wasm payload. Revisit if earth-mover/icechunk#2065 lands an emscripten build.
 *
 * Imported dynamically: it carries its own msgpack and flatbuffers parsers.
 */

import { createZarrMetadataReader } from "./zarr-metadata-reader";
import { readCoordinateTimeAttributes, type ZarrTimeAttributes } from "./zarr-time-axis";

import { type ZarrKeyReader } from "@geolibre/map/zarr-source";
export {
  DEFAULT_ICECHUNK_BRANCH,
  __resetIcechunkRepositoriesForTests,
  openIcechunkStore,
  repositoryKey,
  shareRepositoryOpen,
  icechunkLayerUrl,
  type ZarrKeyReader,
} from "@geolibre/map/zarr-source";

/**
 * The error the panel shows for a repository that would not open, with the reason logged beside it.
 * `cause` alone reaches nobody — nothing reads it — while the log lands in the Diagnostics panel.
 */
export function repositoryOpenError(error: unknown, message: string): Error {
  console.error("Icechunk repository could not be opened", error);
  return new Error(message, { cause: error });
}

/**
 * A reader for the CF `units`/`calendar` of an Icechunk repository's coordinate. The Time Slider
 * otherwise fetches these from the store's URL, which for a repository is a run of 404s and a
 * binding that never happens.
 */
export function icechunkTimeAttributesReader(
  store: ZarrKeyReader,
): (dimension: string) => Promise<ZarrTimeAttributes | null> {
  // Only the rooting is this store's own; the decode is the same one a folder on disk gets.
  const readDocument = createZarrMetadataReader((key) => store.get(`/${key}`));
  return (dimension: string) => readCoordinateTimeAttributes(readDocument, dimension);
}
