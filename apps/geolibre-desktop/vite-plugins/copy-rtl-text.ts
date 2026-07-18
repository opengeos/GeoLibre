import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Plugin } from "vite";

// Copies MapLibre's RTL text plugin (`@mapbox/mapbox-gl-rtl-text`) out of
// node_modules and into the app source tree as
// `src/lib/vendor/mapbox-gl-rtl-text.generated.js`, so `rtl-text.ts` can
// `?url`-import it and Vite bundles it as a hashed, same-origin asset. Shipping
// it locally (rather than from a CDN) keeps the plugin working offline and under
// every build's CSP without a new external host.
//
// We copy rather than `?url`-importing the package's `dist/` file directly: the
// package's `exports` map only exposes `./src/index.js` (an ESM module with a
// sibling .wasm), so Vite refuses the deep `dist/` import — and that ESM file is
// not loadable via the worker `importScripts()` that `setRTLTextPlugin` uses.
// The `dist/` build is the self-contained UMD bundle (its ICU/wasm payload is
// base64-embedded) that `importScripts()` needs. A generated file inside `src/`
// keeps the module graph local and identical across the dev, Docker, and static
// builds (mirrors copy-vector-ops.ts).
const BANNER =
  "// AUTO-GENERATED — do not edit. Source of truth:\n" +
  "// node_modules/@mapbox/mapbox-gl-rtl-text/dist/mapbox-gl-rtl-text.js\n" +
  "// Regenerated on each Vite dev-server start / build by\n" +
  "// apps/geolibre-desktop/vite-plugins/copy-rtl-text.ts\n\n";

const PKG = "@mapbox/mapbox-gl-rtl-text";

// Resolve the package's self-contained UMD bundle. `require.resolve` honors the
// `exports` map and lands on `src/index.js`, and the package does not expose
// `./package.json` (so `require.resolve("<pkg>/package.json")` throws
// ERR_PACKAGE_PATH_NOT_EXPORTED). So walk up from the entry to the owning
// package.json and read its declared `main` (the self-contained `dist` bundle),
// which tracks any future source-layout change instead of assuming `../dist/`.
function resolveRtlTextDist(): string {
  const require = createRequire(import.meta.url);
  const entryDir = dirname(require.resolve(PKG));
  for (let parent = entryDir; parent !== dirname(parent); parent = dirname(parent)) {
    const manifestPath = resolve(parent, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.name !== PKG) continue;
    const main = typeof manifest.main === "string" ? manifest.main : "";
    if (!main) break;
    const dist = resolve(parent, main);
    if (!existsSync(dist)) break;
    return dist;
  }
  throw new Error(`copy-rtl-text: could not locate ${PKG}'s "main" bundle. Is it installed?`);
}

export function copyRtlText(destPath: string): Plugin {
  const sync = (): void => {
    const bundle = readFileSync(resolveRtlTextDist(), "utf8");
    // Guard against the package reorganising its layout: `../dist/` navigation
    // could still resolve to some other file. The real plugin always exposes the
    // `registerRTLTextPlugin` hook the MapLibre worker calls via importScripts.
    if (!bundle.includes("registerRTLTextPlugin")) {
      throw new Error(
        "copy-rtl-text: the resolved bundle does not look like the RTL text " +
          "plugin (no registerRTLTextPlugin hook). Check @mapbox/mapbox-gl-rtl-text.",
      );
    }
    const next = BANNER + bundle;
    // Skip the write when unchanged so the dev-server file watcher does not
    // fire an extra reload on every restart.
    if (existsSync(destPath) && readFileSync(destPath, "utf8") === next) return;
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, next, "utf8");
  };

  return {
    name: "geolibre:copy-rtl-text",
    // buildStart runs for both `vite` (dev) and `vite build`, before any module
    // in the graph is resolved, so the `?url` import always sees the copy.
    buildStart() {
      sync();
    },
  };
}
