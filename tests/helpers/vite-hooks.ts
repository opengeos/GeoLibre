/**
 * Module-loader hooks that let `node --test` import React components the way
 * Vite would. `tests/helpers/dom.ts` registers them (with the synchronous,
 * in-thread `module.registerHooks`) only in component-test processes; every
 * other test file is untouched, because `node --test` runs each file in its
 * own process.
 *
 * The gaps between Vite and plain Node (plus tsx) that app components hit:
 *
 * 1. JSX. tsx finds no root `tsconfig.json`, so it compiles `.tsx` with the
 *    classic `React.createElement` transform and components throw
 *    `React is not defined`. App `.tsx` files are compiled here with the
 *    automatic runtime instead, matching `@vitejs/plugin-react`.
 * 2. Asset imports. Components import stylesheets (`maplibre-gl.css`) and pull
 *    files in with Vite query suffixes (`?url`, `?raw`, `?worker`), sometimes
 *    of files generated at build time. They load as an empty module whose
 *    default export is an empty string.
 * 3. Virtual modules (`virtual:bundled-plugins`) served by Vite plugins.
 * 4. `import.meta.env` / `import.meta.glob`, which Vite replaces at build time.
 *    App sources that mention them get a prelude defining a production env
 *    and an empty glob, so the i18n module registers English only and never
 *    lazy-loads another locale.
 */
import { readFileSync } from "node:fs";
import type { LoadHookSync, ResolveHookSync } from "node:module";
import { fileURLToPath } from "node:url";
// tsx's own compiler (a hard dependency of tsx), so always installed.
import { transformSync } from "esbuild";

const ASSET_EXTENSION =
  /\.(css|scss|sass|less|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|wasm)$/i;
const VITE_QUERY = /\?(url|raw|inline|worker|sharedworker)(&.*)?$/;
const VIRTUAL_PREFIX = "virtual:";
const VIRTUAL_URL = "geolibre-test-virtual:";

/** Stand-ins for the virtual modules the app's Vite plugins provide. */
const VIRTUAL_MODULES: Record<string, string> = {
  "bundled-plugins": "export const bundledPluginManifestPaths = [];",
  "pwa-register": "export function registerSW() { return async () => {}; }",
};

const ENV_PRELUDE =
  'import.meta.env ??= { BASE_URL: "/", MODE: "test", DEV: false, PROD: true, SSR: false };' +
  "import.meta.glob ??= () => ({});";

/**
 * Resolve virtual modules to a private scheme, and asset imports carrying a
 * Vite query suffix to the file they name (or, for a file that only exists
 * after a build, a stub URL) with the suffix kept so {@link load} can spot it.
 */
export const resolve: ResolveHookSync = (specifier, context, nextResolve) => {
  if (specifier.startsWith(VIRTUAL_PREFIX)) {
    return { url: VIRTUAL_URL + specifier.slice(VIRTUAL_PREFIX.length), shortCircuit: true };
  }
  const query = VITE_QUERY.exec(specifier);
  if (query) {
    try {
      const resolved = nextResolve(specifier.slice(0, query.index), context);
      return { ...resolved, url: `${resolved.url}${query[0]}`, shortCircuit: true };
    } catch {
      return { url: `${VIRTUAL_URL}asset${query[0]}`, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
};

/** Is `url` an app source file (as opposed to a dependency)? */
function isAppSource(url: string): boolean {
  return url.startsWith("file:") && !url.includes("/node_modules/");
}

/** Prefix the env prelude to a module that reads `import.meta.env`/`glob`. */
function withEnvPrelude(source: string): string {
  if (!source.includes("import.meta.env") && !source.includes("import.meta.glob")) return source;
  // Prepended on the module's first line so every other line keeps its number.
  return ENV_PRELUDE + source;
}

/**
 * Serve virtual modules and assets as stubs, compile app `.tsx` files with the
 * automatic JSX runtime, and define `import.meta.env` for app sources.
 */
export const load: LoadHookSync = (url, context, nextLoad) => {
  if (url.startsWith(VIRTUAL_URL)) {
    const name = url.slice(VIRTUAL_URL.length);
    return {
      format: "module",
      source: VIRTUAL_MODULES[name] ?? 'export default "";',
      shortCircuit: true,
    };
  }
  const path = url.replace(/[?#].*$/, "");
  if (VITE_QUERY.test(url) || ASSET_EXTENSION.test(path)) {
    return { format: "module", source: 'export default "";', shortCircuit: true };
  }
  if (isAppSource(url) && /\.[jt]sx$/.test(path)) {
    const filename = fileURLToPath(path);
    const { code } = transformSync(readFileSync(filename, "utf8"), {
      loader: path.endsWith(".tsx") ? "tsx" : "jsx",
      jsx: "automatic",
      format: "esm",
      target: "es2022",
      sourcemap: "inline",
      sourcefile: filename,
    });
    return { format: "module", source: withEnvPrelude(code), shortCircuit: true };
  }
  const result = nextLoad(url, context);
  if (result.format !== "module" || !isAppSource(url) || result.source == null) return result;
  const source =
    typeof result.source === "string" ? result.source : new TextDecoder().decode(result.source);
  return { ...result, source: withEnvPrelude(source) };
};
