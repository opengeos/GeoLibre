// Guards the jsDelivr `script-src` allowlist of the desktop CSP (#2858) and the
// web build's nginx CSP (#2875).
//
// The Tauri CSP no longer allows all of `https://cdn.jsdelivr.net/npm/`; it
// lists one version-pinned path per package the app actually executes from the
// CDN. Each of those versions is owned by something else (a lockfile entry, a
// constant in our code, or a URL hard-coded inside an upstream package), so a
// dependency bump can move the URL the app requests without touching
// tauri.conf.json. The packaged app then fails at runtime with a CSP block that
// no other test sees (`tauri dev` does not apply the CSP). This file re-derives
// every pinned path from its owner and fails when they disagree. The Docker web
// build (docker/nginx.conf) executes the same scripts, so its app policy must
// list exactly the same paths.
//
// See docs/maintenance.md#desktop-csp-script-src-allowlist.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";
import { PYODIDE_VERSION } from "../apps/geolibre-desktop/src/lib/pyodide/pyodide-config";
import { ORT_VERSION } from "../packages/processing/src/ort";

const ROOT = path.resolve(import.meta.dirname, "..");
const JSDELIVR = "https://cdn.jsdelivr.net/";

/**
 * Read one directive's source list from a CSP string.
 *
 * Args:
 *   csp: The whole policy.
 *   name: The directive name, e.g. "script-src".
 *
 * Returns:
 *   The directive's sources, in order.
 */
function directiveOf(csp: string, name: string): string[] {
  const directive = csp
    .split(";")
    .map((part) => part.trim().split(/\s+/))
    .find(([directiveName]) => directiveName === name);
  assert.ok(directive, `CSP has no ${name} directive`);
  return directive.slice(1);
}

/**
 * Read one directive's source list from the desktop CSP.
 *
 * Args:
 *   name: The directive name, e.g. "script-src".
 *
 * Returns:
 *   The directive's sources, in order.
 */
function cspDirective(name: string): string[] {
  const conf = JSON.parse(
    readFileSync(path.join(ROOT, "apps/geolibre-desktop/src-tauri/tauri.conf.json"), "utf8"),
  ) as { app: { security: { csp: string } } };
  return directiveOf(conf.app.security.csp, name);
}

/**
 * Read the Content-Security-Policy each nginx `location` block of the web build
 * sends, as the container serves it with no optional integration configured.
 *
 * docker/entrypoint.sh renders the template by replacing each
 * `__GEOLIBRE_*__` placeholder with a value that carries its own leading space,
 * or with nothing when the integration is unset, so the placeholders are
 * dropped here the same way.
 *
 * Returns:
 *   The policy keyed by the `location` line's match (e.g. "/" or
 *   "^~ /jupyterlite/").
 */
function nginxPolicies(): Map<string, string> {
  const conf = readFileSync(path.join(ROOT, "docker/nginx.conf"), "utf8");
  const policies = new Map<string, string>();
  let location: string | undefined;
  for (const line of conf.split("\n")) {
    const locationMatch = line.match(/^\s*location\s+(.+?)\s*\{/);
    if (locationMatch) location = locationMatch[1];
    const cspMatch = line.match(/^\s*add_header\s+Content-Security-Policy\s+"([^"]*)"/);
    if (!cspMatch) continue;
    assert.ok(location, "Content-Security-Policy header outside a location block");
    assert.ok(!policies.has(location), `location ${location} sets two CSP headers`);
    policies.set(location, cspMatch[1].replace(/__GEOLIBRE_[A-Z0-9_]+__/g, ""));
  }
  return policies;
}

/**
 * Read one directive from the CSP an nginx `location` block sends.
 *
 * Args:
 *   location: The `location` match, e.g. "/".
 *   name: The directive name, e.g. "script-src".
 *
 * Returns:
 *   The directive's sources, in order.
 */
function nginxDirective(location: string, name: string): string[] {
  const policy = nginxPolicies().get(location);
  assert.ok(policy, `docker/nginx.conf location ${location} sends no CSP`);
  return directiveOf(policy, name);
}

/**
 * Keep only the jsDelivr sources of a directive, sorted.
 *
 * Args:
 *   sources: A directive's source list.
 *
 * Returns:
 *   The sources under https://cdn.jsdelivr.net/, sorted.
 */
function jsdelivrSources(sources: string[]): string[] {
  return sources.filter((source) => source.startsWith(JSDELIVR)).sort();
}

// Sources that would let a page run any script on jsDelivr.
const BROAD_JSDELIVR_SOURCES = [
  "https://cdn.jsdelivr.net",
  "https://cdn.jsdelivr.net/",
  "https://cdn.jsdelivr.net/npm/",
  "https://cdn.jsdelivr.net/pyodide/",
  "https://cdn.jsdelivr.net/gh/",
  "https:",
  "*",
];

