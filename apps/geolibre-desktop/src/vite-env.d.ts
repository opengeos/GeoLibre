/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare const __GEOLIBRE_VERSION__: string;

// True only in the Microsoft Store MSIX build (GEOLIBRE_STORE_BUILD=1), where the
// in-app update checker is removed so the app updates solely through the Store
// (Microsoft policy 10.2.5). false in every other build. See vite.config.ts.
declare const __GEOLIBRE_STORE_BUILD__: boolean;

// jsDelivr URLs for the PGlite engine and its PostGIS extension, injected by
// vite.config.ts. Only the embed (Jupyter wheel) build reads them, from
// pglite-loader.cdn.ts; web/desktop builds bundle PGlite and never reference
// these (the define values are null there).
declare const __PGLITE_CDN_URL__: string | null;
declare const __PGLITE_POSTGIS_CDN_URL__: string | null;

// jsDelivr URL for the CereusDB (Apache Sedona) WASM blob, injected by
// vite.config.ts and read by cereus-loader.cdn.ts. By default every build
// (web/desktop/embed) CDN-loads it so the ~40 MB wasm never lands in dist; the
// value is null only when GEOLIBRE_CEREUS_CDN=0 force-bundles it via the `?url`
// import in cereus-loader.ts.
declare const __CEREUS_WASM_CDN_URL__: string | null;

// jsDelivr URLs for the gdal3.js (GDAL-WASM) engine + data, injected by
// vite.config.ts and read by gdal-loader.ts for the Georeferencer's client-side
// GeoTIFF export. null only when GEOLIBRE_GDAL_CDN=0 (export then unavailable).
declare const __GDAL3_CDN_PATHS__: { wasm: string; data: string } | null;

declare module "virtual:bundled-plugins" {
  // Manifest paths (base-relative, no leading slash) for plugins dropped into
  // public/plugins/<id>/, discovered at build time by the bundledPlugins() Vite
  // plugin. See apps/geolibre-desktop/vite-plugins/bundled-plugins.ts.
  export const bundledPluginManifestPaths: string[];
}

declare module "*.geojson?url" {
  const url: string;
  export default url;
}

declare module "shpjs" {
  const shp: (input: unknown) => Promise<unknown>;
  export default shp;
  // Low-level parsers, used to build a FeatureCollection from already-unzipped
  // shapefile components without shpjs re-unzipping the archive.
  export function parseShp(shp: ArrayBuffer, prj?: string | ArrayBuffer): unknown;
  export function parseDbf(dbf: ArrayBuffer, cpg?: string): unknown;
  export function combine(inputs: [unknown, unknown]): unknown;
}
