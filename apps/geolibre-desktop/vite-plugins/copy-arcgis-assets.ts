import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Plugin } from "vite";

// The ArcGIS Maps SDK loads workers, styles, localization files, symbols, and
// WASM by URL at runtime. Keep its assets beside the application instead of
// relying on the SDK's CDN default so desktop, web, and embed builds resolve
// the same versioned files from the configured Vite base path.
const VERSION_MARKER = ".arcgis-version";

function resolveArcgisAssets(): { assetsDir: string; version: string } {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve("@arcgis/core/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: unknown };
  const assetsDir = resolve(dirname(manifestPath), "assets");
  if (!existsSync(assetsDir)) {
    throw new Error(
      `copy-arcgis-assets: expected ArcGIS SDK assets at ${assetsDir}. Is @arcgis/core installed?`,
    );
  }
  return { assetsDir, version: String(manifest.version ?? "unknown") };
}

export function copyArcgisAssets(destDir: string): Plugin {
  const sync = (): void => {
    const { assetsDir, version } = resolveArcgisAssets();
    const markerPath = join(destDir, VERSION_MARKER);
    if (existsSync(markerPath) && readFileSync(markerPath, "utf8").trim() === version) {
      return;
    }
    rmSync(destDir, { recursive: true, force: true });
    mkdirSync(destDir, { recursive: true });
    cpSync(assetsDir, destDir, { recursive: true });
    writeFileSync(markerPath, `${version}\n`, "utf8");
  };

  return {
    name: "geolibre:copy-arcgis-assets",
    // Assets must exist before Vite serves the first dynamic ArcGIS engine
    // import in development and before it copies public files into production.
    buildStart() {
      sync();
    },
  };
}
