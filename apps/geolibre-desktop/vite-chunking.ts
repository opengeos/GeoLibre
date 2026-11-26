// Build chunking for the web app: manual chunk names, Rolldown code-splitting groups, the boot bundle budget and the Rollup warning filter.

import { readFileSync } from "node:fs";
import path from "node:path";
import type { RollupLog, WarningHandlerWithDefault } from "rollup";
import type { OutputChunk } from "rolldown";
import { gzipSync } from "node:zlib";
import type { Plugin } from "vite";

const GEOAGENT_BROWSER_BUNDLE = "maplibre-gl-geoagent/dist/browser-";

const EARTH_ENGINE_CONTROL_BUNDLE = "maplibre-gl-earth-engine/dist/";

const EARTH_ENGINE_BROWSER_BUNDLE = "@google/earthengine/build/browser.js";

function manualChunks(id: string): string | undefined {
  // Lazy per-locale i18n catalogs (src/i18n/index.ts dynamic-imports every
  // non-English locale). Give each its own predictably named `i18n-locale-<code>`
  // chunk so the service worker can keep them OUT of the app-shell precache
  // (globIgnored below) and CacheFirst-cache them on demand instead. The prefix
  // is deliberately distinct from the auto-named `i18n-<hash>` chunk that holds
  // the i18n init module + statically bundled English, which MUST stay precached
  // for offline boot.
  // Match any locale filename, including regional tags like `pt-BR` / `zh-Hans`
  // (uppercase/mixed-case), so those chunks still get the `i18n-locale-` name
  // and the Workbox exclusion below — not just the two-letter `[a-z]` codes.
  const localeMatch = id.match(/\/i18n\/locales\/([^/]+)\.json(?:\?|$)/);
  if (localeMatch && localeMatch[1] !== "en") return `i18n-locale-${localeMatch[1]}`;
  if (!id.includes("node_modules")) return undefined;
  // Only route JS/TS modules into manual chunks. The name-based rules below match
  // on the module id, so a package's *stylesheet* (e.g.
  // `maplibre-gl-duckdb/dist/style.css`, imported eagerly in main.tsx so plugin
  // controls are styled) would otherwise be assigned to that package's JS chunk
  // and bundled into it. Importing the CSS in the boot entry then forces the
  // whole heavy plugin JS to load at boot just to fetch its stylesheet, dragging
  // DuckDB, Earth Engine, GeoAgent, Mapillary, etc. into the offline-critical
  // boot graph — a cold offline reload can't fetch those runtime-cached chunks
  // and the shell never mounts (see e2e/pwa.spec.ts). Let CSS and other assets
  // fall through to default handling so only their JS is code-split.
  if (!/\.[mc]?[jt]sx?(?:\?|$)/.test(id)) return undefined;
  // A `?url` import (e.g. the DuckDB worker script) is a one-line module that
  // exports the asset's URL. Named after its package, it landed in that
  // package's chunk, so importing the URL string fetched all of DuckDB-WASM.
  if (/\?(?:[^#]*&)?url(?:&|$)/.test(id)) return undefined;
  // Keep @duckdb/duckdb-wasm AND its apache-arrow dependency together in one
  // lazily-fetched chunk. apache-arrow is shared with maplibre-gl-duckdb; if it
  // is left to default chunking it can be hoisted into a chunk the eager
  // `maplibre` chunk imports, dragging the heavy DuckDB engine into the app's
  // offline-critical boot graph (the cold offline reload then can't fetch it and
  // the shell never mounts — see e2e/pwa.spec.ts). Co-locating it here keeps both
  // out of boot.
  if (id.includes("@duckdb/duckdb-wasm")) return "duckdb";
  if (id.includes("apache-arrow")) return "duckdb";
  // PGlite + the ~18.8 MB PostGIS extension only load when the user picks the
  // PostGIS SQL engine; keep them in their own lazily-fetched chunk.
  if (id.includes("@electric-sql/pglite")) return "pglite";
  if (id.includes("maplibre-gl-earth-engine")) {
    return "maplibre-earth-engine";
  }
  if (id.includes("maplibre-gl-geoagent")) return "maplibre-geoagent";
  if (id.includes("@google/earthengine")) return "earth-engine-browser";
  if (id.includes("mapillary-js")) return "mapillary";
  if (id.includes("@geoman-io/maplibre-geoman-free")) return "maplibre-geoman";
  // gdal3.js JS glue (the big wasm/data load from the CDN); lazy on export only.
  if (id.includes("gdal3.js")) return "gdal3";
  // maplibre-gl-duckdb pulls in @duckdb/duckdb-wasm + apache-arrow and is only
  // loaded on demand (the DuckDB map control). It must NOT fall through to the
  // generic `maplibre-gl` rule below, which would fold it into the eager
  // `maplibre` chunk and force DuckDB into boot. Give it its own lazy chunk.
  if (id.includes("maplibre-gl-duckdb")) return "maplibre-duckdb";
  // One chunk per `maplibre-gl-*` feature plugin (components, splat, 3d-tiles,
  // lidar, …). A single shared chunk put ~12 MB of plugins, plus the
  // dependencies they pull in (three, deck.gl, luma.gl), into the chunk that
  // holds MapLibre core, which boots eagerly. Split per package, each plugin
  // loads when its control is first used and boot fetches only MapLibre core.
  //
  // maplibre-gl-3d-tiles is the exception: Rolldown's default chunking places
  // it. Since 0.5.11 its dependencies (3d-tiles-renderer, three's loaders) sit
  // outside its `dist`, and this group does not follow dependencies, so they
  // stayed in the package's dynamic-entry chunk while the package moved to a
  // named one. The two chunks then imported each other, the named one ran
  // first, and its top-level `OBB.prototype` patch read OBB before the other
  // chunk defined it, so Add Data → 3D Tiles threw (#3074). Unnamed, the
  // package and its private dependencies share one chunk again.
  if (id.includes("/node_modules/maplibre-gl-3d-tiles/")) return undefined;
  const mapLibrePlugin = id.match(/\/node_modules\/(maplibre-gl-[^/]+)\//);
  if (mapLibrePlugin) return mapLibrePlugin[1];
  if (id.includes("maplibre-gl")) return "maplibre";
  // Cesium is handled by a dedicated group in CODE_SPLITTING_GROUPS below, not
  // here: a name returned from this function also captures the module's
  // dependencies, which is how Cesium used to pull shared helpers into its
  // chunk and onto the boot path.
  // Returning undefined hands remaining node_modules back to Rollup's default
  // chunking. We intentionally do not group them into a single "vendor" chunk:
  // that produced a circular manual-chunks warning. Do not re-add a catch-all
  // `return "vendor"` here without re-checking that warning.
  return undefined;
}

// Rolldown code-splitting groups. A group captures its matched modules AND,
// by default, their dependencies recursively, and an earlier capture wins over
// a later `manualChunks` name. When Cesium was named from manualChunks, its
// chunk swallowed Vite's dynamic-import preload helper, tslib, and dompurify.
// The entry imports the preload helper, so the whole ~4.7 MB Cesium chunk was
// modulepreloaded on every boot. The higher-priority groups here claim those
// shared modules first. The Cesium and manualChunks groups do not follow
// dependencies, so each named chunk holds only its own package.
export const CODE_SPLITTING_GROUPS = [
  { name: "preload-helper", test: /vite\/preload-helper/, priority: 3 },
  { name: "tslib", test: /\/node_modules\/tslib\//, priority: 3 },
  { name: "dompurify", test: /\/node_modules\/dompurify\//, priority: 3 },
  // Cesium only loads when a pane switches to the 3D globe. The globe imports
  // `@cesium/engine` directly rather than the `cesium` wrapper: the wrapper
  // re-exports `@cesium/widgets` too, and that barrel defeats tree-shaking. The
  // `cesium` package is still a dependency (copy-cesium-assets stages its
  // runtime Workers/Assets), so both paths are matched.
  {
    name: "cesium",
    test: /\/node_modules\/(?:cesium|@cesium)\//,
    includeDependenciesRecursively: false,
    priority: 2,
  },
  // The named chunks from manualChunks do not follow dependencies either. With
  // recursion, whichever named chunk reached a shared library first absorbed
  // it: `maplibre-duckdb` held all of deck.gl and luma.gl, `maplibre-gl-raster`
  // held loaders.gl, and `maplibre-gl-components` held three.js. Any startup
  // code that needed one of those libraries then fetched the whole plugin
  // chunk, about 5.7 MB of plugins at boot. Shared libraries now land in
  // Rolldown's default chunks and load only with code that uses them.
  {
    name: (id: string) => manualChunks(id) ?? null,
    includeDependenciesRecursively: false,
    priority: 1,
  },
];

// Upper bounds on the minified JS the app entry imports statically, i.e. what
// index.html modulepreloads before the shell can mount, raw and gzipped (level
// 9). Raw measured ~2.2 MB when this guard was added (MapLibre core is ~1.2 MB
// of it); it was ~19 MB while Cesium and every MapLibre plugin sat on the boot
// path. Gzip measured ~680 kB when its budget was added. Both live in
// boot-budget.json, which scripts/bundle-report.mjs also reads. Raise them only
// deliberately, after confirming the new eager code actually belongs at boot
// (see "Boot bundle budget" in docs/maintenance.md).
const BOOT_BUDGET = JSON.parse(
  readFileSync(path.resolve(__dirname, "boot-budget.json"), "utf8"),
) as {
  rawBytes: number;
  gzipBytes: number;
};

/**
 * Fails the build when the app entry's static import graph exceeds the raw or
 * gzip budget in boot-budget.json or includes Cesium. Chunk-grouping
 * regressions are silent otherwise: the app still works, it just downloads
 * megabytes more on every launch.
 */
export function bootBundleBudgetPlugin(): Plugin {
  return {
    name: "geolibre-boot-bundle-budget",
    apply: "build",
    generateBundle(_, bundle) {
      // Sizes are only meaningful once selectiveJsMinifyPlugin has run.
      if (process.env.TAURI_DEBUG) return;
      const entry = Object.values(bundle).find(
        (chunk): chunk is OutputChunk =>
          chunk.type === "chunk" && chunk.isEntry && chunk.name === "main",
      );
      // A missing entry would switch the guard off without anyone noticing,
      // which is the kind of silent regression it exists to catch.
      if (!entry) {
        this.error(
          'Boot bundle budget: no entry chunk named "main" found. Update ' +
            "bootBundleBudgetPlugin if the build input key changed.",
        );
      }
      const seen = new Set<string>();
      const pending = [entry.fileName];
      let bytes = 0;
      let gzipBytes = 0;
      const offenders: string[] = [];
      while (pending.length > 0) {
        const fileName = pending.pop()!;
        if (seen.has(fileName)) continue;
        seen.add(fileName);
        const chunk = bundle[fileName];
        if (chunk?.type !== "chunk") continue;
        bytes += Buffer.byteLength(chunk.code);
        gzipBytes += gzipSync(chunk.code, { level: 9 }).length;
        if (chunk.moduleIds.some((id) => /\/node_modules\/(?:cesium|@cesium)\//.test(id))) {
          offenders.push(`${fileName} contains Cesium`);
        }
        pending.push(...chunk.imports);
      }
      const mb = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MB`;
      if (bytes > BOOT_BUDGET.rawBytes) {
        offenders.push(`boot JS is ${mb(bytes)}, over the ${mb(BOOT_BUDGET.rawBytes)} budget`);
      }
      if (gzipBytes > BOOT_BUDGET.gzipBytes) {
        offenders.push(
          `boot JS is ${mb(gzipBytes)} gzipped, over the ${mb(BOOT_BUDGET.gzipBytes)} gzip budget`,
        );
      }
      if (offenders.length > 0) {
        const largest = [...seen]
          .map((fileName) => bundle[fileName])
          .filter((chunk): chunk is OutputChunk => chunk?.type === "chunk")
          .sort((a, b) => b.code.length - a.code.length)
          .slice(0, 5)
          .map((chunk) => `  ${chunk.fileName} (${mb(Buffer.byteLength(chunk.code))})`);
        this.error(
          `Boot bundle regression: ${offenders.join("; ")}.\n` +
            `Largest statically imported chunks:\n${largest.join("\n")}\n` +
            "See CODE_SPLITTING_GROUPS and manualChunks in vite-chunking.ts.",
        );
      }
    },
  };
}

export function onwarn(warning: RollupLog, defaultHandler: WarningHandlerWithDefault): void {
  if (
    warning.code === "EVAL" &&
    typeof warning.id === "string" &&
    (warning.id.includes(GEOAGENT_BROWSER_BUNDLE) ||
      warning.id.includes(EARTH_ENGINE_CONTROL_BUNDLE) ||
      warning.id.includes(EARTH_ENGINE_BROWSER_BUNDLE))
  ) {
    return;
  }

  // Prebuilt third-party bundles (e.g. maplibre-gl-lidar's Emscripten/WASM
  // glue, a UMD lib inside maplibre-gl-components) assign to `module.exports`
  // behind `typeof module` guards. Rolldown flags this as a CommonJS variable
  // in an ESM file, but the guard makes it a no-op in the browser. Silence it
  // for vendored files only; a real occurrence in our own source still warns.
  if (warning.code === "COMMONJS_VARIABLE_IN_ESM") {
    const file =
      (typeof warning.id === "string" ? warning.id : undefined) ?? warning.loc?.file ?? "";
    if (file.includes("/node_modules/") || file.includes("\\node_modules\\")) {
      return;
    }
  }

  defaultHandler(warning);
}
