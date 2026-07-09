import { createRequire } from "node:module";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Plugin } from "vite";

// CesiumJS loads its Web Workers, static Assets (glTF/IBL/approximateTerrainHeights),
// bundled ThirdParty scripts, and Widgets CSS at runtime from `CESIUM_BASE_URL`,
// rather than through the module graph. So we copy those four directories out of
// `node_modules/cesium/Build/Cesium/` into `public/cesium/` (served at
// `/cesium/`), and the app sets `window.CESIUM_BASE_URL = "/cesium"` before it
// dynamically imports Cesium. Bundling these through Vite is not possible: they
// are fetched by URL at runtime, and the Workers must load as classic scripts.
//
// The copy is generated (gitignored) and refreshed whenever the installed Cesium
// version changes, tracked via a `.cesium-version` marker so a normal dev-server
// restart is a fast no-op (the Assets dir is large).
const RUNTIME_DIRS = ["Assets", "ThirdParty", "Widgets", "Workers"] as const;
const VERSION_MARKER = ".cesium-version";

function resolveCesiumBuildDir(): { buildDir: string; version: string } {
  const require = createRequire(import.meta.url);
  // The `cesium/package.json` export is exposed, so read it for the version and
  // to anchor the package root (the ESM `module` entry lives under `Source/`,
  // but the runtime assets we need are the built copies under `Build/Cesium/`).
  const manifestPath = require.resolve("cesium/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const buildDir = resolve(dirname(manifestPath), "Build", "Cesium");
  if (!existsSync(buildDir)) {
    throw new Error(
      `copy-cesium-assets: expected Cesium build assets at ${buildDir}. Is cesium installed?`,
    );
  }
  return { buildDir, version: String(manifest.version ?? "unknown") };
}

export function copyCesiumAssets(destDir: string): Plugin {
  const sync = (): void => {
    const { buildDir, version } = resolveCesiumBuildDir();
    const markerPath = join(destDir, VERSION_MARKER);
    // Skip when the copy already matches the installed version so a dev-server
    // restart does not re-copy the (large) Assets directory every time.
    if (
      existsSync(markerPath) &&
      readFileSync(markerPath, "utf8").trim() === version
    ) {
      return;
    }
    // Stale or missing: rebuild the copy from scratch so a version bump never
    // leaves orphaned files from the previous release.
    rmSync(destDir, { recursive: true, force: true });
    mkdirSync(destDir, { recursive: true });
    for (const dir of RUNTIME_DIRS) {
      cpSync(join(buildDir, dir), join(destDir, dir), { recursive: true });
    }
    writeFileSync(markerPath, `${version}\n`, "utf8");
  };

  return {
    name: "geolibre:copy-cesium-assets",
    // buildStart runs for both `vite` (dev) and `vite build`, before any module
    // resolves, so `/cesium/*` is on disk before the first Cesium import.
    buildStart() {
      sync();
    },
  };
}
