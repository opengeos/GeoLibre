import * as duckdb from "@duckdb/duckdb-wasm";

/**
 * DuckDB-WASM loaded from jsDelivr instead of the build output.
 *
 * Selected by `GEOLIBRE_DUCKDB_WASM_CDN=1` (see `duckdbWasmBundlesPlugin` in
 * vite.config.ts). The two engine binaries are ~40 MB and ~35 MB, which is over
 * the 25 MiB per-asset ceiling on Cloudflare Pages and Workers static assets, so
 * a host with that limit can only serve this app if they are fetched at runtime.
 * Nothing else in the build comes close to the ceiling.
 *
 * Same trade-off as PGlite: the engine needs network on FIRST use, after which
 * the web build's service worker has it cached (the "geolibre-cdn-engines"
 * CacheFirst rule covers `/npm/@duckdb/`). Never selected for a Tauri build,
 * which bundles the engine so the desktop app keeps working offline.
 */

/**
 * URLs pinned to the installed version by duckdb-wasm itself: its
 * `getJsDelivrBundles()` builds `.../@duckdb/duckdb-wasm@<its own version>/dist/`
 * from the same constant the JS in this bundle was compiled from, so the fetched
 * WASM cannot drift from the loader that instantiates it. Deriving the URL here
 * from package.json would reintroduce exactly that drift.
 */
export function selectDuckDbBundle(): Promise<duckdb.DuckDBBundle> {
  return duckdb.selectBundle(duckdb.getJsDelivrBundles());
}

/**
 * A worker running the CDN-hosted script.
 *
 * A worker script must be same-origin, so the jsDelivr URL cannot go to `new
 * Worker` directly — it fails before the engine ever loads. Wrap it in a
 * same-origin blob that pulls the real script in, which is what duckdb-wasm
 * documents for CDN loading.
 *
 * Classic worker, deliberately not `{ type: "module" }` as the bundled variants
 * use: `importScripts` does not exist in a module worker, and the shipped
 * `duckdb-browser-*.worker.js` is a plain IIFE rather than an ES module.
 *
 * CSP: this needs `worker-src blob:` and the CDN in `script-src`, both already
 * present in docker/nginx.conf for jsDelivr's `/npm/` path.
 */
export function createDuckDbWorker(bundle: duckdb.DuckDBBundle): Worker {
  // `mainWorker` is optional on the type. If it were ever absent, interpolating
  // it would emit `importScripts(null)` and the failure would surface as a
  // worker that never answers, so say what actually went wrong instead.
  if (!bundle.mainWorker) {
    throw new Error("The DuckDB bundle has no worker URL, so the engine cannot be loaded.");
  }
  // The blob revokes its OWN url as its first statement rather than the caller
  // doing it after `new Worker`. Per the HTML spec the constructor returns before
  // the worker fetches its script, so revoking from here is a race: the fetch can
  // land after the revoke and the worker then silently never loads. Revoking
  // inside the script is safe by construction -- it cannot run until the fetch
  // has already succeeded -- and it still frees the url exactly once per worker.
  // `importScripts` then fetches a *different* (CDN) url, so the dead blob url
  // does not affect it.
  const shim = URL.createObjectURL(
    new Blob(
      [
        `URL.revokeObjectURL(self.location.href);`,
        `importScripts(${JSON.stringify(bundle.mainWorker)});`,
      ],
      { type: "text/javascript" },
    ),
  );
  try {
    return new Worker(shim);
  } catch (error) {
    // Construction failed, so nothing will ever run the self-revoke above.
    URL.revokeObjectURL(shim);
    throw error;
  }
}