/**
 * Resolve the installed version of a package as seen from a workspace.
 *
 * Walks up from the resolved entry file to the package.json whose name matches,
 * because several of these packages do not export "./package.json".
 *
 * Args:
 *   pkg: The package name.
 *   fromWorkspace: Workspace directory (relative to the repo root) to resolve from.
 *
 * Returns:
 *   The package directory and its version.
 */
function installedPackage(pkg: string, fromWorkspace: string): { dir: string; version: string } {
  const require = createRequire(path.join(ROOT, fromWorkspace, "package.json"));
  let dir = path.dirname(require.resolve(pkg));
  while (dir !== path.dirname(dir)) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
      if (manifest.name === pkg) return { dir, version: manifest.version as string };
    } catch {
      // No package.json at this level; keep walking up.
    }
    dir = path.dirname(dir);
  }
  throw new Error(`Could not find the installed ${pkg}`);
}

/**
 * Collect the jsDelivr URLs hard-coded in maplibre-gl-vector's ESM build.
 *
 * Returns:
 *   Every `https://cdn.jsdelivr.net/...` string literal in its dist/*.js files.
 */
function maplibreGlVectorCdnUrls(): string[] {
  const { dir } = installedPackage("maplibre-gl-vector", "packages/plugins");
  const distDir = path.join(dir, "dist");
  const urls = new Set<string>();
  for (const file of readdirSync(distDir)) {
    if (!file.endsWith(".js") && !file.endsWith(".mjs")) continue;
    const source = readFileSync(path.join(distDir, file), "utf8");
    for (const match of source.matchAll(/["'`](https:\/\/cdn\.jsdelivr\.net\/[^"'`]+)["'`]/g)) {
      urls.add(match[1]);
    }
  }
  return [...urls].sort();
}

// The modules jsDelivr's `/+esm` bundles import for the maplibre-gl-vector
// entries below. jsDelivr pins these when it first builds the bundle, so they
// only change when maplibre-gl-vector changes the URL it requests. When the
// assertion on MAPLIBRE_GL_VECTOR_URLS fails, re-derive this list by walking the
// new bundles' `import` statements (docs/maintenance.md has the recipe).
const MAPLIBRE_GL_VECTOR_URLS = [
  "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.31.0",
  "https://cdn.jsdelivr.net/npm/geojson-vt@4.0.2/+esm",
  "https://cdn.jsdelivr.net/npm/sql.js@1.13.0",
  "https://cdn.jsdelivr.net/npm/vt-pbf@3.1.3/+esm",
];
const ESM_TRANSITIVE_PATHS = [
  // @duckdb/duckdb-wasm@1.31.0/+esm
  "https://cdn.jsdelivr.net/npm/apache-arrow@17.0.0/",
  "https://cdn.jsdelivr.net/npm/tslib@2.6.3/",
  "https://cdn.jsdelivr.net/npm/flatbuffers@24.3.25/",
  // vt-pbf@3.1.3/+esm
  "https://cdn.jsdelivr.net/npm/pbf@3.2.1/",
  "https://cdn.jsdelivr.net/npm/ieee754@1.1.13/",
  "https://cdn.jsdelivr.net/npm/@mapbox/point-geometry@0.1.0/",
  "https://cdn.jsdelivr.net/npm/@mapbox/vector-tile@1.3.1/",
];

/**
 * Build the full list of jsDelivr paths the desktop app executes scripts from.
 *
 * Returns:
 *   Each expected `script-src` source, derived from the code or lockfile that
 *   owns its version.
 */
function expectedJsdelivrSources(): string[] {
  const app = "apps/geolibre-desktop";
  const pglite = installedPackage("@electric-sql/pglite", app).version;
  const pglitePostgis = installedPackage("@electric-sql/pglite-postgis", app).version;
  const duckdb = installedPackage("@duckdb/duckdb-wasm", app).version;
  return [
    // pyodide-console.ts: Pyodide's own import() of pyodide.asm.js.
    `${JSDELIVR}pyodide/v${PYODIDE_VERSION}/full/`,
    // pglite-loader.cdn.ts: import() of the PGlite + PostGIS ES modules.
    `${JSDELIVR}npm/@electric-sql/pglite@${pglite}/`,
    `${JSDELIVR}npm/@electric-sql/pglite-postgis@${pglitePostgis}/`,
    // ort.ts: onnxruntime-web import()s its wasm glue (.mjs) from wasmPaths.
    `${JSDELIVR}npm/onnxruntime-web@${ORT_VERSION}/dist/`,
    // maplibre-gl-components' DuckDBConverter: a blob worker importScripts()
    // the bundled duckdb-wasm's getJsDelivrBundles() worker.
    `${JSDELIVR}npm/@duckdb/duckdb-wasm@${duckdb}/dist/`,
    // maplibre-gl-vector: import() of duckdb-wasm/+esm plus its /dist worker.
    `${JSDELIVR}npm/@duckdb/duckdb-wasm@1.31.0/`,
    // maplibre-gl-vector: <script> of sql.js's UMD build.
    `${JSDELIVR}npm/sql.js@1.13.0/dist/`,
    // maplibre-gl-vector: import() of the MVT fallback's /+esm bundles.
    `${JSDELIVR}npm/geojson-vt@4.0.2/`,
    `${JSDELIVR}npm/vt-pbf@3.1.3/`,
    ...ESM_TRANSITIVE_PATHS,
  ].sort();
}

describe("desktop CSP script-src (tauri.conf.json)", () => {
  const scriptSrc = cspDirective("script-src");

  it("does not allow whole jsDelivr trees", () => {
    for (const broad of BROAD_JSDELIVR_SOURCES) {
      assert.ok(!scriptSrc.includes(broad), `script-src must not list ${broad}`);
    }
  });

  it("pins every jsDelivr script path to the version the app requests", () => {
    assert.deepEqual(jsdelivrSources(scriptSrc), expectedJsdelivrSources());
  });

  it("ends every pinned jsDelivr path with a slash so it matches as a prefix", () => {
    for (const source of scriptSrc.filter((s) => s.startsWith(JSDELIVR))) {
      assert.ok(source.endsWith("/"), `${source} matches one exact URL without a trailing /`);
    }
  });

  it("tracks the jsDelivr URLs maplibre-gl-vector hard-codes", () => {
    // A bump that changes any of these needs the matching script-src paths
    // (and ESM_TRANSITIVE_PATHS) updated in tauri.conf.json.
    assert.deepEqual(maplibreGlVectorCdnUrls(), MAPLIBRE_GL_VECTOR_URLS);
  });

  it("keeps 'unsafe-eval' and 'wasm-unsafe-eval' (see docs/maintenance.md)", () => {
    // maplibre-gl-vector evaluates `new Function("url", "return import(url)")`
    // at module load, and that module is in the startup graph: without
    // 'unsafe-eval' the packaged app renders a blank window. Field and raster
    // calculators, the AI Assistant's JS tool, Earth Engine scripts and
    // Emscripten embind glue (LiDAR, splats) also compile strings at runtime.
    assert.ok(scriptSrc.includes("'unsafe-eval'"));
    assert.ok(scriptSrc.includes("'wasm-unsafe-eval'"));
  });
});

describe("web build CSP script-src (docker/nginx.conf)", () => {
  it("sends a CSP from the app and JupyterLite locations", () => {
    const locations = [...nginxPolicies().keys()];
    assert.ok(locations.includes("/"), "the app location sends no CSP");
    assert.ok(locations.includes("^~ /jupyterlite/"), "the JupyterLite location sends no CSP");
  });

  it("does not allow whole jsDelivr trees for the app", () => {
    const scriptSrc = nginxDirective("/", "script-src");
    for (const broad of BROAD_JSDELIVR_SOURCES) {
      assert.ok(!scriptSrc.includes(broad), `script-src must not list ${broad}`);
    }
  });

  it("pins the same jsDelivr script paths as the desktop CSP", () => {
    // The web build runs the same bundle and loads the same CDN scripts, so the
    // pinned set must match exactly.
    const listed = jsdelivrSources(nginxDirective("/", "script-src"));
    assert.deepEqual(listed, expectedJsdelivrSources());
    assert.deepEqual(listed, jsdelivrSources(cspDirective("script-src")));
  });

  it("allows only Pyodide from jsDelivr for the JupyterLite site", () => {
    // jupyterlite-pyodide-kernel loads pyodide/v<ver>/full/pyodide.js, with the
    // version set by whichever kernel release pip resolves at image build time,
    // so this one stays unpinned; nothing in the site loads from /npm/.
    const scriptSrc = nginxDirective("^~ /jupyterlite/", "script-src");
    assert.deepEqual(jsdelivrSources(scriptSrc), [`${JSDELIVR}pyodide/`]);
  });

  it("keeps 'unsafe-eval' and 'wasm-unsafe-eval' for the app", () => {
    const scriptSrc = nginxDirective("/", "script-src");
    assert.ok(scriptSrc.includes("'unsafe-eval'"));
    assert.ok(scriptSrc.includes("'wasm-unsafe-eval'"));
  });
});
