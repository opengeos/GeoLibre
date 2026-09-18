import * as duckdb from "@duckdb/duckdb-wasm";
import duckdbWasmEh from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import duckdbWasmMvp from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";

const MANUAL_BUNDLES: duckdb.DuckDBBundles = {
  mvp: {
    mainModule: duckdbWasmMvp,
    mainWorker: mvpWorker,
  },
  eh: {
    mainModule: duckdbWasmEh,
    mainWorker: ehWorker,
  },
};

export function selectDuckDbBundle(): Promise<duckdb.DuckDBBundle> {
  return duckdb.selectBundle(MANUAL_BUNDLES);
}

/**
 * A worker running the bundled script.
 *
 * Same-origin, so the URL goes straight to `new Worker`. The CDN variant has to
 * take a detour through a blob shim; keeping worker creation behind this shared
 * export is what lets the two differ without the caller knowing.
 */
export function createDuckDbWorker(bundle: duckdb.DuckDBBundle): Worker {
  return new Worker(bundle.mainWorker!, { type: "module" });
}
