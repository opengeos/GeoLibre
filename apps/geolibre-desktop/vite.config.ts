import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type {
  RollupLog,
  RollupOptions,
  WarningHandlerWithDefault,
} from "rollup";
import { defineConfig, type Plugin } from "vite";

const GEOAGENT_BROWSER_BUNDLE = "maplibre-gl-geoagent/dist/browser-";
const EARTH_ENGINE_BROWSER_BUNDLE = "@google/earthengine/build/browser.js";
const GIS_CHUNK_WARNING_LIMIT_KB = 5000;
const APP_BASE = process.env.GEOLIBRE_APP_BASE;
const APP_VERSION = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
).version as string;
const WMS_PROXY_PATH = "/__geolibre_wms_proxy";
const WFS_PROXY_PATH = "/__geolibre_wfs_proxy";
const RASTER_PROXY_PATH = "/__geolibre_raster_proxy";
const DUCKDB_WORKER_PATH_PART = "/@duckdb/duckdb-wasm/dist/";
const DUCKDB_WORKER_SOURCE_MAP_RE =
  /\n?\/\/# sourceMappingURL=duckdb-browser-(?:eh|mvp)\.worker\.js\.map\s*$/;
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
  if (
    id.includes("maplibre-gl-geoagent") ||
    id.includes("@google/earthengine")
  ) {
    return "maplibre-geoagent";
  }
  if (id.includes("mapillary-js")) return "mapillary";
  if (id.includes("@geoman-io/maplibre-geoman-free")) return "maplibre-geoman";
  if (id.includes("maplibre-gl")) return "maplibre";
  return "vendor";
}

function onwarn(
  warning: RollupLog,
  defaultHandler: WarningHandlerWithDefault,
): void {
  if (
    warning.code === "EVAL" &&
    typeof warning.id === "string" &&
    (warning.id.includes(GEOAGENT_BROWSER_BUNDLE) ||
      warning.id.includes(EARTH_ENGINE_BROWSER_BUNDLE))
  ) {
    return;
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

function isDuckDbWorkerRequest(pathname: string): boolean {
  return (
    pathname.includes(DUCKDB_WORKER_PATH_PART) &&
    /duckdb-browser-(?:eh|mvp)\.worker\.js$/.test(pathname)
  );
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

export default defineConfig({
  base: APP_BASE,
  plugins: [
    stripDuckDbWorkerSourcemapPlugin(),
    projectUrlQueryPlugin(),
    react(),
    wmsProxyPlugin(),
  ],
  clearScreen: false,
  define: {
    __GEOLIBRE_VERSION__: JSON.stringify(APP_VERSION),
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
    esbuildOptions: {
      target: "esnext",
    },
    exclude: RADIX_OPTIMIZE_EXCLUDES,
  },
  build: {
    target: "esnext",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
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
    },
  },
});
