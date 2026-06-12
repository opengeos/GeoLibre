/// <reference types="vite/client" />

declare const __GEOLIBRE_VERSION__: string;

// jsDelivr URLs for the PGlite engine and its PostGIS extension, injected by
// vite.config.ts. Only the embed (Jupyter wheel) build reads them, from
// pglite-loader.cdn.ts; web/desktop builds bundle PGlite and never reference
// these (the define values are null there).
declare const __PGLITE_CDN_URL__: string;
declare const __PGLITE_POSTGIS_CDN_URL__: string;

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
}
