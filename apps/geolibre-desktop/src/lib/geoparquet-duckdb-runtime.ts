import type { DuckDBBundles } from "@duckdb/duckdb-wasm";
import duckdbWasmEh from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import duckdbWasmMvp from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import { configureDuckDB } from "maplibre-gl-geoparquet";
import {
  type GeoLibreAppAPI,
  openGeoParquetLayerPanel,
} from "@geolibre/plugins";

function absoluteAssetUrl(url: string): string {
  return new URL(url, globalThis.location?.href ?? "http://localhost/").href;
}

export function configureGeoParquetDuckDBRuntime(): void {
  // configureDuckDB is an idempotent synchronous setter, so repeated calls
  // are harmless (and DuckDB ignores config changes once initialized).
  configureDuckDB({
    bundles: {
      mvp: {
        mainModule: absoluteAssetUrl(duckdbWasmMvp),
        mainWorker: absoluteAssetUrl(mvpWorker),
      },
      eh: {
        mainModule: absoluteAssetUrl(duckdbWasmEh),
        mainWorker: absoluteAssetUrl(ehWorker),
      },
    } satisfies DuckDBBundles,
  });
}

export function openGeoParquetPanel(app: GeoLibreAppAPI): void {
  configureGeoParquetDuckDBRuntime();
  openGeoParquetLayerPanel(app);
}
