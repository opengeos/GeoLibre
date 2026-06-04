import type { DuckDBBundles } from "@duckdb/duckdb-wasm";
import duckdbWasmEh from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import duckdbWasmMvp from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import { configureDuckDB } from "maplibre-gl-geoparquet";

let configured = false;

const GEOPARQUET_DUCKDB_BUNDLES = {
  mvp: {
    mainModule: absoluteAssetUrl(duckdbWasmMvp),
    mainWorker: absoluteAssetUrl(mvpWorker),
  },
  eh: {
    mainModule: absoluteAssetUrl(duckdbWasmEh),
    mainWorker: absoluteAssetUrl(ehWorker),
  },
} satisfies DuckDBBundles;

function absoluteAssetUrl(url: string): string {
  return new URL(url, globalThis.location.href).href;
}

export function configureGeoParquetDuckDBRuntime(): void {
  if (configured) return;
  configureDuckDB({
    bundles: GEOPARQUET_DUCKDB_BUNDLES,
  });
  configured = true;
}
