import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
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
// network on first use and is not cached for offline use (the desktop app already
// fetches map tiles, Pyodide, the DuckDB spatial extension, and H3 the same way).
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
// The PGlite packages do not expose "./package.json" via their `exports`, so
// resolve the package entry and walk up to its package.json to read the
// installed version and ESM entry path (so the CDN URL tracks the lockfile and
// any future dist restructuring instead of hardcoding `/dist/index.js`).
function installedPackage(pkg: string): { version: string; entry: string } {
  let dir = path.dirname(pgliteCdnRequire.resolve(pkg));
  while (dir !== path.dirname(dir)) {
    const manifest = path.join(dir, "package.json");
    try {
      const parsed = JSON.parse(readFileSync(manifest, "utf8"));
      if (parsed.name === pkg) {
        return { version: parsed.version as string, entry: esmEntry(parsed) };
      }
    } catch {
      // Not this directory's package.json; keep walking up.
    }
    dir = path.dirname(dir);
  }
  throw new Error(`Could not resolve installed version of ${pkg}`);
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
  if (id.includes("@duckdb/duckdb-wasm")) return "duckdb";
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
  for (const header of ["accept-ranges", "content-length", "content-range"]) {
    const value = response.headers.get(header);
    if (value) res.setHeader(header, value);
  }
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
        "A lightweight, cloud-native GIS platform for visualizing, exploring, and analyzing geospatial data.",
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
          // Basemap tiles/styles from the CORS-friendly default hosts only
          // (OpenFreeMap, CARTO). Other remote tiles/services stay network-only
          // by design — see docs for what is and isn't available offline.
          urlPattern: ({ url }: { url: URL }) =>
            /(?:^|\.)(?:openfreemap\.org|cartocdn\.com)$/.test(url.hostname),
          handler: "CacheFirst",
          options: {
            cacheName: "geolibre-basemaps",
            expiration: { maxEntries: 600, maxAgeSeconds: 60 * 60 * 24 * 7 },
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
    react(),
    wmsProxyPlugin(),
    selectiveJsMinifyPlugin(),
    ...pwaPlugin(),
  ],
  clearScreen: false,
  define: {
    __GEOLIBRE_VERSION__: JSON.stringify(APP_VERSION),
    __PGLITE_CDN_URL__: JSON.stringify(PGLITE_CDN_URL),
    __PGLITE_POSTGIS_CDN_URL__: JSON.stringify(PGLITE_POSTGIS_CDN_URL),
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
    // PGlite ships its own WASM + filesystem bundles and must not be pre-bundled
    // by esbuild, which mangles those asset references (per PGlite's Vite guide).
    exclude: [
      ...RADIX_OPTIMIZE_EXCLUDES,
      "@electric-sql/pglite",
      "@electric-sql/pglite-postgis",
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
