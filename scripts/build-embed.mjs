// Build the GeoLibre web app for embedding (Jupyter widget / standalone HTML)
// and stage it into the Python package.
//
// The embed build differs from the normal web build in two load-bearing ways:
//  1. `GEOLIBRE_APP_BASE=./` makes every asset, favicon, and bundled-plugin URL
//     in the emitted index.html relative, so the app can load from inside a
//     Python wheel (served from an arbitrary, content-hashed location) instead
//     of the site root.
//  2. `GEOLIBRE_EMBED=1` disables the service worker (a SW is meaningless inside
//     a notebook iframe). PGlite is CDN-loaded here via `GEOLIBRE_PGLITE_CDN=1`,
//     keeping its ~25 MB PostGIS bundle out of the wheel — the web and desktop
//     builds CDN-load it too by default; override with `GEOLIBRE_PGLITE_CDN=0`
//     on any target to force-bundle it for a fully offline build.
//
// Output: apps/geolibre-desktop/dist-embed/ -> copied to
// python/src/geolibre/static/app/.

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(repoRoot, "apps/geolibre-desktop/dist-embed");
const staticDir = resolve(repoRoot, "python/src/geolibre/static/app");

const result = spawnSync(
  "npm",
  ["run", "build", "-w", "geolibre-desktop", "--", "--outDir", "dist-embed"],
  {
    cwd: repoRoot,
    shell: process.platform === "win32",
    stdio: "inherit",
    env: {
      ...process.env,
      GEOLIBRE_APP_BASE: "./",
      // CDN-load PGlite (the web build now does this by default too) and mark
      // this as the embed build so the service worker is disabled — a SW is
      // meaningless inside a notebook iframe and could hijack the host scope.
      GEOLIBRE_PGLITE_CDN: "1",
      GEOLIBRE_EMBED: "1",
    },
  },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

// Guard the wheel size: GEOLIBRE_PGLITE_CDN should keep the PGlite/PostGIS bundle
// out of the embed build. If the dead-code elimination ever stops working, the
// 19.6 MB postgis.tar (and PGlite wasm/data) would silently re-inflate the wheel.
const assetsDir = resolve(distDir, "assets");
// Matches the content-hashed PGlite assets, e.g. postgis.tar-<hash>.gz,
// pglite-<hash>.wasm, pglite-<hash>.data, initdb-<hash>.wasm. The second arm
// also catches a leaked pglite-<hash>.js chunk: manualChunks() names any
// @electric-sql/pglite import exactly "pglite", so if the loader module-swap
// stops excluding the package, Rollup emits `pglite-<hash>.js` and the wheel
// would regrow even without the WASM/data assets. The JS arm is anchored to
// `pglite-<alnum-hash>.js` so it does not spuriously match a `pglite-loader-*`
// chunk (the `-` in `loader` breaks the `\w+` run) should Rollup ever split the
// statically-imported loader module into its own chunk.
const pgliteAssetRe = /^(?:postgis\.tar|pglite|initdb).*\.(?:gz|wasm|data)$|^pglite-\w+\.js$/;
const leaked = readdirSync(assetsDir).filter((name) => pgliteAssetRe.test(name));
if (leaked.length > 0) {
  console.error(
    "[build-embed] PGlite assets leaked into the embed build despite " +
      `GEOLIBRE_PGLITE_CDN=1: ${leaked.join(", ")}. These should load from a ` +
      "CDN at runtime; check `pgliteCdnLoaderPlugin` in vite.config.ts and the " +
      "pglite-loader.cdn.ts / pglite-loader.ts module pair.",
  );
  process.exit(1);
}

// Guard the one thing that silently breaks the wheel: if the base path was not
// applied, index.html references /assets/... and the iframe loads a blank page.
const indexHtml = readFileSync(resolve(distDir, "index.html"), "utf8");
if (/\b(?:src|href)="\/(?!\/)/.test(indexHtml)) {
  console.error(
    "[build-embed] dist-embed/index.html has absolute asset paths. " +
      "GEOLIBRE_APP_BASE=./ was not applied; the embedded app would 404.",
  );
  process.exit(1);
}

rmSync(staticDir, { recursive: true, force: true });
mkdirSync(staticDir, { recursive: true });
cpSync(distDir, staticDir, { recursive: true });

console.log(`[build-embed] Staged embed build into ${staticDir}`);
