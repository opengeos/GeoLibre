// CDN CereusDB loader: the default for every build (web, desktop, embed). A Vite
// alias swaps it in for `./cereus-loader` (see vite.config.ts, gated on
// GEOLIBRE_CEREUS_CDN) so the ~40 MB wasm blob is never emitted into dist and so
// never embedded into the Tauri binary (it was ~8.6 MB brotli — the entire
// 27 → 36 MB v1.3 installer growth).
//
// Only the wasm URL differs from the bundled loader: the JS engine is still
// dynamically imported the same way (it is small and lives in its own lazy
// chunk), but its WebAssembly module is fetched from jsDelivr at runtime via the
// `wasmUrl` option instead of from a vendored `?url` asset. The URL is injected
// by vite.config.ts, pinned to the installed package version.

import type { CereusInstance } from "./cereus-loader";

export type { CereusInstance };

interface CereusModule {
  CereusDB: {
    create(options?: { wasmUrl?: string }): Promise<CereusInstance>;
  };
}

/**
 * Dynamically import CereusDB and initialise it with the CDN-hosted wasm.
 *
 * @returns An initialised CereusDB instance.
 */
export async function loadCereusDb(): Promise<CereusInstance> {
  // Injected (non-null) only in the CDN build that swaps this module in. Fail
  // fast with a clear message if this loader is somehow reached without it,
  // rather than calling create() with an undefined wasmUrl.
  if (!__CEREUS_WASM_CDN_URL__) {
    throw new Error(
      "CereusDB wasm CDN URL was not injected. This loader is only meant for " +
        "the default build (GEOLIBRE_CEREUS_CDN=1).",
    );
  }
  // The JS glue is bundled, so this import resolves to a local chunk; the network
  // fetch happens inside create() when it loads the wasm from the CDN URL.
  // Version-pinned but not integrity-checked: the package fetches the wasm with
  // no `integrity` option, so there is no SRI guard on the CDN binary. Accepted
  // risk (the same trade-off as PGlite/Pyodide) — the wasm runs inside the
  // WebAssembly sandbox and the jsDelivr URL is version-immutable.
  const mod = (await import("@cereusdb/standard")) as unknown as CereusModule;
  try {
    return await mod.CereusDB.create({ wasmUrl: __CEREUS_WASM_CDN_URL__ });
  } catch (err) {
    // No network, jsDelivr unreachable, or a strict CSP blocking the fetch.
    throw new Error(
      "Could not load the Apache Sedona SQL engine from the CDN. GeoLibre " +
        "fetches the CereusDB WebAssembly module from jsDelivr on first use, " +
        "so this engine needs network access and a Content-Security-Policy " +
        "that allows connecting to cdn.jsdelivr.net.",
      { cause: err },
    );
  }
}
