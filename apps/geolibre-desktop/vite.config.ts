import react from "@vitejs/plugin-react";
import { readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import type {
  RollupLog,
  RollupOptions,
  WarningHandlerWithDefault,
} from "rollup";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { bundledPlugins } from "./vite-plugins/bundled-plugins";
import { copyRtlText } from "./vite-plugins/copy-rtl-text";
import { copyVectorOps } from "./vite-plugins/copy-vector-ops";

const GEOAGENT_BROWSER_BUNDLE = "maplibre-gl-geoagent/dist/browser-";
const EARTH_ENGINE_CONTROL_BUNDLE = "maplibre-gl-earth-engine/dist/";
const EARTH_ENGINE_BROWSER_BUNDLE = "@google/earthengine/build/browser.js";
const GIS_CHUNK_WARNING_LIMIT_KB = 14000;
const APP_BASE = process.env.GEOLIBRE_APP_BASE;
const APP_VERSION = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
).version as string;

// Tauri sets TAURI_ENV_* env vars while running its beforeBuildCommand
// (`npm run build`), so their presence flags a desktop build. Used below to drop
// the service worker from the desktop bundle.
const IS_TAURI_BUILD = !!process.env.TAURI_ENV_PLATFORM;

// PGlite + PostGIS is ~25 MB raw and weighs ~22 MB inside the Tauri binary
// (postgis.tar is pre-gzipped, so brotli can't shrink it — it was the entire
// 42 → 63 MB binary regression). By default it is fetched from jsDelivr at
// runtime for every target — web, desktop, and embed — so it never inflates any
// build output. Override with GEOLIBRE_PGLITE_CDN=0 to force-bundle it for a
// fully offline build. The CDN URLs are pinned to the installed versions so they
// cannot drift from the lockfile; PGlite resolves its own .wasm/.data/postgis.tar
// relative to these. jsDelivr is already an allowed script-src in the web
// (docker/nginx.conf) and desktop (tauri.conf.json) CSPs — it serves Pyodide — so
// this adds no new external origin. Trade-off: the PostGIS SQL engine needs
// network on FIRST use. After that, the web build's service worker runtime-caches
// the jsDelivr-served Pyodide and PGlite/PostGIS engines (see the
// "geolibre-cdn-engines" CacheFirst rule below), so both the browser SQL and
// Python features keep working offline. (The desktop Tauri build has no service
// worker and still fetches these per the same first-use rule.)
const PGLITE_CDN = process.env.GEOLIBRE_PGLITE_CDN !== "0";

// PWA/offline support targets the standalone web build only. The Tauri desktop
// shell already works offline (assets are bundled in the binary), and the
// embedded Jupyter wheel (GEOLIBRE_EMBED=1) is served from inside a notebook
// where a service worker is meaningless and could even hijack the host page's
// scope. This is deliberately independent of PGLITE_CDN: the web build CDN-loads
// PGlite yet still ships a service worker.
const IS_EMBED = process.env.GEOLIBRE_EMBED === "1";
const PWA_DISABLED = IS_TAURI_BUILD || IS_EMBED;

