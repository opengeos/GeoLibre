import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Plugin } from "vite";

const VERSION_MARKER = ".arcgis-version";

function resolveArcGISAssetsDir(): { assetsDir: string; version: string } {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve("@arcgis/core/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const assetsDir = resolve(dirname(manifestPath), "assets");
  if (!existsSync(assetsDir)) {
    throw new Error(
      `copy-arcgis-assets: expected ArcGIS assets at ${assetsDir}. Is @arcgis/core installed?`,
    );
  }
  return { assetsDir, version: String(manifest.version ?? "unknown") };
}

export function copyArcGISAssets(destDir: string): Plugin {
  const sync = (): void => {
    const { assetsDir, version } = resolveArcGISAssetsDir();
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
    buildStart() {
      sync();
    },
  };
}
