// Build the GeoLibre web app for embedding (Jupyter widget / standalone HTML)
// and stage it into the Python package.
//
// The embed build differs from the normal web build in two load-bearing ways:
//  1. `GEOLIBRE_APP_BASE=./` makes every asset, favicon, and bundled-plugin URL
//     in the emitted index.html relative, so the app can load from inside a
//     Python wheel (served from an arbitrary, content-hashed location) instead
//     of the site root.
//  2. `GEOLIBRE_PGLITE_CDN=1` makes the PostGIS SQL engine fetch PGlite and its
//     ~25 MB PostGIS bundle from jsDelivr at runtime instead of vendoring them
//     into the wheel. Web/desktop builds keep bundling PGlite (offline-capable).
//
// Output: apps/geolibre-desktop/dist-embed/ -> copied to
// python/src/geolibre/static/app/.

import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
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
    env: { ...process.env, GEOLIBRE_APP_BASE: "./", GEOLIBRE_PGLITE_CDN: "1" },
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
// pglite-<hash>.wasm, pglite-<hash>.data, initdb-<hash>.wasm.
const pgliteAssetRe = /^(?:postgis\.tar|pglite|initdb).*\.(?:gz|wasm|data)$/;
const leaked = readdirSync(assetsDir).filter((name) => pgliteAssetRe.test(name));
if (leaked.length > 0) {
  console.error(
    "[build-embed] PGlite assets leaked into the embed build despite " +
      `GEOLIBRE_PGLITE_CDN=1: ${leaked.join(", ")}. These should load from a ` +
      "CDN at runtime; check the tree-shaken import branch in pglite-workspace.ts.",
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