const pgliteCdnRequire = createRequire(import.meta.url);
// The ESM entry of a package's manifest. Prefer the `module` field and the
// `import` condition of `exports` (both point at the ESM build); never fall back
// to `main`, which is the CJS entry (`dist/index.cjs` for PGlite) and would
// break the jsDelivr `import()` at runtime. Falls back to `dist/index.js`, the
// historical PGlite layout, if neither is declared.
function esmEntry(manifest: Record<string, unknown>): string {
  if (typeof manifest.module === "string") return manifest.module;
  const exportsRoot = (manifest.exports as Record<string, unknown> | undefined)?.[
    "."
  ];
  const importEntry = (exportsRoot as Record<string, unknown> | undefined)
    ?.import;
  const importDefault =
    typeof importEntry === "string"
      ? importEntry
      : (importEntry as Record<string, unknown> | undefined)?.default;
  if (typeof importDefault === "string") return importDefault;
  return "dist/index.js";
}
// These packages do not expose "./package.json" via their `exports`, so resolve
// a known file inside the package and walk up to the owning package.json (the
// one whose `name` matches) to read the installed version and entry paths — so a
// CDN URL tracks the lockfile and any future dist restructuring instead of
// hardcoding paths.
function findPackageManifest(
  startFile: string,
  pkg: string,
): { dir: string; manifest: Record<string, unknown> } {
  let dir = path.dirname(startFile);
  while (dir !== path.dirname(dir)) {
    try {
      const parsed = JSON.parse(
        readFileSync(path.join(dir, "package.json"), "utf8"),
      );
      if (parsed.name === pkg) return { dir, manifest: parsed };
    } catch {
      // Not this directory's package.json; keep walking up.
    }
    dir = path.dirname(dir);
  }
  throw new Error(`Could not resolve installed version of ${pkg}`);
}
function installedPackage(pkg: string): { version: string; entry: string } {
  const { manifest } = findPackageManifest(pgliteCdnRequire.resolve(pkg), pkg);
  return { version: manifest.version as string, entry: esmEntry(manifest) };
}
function pgliteCdnUrl(pkg: string): string | null {
  if (!PGLITE_CDN) return null;
  const { version, entry } = installedPackage(pkg);
  // Normalize a leading "./" from the manifest entry into the jsDelivr path.
  const entryPath = entry.replace(/^\.?\//, "");
  return `https://cdn.jsdelivr.net/npm/${pkg}@${version}/${entryPath}`;
}
const PGLITE_CDN_URL = pgliteCdnUrl("@electric-sql/pglite");
const PGLITE_POSTGIS_CDN_URL = pgliteCdnUrl("@electric-sql/pglite-postgis");

// CereusDB (Apache Sedona spatial SQL, compiled to WASM) ships a ~40 MB wasm
// blob that brotli only shrinks to ~8.6 MB — the entire 27 → 36 MB desktop
// installer growth in v1.3. Like PGlite above, fetch the wasm from jsDelivr at
// runtime for every target (web, desktop, embed) so it never inflates any build
// output; the small JS glue stays bundled and lazy-chunked. Override with
// GEOLIBRE_CEREUS_CDN=0 to force-bundle the wasm for a fully offline build. The
// URL is pinned to the installed version (so it tracks the lockfile) and jsDelivr
// is already an allowed connect-src in both the web (docker/nginx.conf) and
// desktop (tauri.conf.json) CSPs. Trade-off: the Sedona engine needs network on
// first use (the desktop app already fetches PGlite, Pyodide, tiles, and the
// DuckDB spatial extension the same way).
const CEREUS_CDN = process.env.GEOLIBRE_CEREUS_CDN !== "0";
function cereusWasmCdnUrl(): string | null {
  if (!CEREUS_CDN) return null;
  const pkg = "@cereusdb/standard";
  // The "./wasm" export resolves straight to the .wasm file; walk up to the
  // owning package.json for the installed version and the file's package-relative
  // path, so the URL tracks the lockfile and any future dist restructuring.
  const wasmFile = pgliteCdnRequire.resolve(`${pkg}/wasm`);
  const { dir, manifest } = findPackageManifest(wasmFile, pkg);
  const rel = path.relative(dir, wasmFile).split(path.sep).join("/");
  return `https://cdn.jsdelivr.net/npm/${pkg}@${manifest.version}/${rel}`;
}
const CEREUS_WASM_CDN_URL = cereusWasmCdnUrl();

// gdal3.js (GDAL compiled to WASM) powers the Georeferencer's client-side
// GeoTIFF/COG export. Its wasm (~28 MB) + data (~12 MB) are huge, so — like
// PGlite/Cereus above — fetch them from jsDelivr at runtime (version-pinned to
// the lockfile) so they never inflate any build; the small JS glue stays
// bundled and lazy-chunked, loaded only when the user exports. jsDelivr is
// already an allowed connect-src in both CSPs. Set GEOLIBRE_GDAL_CDN=0 to force
// network-free use (then the loader has no paths and export is unavailable).
const GDAL_CDN = process.env.GEOLIBRE_GDAL_CDN !== "0";
function gdal3CdnPaths(): { wasm: string; data: string } | null {
  if (!GDAL_CDN) return null;
  const { manifest } = findPackageManifest(
    pgliteCdnRequire.resolve("gdal3.js"),
    "gdal3.js",
  );
  const base = `https://cdn.jsdelivr.net/npm/gdal3.js@${manifest.version}/dist/package`;
  return {
    wasm: `${base}/gdal3WebAssembly.wasm`,
    data: `${base}/gdal3WebAssembly.data`,
  };
}
const GDAL3_CDN_PATHS = gdal3CdnPaths();
const WMS_PROXY_PATH = "/__geolibre_wms_proxy";
const WFS_PROXY_PATH = "/__geolibre_wfs_proxy";
const GPX_PROXY_PATH = "/__geolibre_gpx_proxy";
const RASTER_PROXY_PATH = "/__geolibre_raster_proxy";
const DUCKDB_WORKER_PATH_PART = "/@duckdb/duckdb-wasm/dist/";
const DUCKDB_WORKER_SOURCE_MAP_RE =
  /\n?\/\/# sourceMappingURL=duckdb-browser-(?:eh|mvp)\.worker\.js\.map\s*$/;
const EARTH_ENGINE_PARAMETER_ERROR = "Failed to locate function parameters";
const RADIX_OPTIMIZE_EXCLUDES = [
  "@developmentseed/geotiff",
  "@developmentseed/lzw-tiff-decoder",
  "@radix-ui/react-dialog",
  "@radix-ui/react-dropdown-menu",
  "@radix-ui/react-label",
  "@radix-ui/react-scroll-area",
  "@radix-ui/react-separator",
  "@radix-ui/react-slider",
  "@radix-ui/react-slot",
];

function manualChunks(id: string): string | undefined {
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
  if (id.includes("maplibre-gl")) return "maplibre";
  // Returning undefined hands remaining node_modules back to Rollup's default
  // chunking. We intentionally do not group them into a single "vendor" chunk:
  // that produced a circular manual-chunks warning. Do not re-add a catch-all
  // `return "vendor"` here without re-checking that warning.
  return undefined;
}

function onwarn(
  warning: RollupLog,
  defaultHandler: WarningHandlerWithDefault,
): void {
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
      (typeof warning.id === "string" ? warning.id : undefined) ??
      warning.loc?.file ??
      "";
    if (file.includes("/node_modules/") || file.includes("\\node_modules\\")) {
      return;
    }
  }

  defaultHandler(warning);
}

