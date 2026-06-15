/**
 * Lazy loader for gdal3.js (GDAL compiled to WebAssembly), used by the
 * Georeferencer's client-side GeoTIFF/COG export.
 *
 * The ~28 MB wasm and ~12 MB data are fetched from jsDelivr at runtime (see
 * `__GDAL3_CDN_PATHS__` in vite.config.ts) so they never inflate the build; the
 * small JS glue is dynamically imported into its own lazy chunk, loaded only
 * when the user actually exports. Runs single-threaded (`useWorker: false`) so
 * no SharedArrayBuffer / cross-origin-isolation (COOP/COEP) headers are needed.
 */

type GdalInstance = Awaited<ReturnType<(typeof import("gdal3.js"))["default"]>>;

let gdalPromise: Promise<GdalInstance> | null = null;

/** Load (once) and return the GDAL instance, or reject if export is disabled. */
export function loadGdal(): Promise<GdalInstance> {
  if (gdalPromise) return gdalPromise;
  const paths = __GDAL3_CDN_PATHS__;
  if (!paths) {
    return Promise.reject(
      new Error("GeoTIFF export needs gdal3.js, which is disabled in this build."),
    );
  }
  gdalPromise = import("gdal3.js")
    .then(({ default: initGdalJs }) => initGdalJs({ paths, useWorker: false }))
    .catch((err) => {
      gdalPromise = null; // allow a retry after a failed load
      throw err;
    });
  return gdalPromise;
}
