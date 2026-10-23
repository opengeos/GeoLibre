import type * as duckdb from "@duckdb/duckdb-wasm";
import duckdbWasmEh from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";

export async function selectDuckDbBundle(): Promise<duckdb.DuckDBBundle> {
  return {
    mainModule: duckdbWasmEh,
    mainWorker: ehWorker,
    pthreadWorker: null,
  };
}

/** A worker running the bundled script; see the web variant for why this exists. */
export function createDuckDbWorker(bundle: duckdb.DuckDBBundle): Worker {
  return new Worker(bundle.mainWorker!, { type: "module" });
}