function wmsProxyPlugin(): Plugin {
  return {
    name: "geolibre-wms-proxy",
    configureServer(server) {
      server.middlewares.use(WMS_PROXY_PATH, async (req, res) => {
        try {
          await proxyWmsRequest(req, res);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "WMS proxy request failed";
          res.statusCode = 502;
          res.setHeader("content-type", "text/plain");
          res.end(message);
        }
      });
      server.middlewares.use(WFS_PROXY_PATH, async (req, res) => {
        try {
          await proxyBinaryRequest(req, res, WFS_PROXY_PATH);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "WFS proxy request failed";
          res.statusCode = 502;
          res.setHeader("content-type", "text/plain");
          res.end(message);
        }
      });
      server.middlewares.use(GPX_PROXY_PATH, async (req, res) => {
        try {
          await proxyBinaryRequest(req, res, GPX_PROXY_PATH);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "GPX proxy request failed";
          res.statusCode = 502;
          res.setHeader("content-type", "text/plain");
          res.end(message);
        }
      });
      server.middlewares.use(RASTER_PROXY_PATH, async (req, res) => {
        try {
          await proxyBinaryRequest(req, res, RASTER_PROXY_PATH);
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "Raster proxy request failed";
          res.statusCode = 502;
          res.setHeader("content-type", "text/plain");
          res.end(message);
        }
      });
    },
  };
}

function stripDuckDbWorkerSourcemapPlugin(): Plugin {
  return {
    name: "geolibre-strip-duckdb-worker-sourcemap",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const requestUrl = new URL(req.url ?? "/", "http://localhost");
        const decodedPath = safeDecodeURIComponent(requestUrl.pathname);
        if (requestUrl.search || !isDuckDbWorkerRequest(decodedPath)) {
          next();
          return;
        }

        const workerFile = path.join(
          __dirname,
          "../../node_modules",
          decodedPath.slice(decodedPath.indexOf(DUCKDB_WORKER_PATH_PART) + 1),
        );
        const source = readFileSync(workerFile, "utf8").replace(
          DUCKDB_WORKER_SOURCE_MAP_RE,
          "",
        );
        res.statusCode = 200;
        res.setHeader("content-type", "application/javascript");
        res.end(source);
      });
    },
    generateBundle(_, bundle) {
      for (const asset of Object.values(bundle)) {
        if (
          asset.type === "asset" &&
          /duckdb-browser-(?:eh|mvp)\.worker-[\w-]+\.js$/.test(asset.fileName)
        ) {
          const source =
            typeof asset.source === "string"
              ? asset.source
              : Buffer.from(asset.source).toString("utf8");
          asset.source = source.replace(DUCKDB_WORKER_SOURCE_MAP_RE, "");
        }
      }
    },
  };
}

