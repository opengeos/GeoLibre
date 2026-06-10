// Build the GeoLibre web app for embedding (Jupyter widget / standalone HTML)
// and stage it into the Python package.
//
// The embed build differs from the normal web build in one load-bearing way:
// it sets `GEOLIBRE_APP_BASE=./` so every asset, favicon, and bundled-plugin
// URL in the emitted index.html is relative. That lets the app load from
// inside a Python wheel (served from an arbitrary, content-hashed location)
// instead of the site root.
//
// Output: apps/geolibre-desktop/dist-embed/ -> copied to
// python/src/geolibre/static/app/.

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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
    env: { ...process.env, GEOLIBRE_APP_BASE: "./" },
  },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
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
