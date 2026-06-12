// Default PGlite loader: dynamically import the bundled PGlite engine and its
// PostGIS extension. These are heavy (~25 MB including the PostGIS WASM bundle),
// so the import is lazy and lives in its own Vite chunk; it only loads when the
// user first opens the PostGIS SQL workspace.
//
// The embed (Jupyter wheel) build swaps this module for `pglite-loader.cdn.ts`
// via a Vite alias (see vite.config.ts, gated on GEOLIBRE_PGLITE_CDN) so the
// bundled packages are removed from the graph entirely and never vendored into
// the wheel. A bundler emits a chunk for every `import()` it parses regardless
// of dead-code reachability, so the CDN/bundled choice must be made by swapping
// modules, not by an `if` branch inside one module.

/** Loaded PGlite constructor and PostGIS extension factory. */
export interface PgliteModules {
  PGlite: new (options: { extensions: { postgis: unknown } }) => unknown;
  postgis: unknown;
}

/** Load the bundled PGlite engine and PostGIS extension. */
export async function loadPgliteModules(): Promise<PgliteModules> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { postgis } = await import("@electric-sql/pglite-postgis");
  return { PGlite: PGlite as PgliteModules["PGlite"], postgis };
}