function selectiveJsMinifyPlugin(): Plugin {
  return {
    name: "geolibre-selective-js-minify",
    apply: "build",
    async generateBundle(_, bundle) {
      if (process.env.TAURI_DEBUG) return;

      const { transform } = await import("esbuild");
      await Promise.all(
        Object.values(bundle).map(async (asset) => {
          if (asset.type !== "chunk") return;
          if (shouldPreserveEarthEngineChunk(asset.fileName, asset.code)) {
            return;
          }

          const result = await transform(asset.code, {
            legalComments: "none",
            minify: true,
            target: "esnext",
          });
          asset.code = result.code;
        }),
      );
    },
  };
}

function shouldPreserveEarthEngineChunk(
  fileName: string,
  code: string,
): boolean {
  return (
    fileName.includes("earth-engine") ||
    fileName.includes("maplibre-geoagent") ||
    code.includes(EARTH_ENGINE_PARAMETER_ERROR)
  );
}

function isDuckDbWorkerRequest(pathname: string): boolean {
  return (
    pathname.includes(DUCKDB_WORKER_PATH_PART) &&
    /duckdb-browser-(?:eh|mvp)\.worker\.js$/.test(pathname)
  );
}

// Embed build only: redirect imports of `./pglite-loader` to the CDN variant so
// the bundled PGlite/PostGIS packages (and their ~25 MB of WASM/data/postgis.tar)
// are removed from the graph entirely. A bundler emits a chunk for every parsed
// `import()` regardless of dead-code reachability, so swapping the whole module
// is the only reliable way to keep those assets out of the wheel.
function pgliteCdnLoaderPlugin(): Plugin {
  const cdnLoader = path.resolve(__dirname, "src/lib/pglite-loader.cdn.ts");
  return {
    name: "geolibre-pglite-cdn-loader",
    enforce: "pre",
    resolveId(source) {
      // Match `./pglite-loader` (and `.ts`) but never `pglite-loader.cdn`.
      return /(?:^|\/)pglite-loader(?:\.ts)?$/.test(source) ? cdnLoader : null;
    },
  };
}

// Keep the ~40 MB CereusDB wasm out of `dist` (and out of the Tauri binary) in
// two places, both required:
//   1. Swap the bundled loader for the CDN one so cereus-loader.ts's
//      `@cereusdb/standard/wasm?url` import is dropped from the module graph (a
//      bundler emits the asset for every `?url` import it parses, so this must be
//      a module swap, not an `if` inside one module — same reasoning as PGlite).
//   2. Neutralize wasm-bindgen's own default `new URL('cereusdb_bg.wasm',
//      import.meta.url)` inside the package glue. We always init CereusDB with an
//      explicit `wasmUrl` (the CDN), so that default branch is dead at runtime —
//      but Vite statically emits the asset from the `new URL(..., import.meta.url)`
//      pattern regardless of reachability, which re-introduced the 40 MB file.
const CEREUS_WASM_GLUE = "@cereusdb/standard/dist/wasm/cereusdb.js";
const CEREUS_DEFAULT_WASM_URL = "new URL('cereusdb_bg.wasm', import.meta.url)";
function cereusCdnLoaderPlugin(): Plugin {
  const cdnLoader = path.resolve(__dirname, "src/lib/cereus-loader.cdn.ts");
  return {
    name: "geolibre-cereus-cdn-loader",
    enforce: "pre",
    resolveId(source) {
      // Match `./cereus-loader` (and `.ts`) but never `cereus-loader.cdn`.
      return /(?:^|\/)cereus-loader(?:\.ts)?$/.test(source) ? cdnLoader : null;
    },
    transform(code, id) {
      const file = id.split("?")[0].replaceAll("\\", "/");
      if (!file.endsWith(CEREUS_WASM_GLUE)) return null;
      if (!code.includes(CEREUS_DEFAULT_WASM_URL)) {
        // The glue is here but the expected expression is gone — most likely a
        // new @cereusdb/standard shipped a different wasm-bindgen string or dist
        // path. Warn loudly instead of silently returning null, which would let
        // Vite re-emit the 40 MB wasm into dist with no error and a green CI.
        this.warn(
          `${CEREUS_WASM_GLUE} no longer contains the expected default wasm URL ` +
            `expression; the ~40 MB wasm may be silently re-emitted into dist. ` +
            `Update CEREUS_WASM_GLUE / CEREUS_DEFAULT_WASM_URL in vite.config.ts.`,
        );
        return null;
      }
      // Replace the dead default-path expression so Vite never sees the asset.
      // replaceAll: wasm-bindgen can emit the pattern more than once (sync + async
      // init paths). If the branch is somehow reached (init with no wasmUrl),
      // throw clearly. map:null is fine — the replacement adds no newlines, so
      // only columns on this one line shift; per-line stepping stays correct, and
      // sourcemaps are off anyway unless TAURI_DEBUG.
      return {
        code: code.replaceAll(
          CEREUS_DEFAULT_WASM_URL,
          "(()=>{throw new Error('CereusDB must be initialised with an explicit wasmUrl (GEOLIBRE_CEREUS_CDN build)')})()",
        ),
        map: null,
      };
    },
  };
}

