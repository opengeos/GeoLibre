// Bundled (offline) loader for CereusDB — a WebAssembly build of Apache SedonaDB
// (Rust / DataFusion / Arrow) that runs Sedona spatial SQL entirely in the
// browser.
//
// The `standard` tier bundles a large (~40 MB unpacked) WASM module, so the
// package is imported *dynamically* and lives in its own Vite chunk: it is only
// fetched when the user first runs a query with the "Apache Sedona" engine
// selected, and never inflates the initial app bundle.
//
// The WASM binary URL is resolved at build time with Vite's `?url` import (the
// same approach the DuckDB loader uses) and handed to `CereusDB.create` via its
// `wasmUrl` option, so loading does not rely on `import.meta.url` resolution
// inside the published package.
//
// By default this module is NOT used: a Vite alias swaps it for
// `cereus-loader.cdn.ts` (see vite.config.ts, gated on GEOLIBRE_CEREUS_CDN) so
// the ~40 MB `?url` wasm is dropped from the graph and never embedded into the
// Tauri binary (it was ~8.6 MB brotli — the whole 27 → 36 MB v1.3 installer
// growth). This bundled variant is reached only for a fully offline build
// (GEOLIBRE_CEREUS_CDN=0). A bundler emits the asset for every `?url` import it
// parses regardless of reachability, so the CDN/bundled choice must be a module
// swap, not an `if` inside one module.

// The WASM asset, emitted as a hashed file and referenced by URL by the bundler.
import cereusWasmUrl from "@cereusdb/standard/wasm?url";

/**
 * Minimal structural view of the CereusDB instance this app relies on, so the
 * dynamic import does not force the whole app to depend on the package's types.
 * `registerGeoJSON`, `dropTable`, and `tables` are synchronous in the package;
 * only `sql`/`sqlJSON` are async.
 */
export interface CereusInstance {
  /** Execute SQL and return Arrow IPC bytes (used to read the result schema). */
  sql(query: string): Promise<Uint8Array>;
  /** Execute SQL and return parsed JSON rows. */
  sqlJSON(query: string): Promise<Record<string, unknown>[]>;
  /** Register a GeoJSON object (or string) as a queryable table. */
  registerGeoJSON(name: string, geojson: string | object): void;
  /** Drop a registered table. */
  dropTable(name: string): void;
  /** List registered table names. */
  tables(): string[];
}

interface CereusModule {
  CereusDB: {
    create(options?: { wasmUrl?: string }): Promise<CereusInstance>;
  };
}

/** Dynamically import the CereusDB engine and create an initialised instance. */
export async function loadCereusDb(): Promise<CereusInstance> {
  const mod = (await import("@cereusdb/standard")) as unknown as CereusModule;
  return mod.CereusDB.create({ wasmUrl: cereusWasmUrl });
}
