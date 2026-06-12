// CDN PGlite loader: used only by the embed (Jupyter wheel) build, which aliases
// `./pglite-loader` to this module when GEOLIBRE_PGLITE_CDN=1 (see vite.config.ts).
// It fetches PGlite and its PostGIS extension from jsDelivr at runtime instead of
// vendoring their ~25 MB of WASM/data/postgis.tar into the wheel. PGlite resolves
// its own .wasm/.data/postgis.tar relative to the loaded module URL, so the pinned
// jsDelivr URL transparently pulls those companion files from the CDN too.
//
// The URLs come from `define` constants injected by vite.config.ts, pinned to the
// installed package versions so they cannot drift from the lockfile. The
// `@vite-ignore` comments keep Vite from trying to resolve/bundle the CDN URLs.

import type { PgliteModules } from "./pglite-loader";

export type { PgliteModules };

/** Load PGlite and the PostGIS extension from the CDN (embed build only). */
export async function loadPgliteModules(): Promise<PgliteModules> {
  // The URLs are only injected (non-null) in the embed build that swaps this
  // module in via pgliteCdnLoaderPlugin. Fail fast with a clear message if this
  // loader is somehow reached without them, rather than rewrapping a cryptic
  // `import(null)` failure as the generic "needs network access" error below.
  // The guard also narrows the `string | null` defines to `string` for the
  // dynamic imports.
  if (!__PGLITE_CDN_URL__ || !__PGLITE_POSTGIS_CDN_URL__) {
    throw new Error(
      "PGlite CDN URLs were not injected. This loader is only meant for the " +
        "embed build (GEOLIBRE_PGLITE_CDN=1).",
    );
  }
  let modules: { PGlite: unknown; postgis: unknown };
  try {
    // Version-pinned but not integrity-checked: dynamic import() has no
    // `integrity` option, so there is no Subresource Integrity guard on the
    // CDN code/WASM. Accepted risk for this optional, CDN-only embed feature
    // (non-sandboxed iframe, no CSP).
    const [{ PGlite }, { postgis }] = await Promise.all([
      import(/* @vite-ignore */ __PGLITE_CDN_URL__),
      import(/* @vite-ignore */ __PGLITE_POSTGIS_CDN_URL__),
    ]);
    modules = { PGlite, postgis };
  } catch (err) {
    // The import itself failed: no network, jsDelivr unreachable, or a strict
    // JupyterHub CSP blocking script-src cdn.jsdelivr.net. Name all three so the
    // failure is diagnosable.
    throw new Error(
      "Could not load the PostGIS SQL engine from the CDN. The embedded " +
        "GeoLibre app fetches PGlite from jsDelivr on first use, so this " +
        "feature needs network access and a Content-Security-Policy that " +
        "allows loading scripts from cdn.jsdelivr.net.",
      { cause: err },
    );
  }
  // Validate the export shape outside the catch (so this specific message is not
  // rewrapped as the network error above). If the pinned CDN bundle ever ships
  // an incompatible module (e.g. a CJS shim that nests everything under
  // `default`), these would be undefined and otherwise surface later as an
  // opaque "PGlite is not a constructor" in pglite-workspace.ts.
  if (typeof modules.PGlite !== "function" || !modules.postgis) {
    throw new Error(
      "The CDN module did not export the expected PGlite/postgis symbols; " +
        "the pinned jsDelivr URL may point to an incompatible bundle.",
    );
  }
  return {
    PGlite: modules.PGlite as PgliteModules["PGlite"],
    postgis: modules.postgis,
  };
}