function duckdbWasmBundlesPlugin(): Plugin {
  const modulePath = path.resolve(
    __dirname,
    IS_TAURI_BUILD
      ? "src/lib/duckdb-wasm-bundles.tauri.ts"
      : "src/lib/duckdb-wasm-bundles.ts",
  );
  return {
    name: "geolibre-duckdb-wasm-bundles",
    enforce: "pre",
    resolveId(source) {
      return /(?:^|\/)duckdb-wasm-bundles(?:\.ts)?$/.test(source)
        ? modulePath
        : null;
    },
  };
}

function removeJupyterLiteFromTauriDistPlugin(): Plugin {
  return {
    name: "geolibre-remove-jupyterlite-from-tauri-dist",
    apply: "build",
    closeBundle() {
      if (!IS_TAURI_BUILD) return;
      rmSync(path.resolve(__dirname, "dist/jupyterlite"), {
        recursive: true,
        force: true,
      });
    },
  };
}

function projectUrlQueryPlugin(): Plugin {
  return {
    name: "geolibre-project-url-query",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (isProjectUrlDocumentRequest(req)) {
          const requestUrl = new URL(req.url ?? "/", "http://localhost");
          req.url = requestUrl.pathname;
        }
        next();
      });
    },
  };
}

function isProjectUrlDocumentRequest(req: IncomingMessage): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;

  const accept = req.headers.accept ?? "";
  if (!accept.includes("text/html") && accept !== "*/*") return false;

  const requestUrl = new URL(req.url ?? "/", "http://localhost");
  if (requestUrl.pathname !== "/" && requestUrl.pathname !== "/index.html") {
    return false;
  }

  return (
    requestUrl.searchParams.has("url") ||
    requestUrl.searchParams.has("project") ||
    requestUrl.searchParams.has("projectUrl") ||
    requestUrl.searchParams.has("project_url") ||
    /^https?:\/\//i.test(safeDecodeURIComponent(requestUrl.search.slice(1)))
  );
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function proxyWmsRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  await proxyBinaryRequest(req, res, WMS_PROXY_PATH);
}

async function proxyBinaryRequest(
  req: IncomingMessage,
  res: ServerResponse,
  proxyPath: string,
): Promise<void> {
  const requestUrl = new URL(req.url ?? "", `http://localhost${proxyPath}`);
  const target = requestUrl.searchParams.get("url");
  if (!target || !/^https?:\/\//i.test(target)) {
    res.statusCode = 400;
    res.setHeader("content-type", "text/plain");
    res.end("Missing or invalid target URL");
    return;
  }

  const headers = new Headers();
  const range = req.headers.range;
  if (range) headers.set("range", range);

  const response = await fetch(target, { headers });
  const contentType =
    response.headers.get("content-type") ?? "application/octet-stream";
  const body = Buffer.from(await response.arrayBuffer());

  res.statusCode = response.status;
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("cache-control", "public, max-age=3600");
  res.setHeader("content-type", contentType);
  for (const header of ["accept-ranges", "content-range"]) {
    const value = response.headers.get(header);
    if (value) res.setHeader(header, value);
  }
  // Derive content-length from the buffered body, never the upstream header:
  // fetch() transparently decompresses gzip/br responses, so the upstream
  // content-length (the compressed size) would be smaller than the body we
  // send and truncate it in the browser. The buffer length is correct for both
  // full (200) and partial (206 + content-range) responses.
  res.setHeader("content-length", String(body.byteLength));
  res.end(body);
}

// Installable, offline-capable web build. See docs/architecture.md (Offline /
// PWA). The service worker precaches the app shell (HTML + the JS/CSS chunks the
// map needs to boot) and runtime-caches the heavy, lazily-fetched same-origin
// binaries (DuckDB-WASM + spatial extension, MapLibre feature plugins) with a
// hash-keyed CacheFirst strategy, so a feature works offline after its first
// online use without bloating the first-visit precache. PGlite/PostGIS and the
// Pyodide runtime are fetched cross-origin from jsDelivr (see PGLITE_CDN above),
// so they are not same-origin cacheable: the PostGIS SQL engine needs network on
// first use and is not available offline. The pglite-*/*.wasm/*.data ignores
// below still apply when GEOLIBRE_PGLITE_CDN=0 force-bundles PGlite into the
// web build, keeping that variant's first visit light.
function pwaPlugin(): Plugin[] {
  // Hashed build chunks/binaries that are lazily fetched. Excluded from the
  // precache so first visit stays light; the same-origin CacheFirst rule below
  // caches them on first use for offline. Hashed filenames make CacheFirst safe
  // (a redeploy mints new URLs, so a stale entry is never served as current).
  const HEAVY_PRECACHE_IGNORES = [
    // MapLibre core (~13 MB) and its feature-plugin chunks. The map boots from
    // its first runtime fetch and is CacheFirst-cached thereafter.
    "**/maplibre-*",
    "**/duckdb-*",
    "**/pglite-*",
    "**/earth-engine-browser-*",
    "**/mapillary-*",
    "**/*.wasm",
    "**/*.data",
    // The self-hosted JupyterLite site (apps/.../public/jupyterlite/, ~70 MB of
    // JS/HTML) is loaded on demand inside the Notebook panel's iframe and has
    // its own service worker scoped to /jupyterlite/. Keep it entirely out of
    // the app shell precache, or first visit would balloon by thousands of files.
    "**/jupyterlite/**",
  ];
  // Note: the 4 KB public/pyodide/pyodide-worker.js shim is intentionally left
  // in the precache (revisioned, so no stale-after-deploy risk). The heavy
  // Pyodide runtime it loads is fetched from the jsDelivr CDN (cross-origin) and
  // is not cached — Pyodide offline needs a same-origin VITE_PYODIDE_INDEX_URL
  // mirror. See docs/architecture.md.

  return VitePWA({
    disable: PWA_DISABLED,
    // autoUpdate installs the new SW and lets it take control on the next
    // deploy (skipWaiting + clientsClaim below), so its fresh precache serves
    // subsequent requests. We deliberately suppress workbox's default
    // force-reload-on-activate via `onNeedReload` in main.tsx — that reload
    // fired spuriously on the relative-base `/demo/` subpath and discarded map
    // state. Page refreshes are left to installStaleChunkReload
    // (src/lib/stale-chunk-reload.ts), which reloads on-demand only when a now
    // orphaned lazy chunk actually 404s; precached chunks never 404.
    registerType: "autoUpdate",
    // We register the SW by hand in main.tsx so registration lives next to the
    // stale-chunk reload it coordinates with; no auto-injected snippet.
    injectRegister: false,
    includeAssets: ["favicon.ico", "favicon.png", "apple-touch-icon.png"],
    manifest: {
      name: "GeoLibre",
      short_name: "GeoLibre",
      description:
        "A free and open-source, lightweight, cloud-native GIS platform for visualizing, exploring, and analyzing geospatial data, running in the browser, on the desktop, on mobile, and inside Jupyter notebooks while keeping your data local and private.",
      theme_color: "#2f8f85",
      background_color: "#ffffff",
      display: "standalone",
      orientation: "any",
      categories: ["productivity", "utilities", "education"],
      icons: [
        { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
        { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
        {
          src: "maskable-icon-512x512.png",
          sizes: "512x512",
          type: "image/png",
          purpose: "maskable",
        },
      ],
    },
    workbox: {
      // Precache the app shell: HTML plus the JS/CSS/fonts that boot the map.
      // The heavy lazily-fetched chunks/binaries are runtime-cached instead.
      globPatterns: ["**/*.{js,css,html,woff,woff2}"],
      globIgnores: HEAVY_PRECACHE_IGNORES,
      // deck.gl/vendor shell chunks can run a few MB; allow them into the
      // precache. MapLibre and the huge binaries are globIgnored above.
      maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      cleanupOutdatedCaches: true,
      clientsClaim: true,
      skipWaiting: true,
      navigateFallback: "index.html",
      // Never SPA-fallback the sidecar proxy or any asset request; let those hit
      // the network/precache directly.
      navigateFallbackDenylist: [/^\/sidecar\//, /^\/__geolibre_/, /\/[^/?]+\.[^/]+$/],
      runtimeCaching: [
        {
          // Hashed build assets under /assets/ that the precache skips: the
          // MapLibre chunk, DuckDB-WASM + its spatial extension, PGlite/PostGIS,
          // and the MapLibre feature-plugin chunks. Vite content-hashes every
          // file it emits here, so CacheFirst is safe (a redeploy mints new
          // URLs). This is what makes DuckDB-WASM + the spatial extension work
          // offline after their first online use. Scoped to /assets/ so the
          // non-hashed public files (e.g. pyodide-worker.js, dropped-in plugin
          // bundles) are not pinned by hash-immutable CacheFirst — those are
          // served from the revisioned precache and refresh on a SW update.
          urlPattern: ({ url, sameOrigin }: { url: URL; sameOrigin: boolean }) =>
            sameOrigin &&
            url.pathname.includes("/assets/") &&
            /\.(?:js|css|wasm|data|woff2?)$/.test(url.pathname),
          handler: "CacheFirst",
          options: {
            cacheName: "geolibre-assets",
            expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 30 },
            cacheableResponse: { statuses: [0, 200] },
          },
        },
        {
          // CDN-loaded heavy engines: Pyodide (the Python runtime + its wheels),
          // PGlite/PostGIS, and the CereusDB (Apache Sedona) wasm — all served
          // version-pinned from jsDelivr (see PGLITE_CDN_URL, CEREUS_WASM_CDN_URL,
          // and pyodide-config.ts). Their URLs embed the exact package version, so
          // a redeploy/upgrade mints new URLs and CacheFirst never serves a stale
          // engine. Caching them here is what lets the browser SQL (PostGIS),
          // Sedona SQL, and Python features work OFFLINE after their first online
          // use — closing the gap noted at the top of this file. jsDelivr sends
          // permissive CORS headers, so these come back as normal (non-opaque)
          // 200s and can be revalidated/evicted like any cache entry. When
          // GEOLIBRE_PGLITE_CDN=0 / GEOLIBRE_CEREUS_CDN=0, those engines are
          // bundled under /assets/ instead and this rule simply never matches them
          // (Pyodide is always CDN-loaded regardless).
          urlPattern: ({ url }: { url: URL }) =>
            url.hostname === "cdn.jsdelivr.net" &&
            (url.pathname.startsWith("/pyodide/") ||
              url.pathname.startsWith("/npm/@electric-sql/") ||
              url.pathname.startsWith("/npm/@cereusdb/") ||
              url.pathname.startsWith("/npm/gdal3.js")),
          handler: "CacheFirst",
          options: {
            cacheName: "geolibre-cdn-engines",
            expiration: { maxEntries: 400, maxAgeSeconds: 60 * 60 * 24 * 30 },
            cacheableResponse: { statuses: [0, 200] },
          },
        },
        {
          // Basemap tiles/styles from the CORS-friendly default hosts only
          // (OpenFreeMap, CARTO). Other remote tiles/services stay network-only
          // by design — see docs for what is and isn't available offline.
          urlPattern: ({ url }: { url: URL }) =>
            /(?:^|\.)(?:openfreemap\.org|cartocdn\.com)$/.test(url.hostname),
          handler: "CacheFirst",
          options: {
            // Generous cap: the "Download Offline Area" feature
            // (lib/offline-tiles.ts) warms a whole region's tiles at once and
            // would otherwise evict its own freshly-cached tiles past 600.
            cacheName: "geolibre-basemaps",
            expiration: { maxEntries: 8000, maxAgeSeconds: 60 * 60 * 24 * 30 },
            cacheableResponse: { statuses: [0, 200] },
          },
        },
      ],
    },
    devOptions: {
      // Keep the SW out of `vite dev`; it complicates HMR and the stale-chunk
      // flow. PWA behavior is validated against the production build / preview.
      enabled: false,
    },
  }) as Plugin[];
}

export default defineConfig({
  base: APP_BASE,
  plugins: [
    ...(PGLITE_CDN ? [pgliteCdnLoaderPlugin()] : []),
    ...(CEREUS_CDN ? [cereusCdnLoaderPlugin()] : []),
    duckdbWasmBundlesPlugin(),
    stripDuckDbWorkerSourcemapPlugin(),
    projectUrlQueryPlugin(),
    bundledPlugins(path.resolve(__dirname, "public/plugins")),
    copyVectorOps(
      path.resolve(
        __dirname,
        "../../backend/geolibre_server/geolibre_server/vector_ops.py",
      ),
      path.resolve(__dirname, "src/lib/pyodide/vector_ops.generated.py"),
    ),
    copyRtlText(
      path.resolve(__dirname, "src/lib/vendor/mapbox-gl-rtl-text.generated.js"),
    ),
    react(),
    wmsProxyPlugin(),
    selectiveJsMinifyPlugin(),
    removeJupyterLiteFromTauriDistPlugin(),
    ...pwaPlugin(),
  ],
  clearScreen: false,
  define: {
    __GEOLIBRE_VERSION__: JSON.stringify(APP_VERSION),
    __PGLITE_CDN_URL__: JSON.stringify(PGLITE_CDN_URL),
    __PGLITE_POSTGIS_CDN_URL__: JSON.stringify(PGLITE_POSTGIS_CDN_URL),
    __CEREUS_WASM_CDN_URL__: JSON.stringify(CEREUS_WASM_CDN_URL),
    __GDAL3_CDN_PATHS__: JSON.stringify(GDAL3_CDN_PATHS),
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  worker: {
    format: "es",
  },
  envPrefix: ["VITE_", "TAURI_"],
  optimizeDeps: {
    // Pre-bundle the AI Assistant's heavy deps at dev-server startup. They are
    // only reached through the lazily-imported assistant panel (and, for the
    // provider models, through dynamic import() inside it), so Vite would
    // otherwise discover them on first open and trigger a full-page reload to
    // re-optimize — which manifests as the map reloading and the panel needing
    // a second click. Listing them here pre-bundles them up front instead.
    include: [
      "@strands-agents/sdk",
      "@strands-agents/sdk/models/google",
      "@strands-agents/sdk/models/anthropic",
      "@strands-agents/sdk/models/openai",
      "@strands-agents/sdk/models/bedrock",
      "@anthropic-ai/sdk",
      "@google/genai",
      "openai",
      "zod",
      // cog-tiler-wasm's plain-JS deps (the wasm tiler itself is excluded below
      // so its asset URL survives). These are only reached through that lazy
      // engine, so without pre-bundling Vite discovers them on first use and
      // triggers a full-page reload to re-optimize. (geotiff is already
      // pre-bundled via the deck.gl-geotiff static import.)
      "proj4",
      "geotiff-geokeys-to-proj4",
    ],
    // PGlite ships its own WASM + filesystem bundles and must not be pre-bundled
    // by esbuild, which mangles those asset references (per PGlite's Vite guide).
    // CereusDB (the WASM Sedona engine) is excluded for the same reason, and
    // because its wasm-bindgen glue imports `./env_shim.js?v=...` — that query
    // suffix breaks the dev-server dependency optimizer, so it must be served
    // as-is rather than pre-bundled.
    exclude: [
      ...RADIX_OPTIMIZE_EXCLUDES,
      "@electric-sql/pglite",
      "@electric-sql/pglite-postgis",
      "@cereusdb/standard",
      // geolibre-wasm/tools loads its bundled geolibre-cli.wasm via
      // `new URL("./geolibre-cli.wasm", import.meta.url)`; esbuild pre-bundling
      // mangles that asset reference, so serve it as-is. whitebox-wasm is still
      // pulled in transitively (cog-tiler-wasm's peer dependency) and loads its
      // wasm-bindgen asset the same way, so keep it excluded too.
      "geolibre-wasm",
      "whitebox-wasm",
      // cog-tiler-wasm (the lazy CPU/WASM raster tiler) loads its
      // cog_tiler_wasm_bg.wasm the same wasm-bindgen way; esbuild pre-bundling
      // breaks that asset reference so the tiler stops rendering. Serve it
      // as-is. (Its plain-JS deps are pre-bundled via optimizeDeps.include.)
      "cog-tiler-wasm",
    ],
  },
  build: {
    target: "esnext",
    // The Earth Engine browser SDK keys EXPORTED_FN_INFO by Function#toString().
    // A second Vite/esbuild minification pass rewrites those functions after
    // the SDK table has been generated. Vite minification stays disabled here;
    // selectiveJsMinifyPlugin minifies chunks that do not contain that SDK.
    minify: false,
    sourcemap: !!process.env.TAURI_DEBUG,
    chunkSizeWarningLimit: GIS_CHUNK_WARNING_LIMIT_KB,
    rollupOptions: {
      onwarn,
      output: {
        manualChunks,
      },
    } satisfies RollupOptions,
  },
  resolve: {
    dedupe: ["react", "react-dom", "maplibre-gl"],
    alias: {
      "@": path.resolve(__dirname, "./src"),
      module: path.resolve(__dirname, "./src/lib/browser-node-module.ts"),
    },
  },
});
