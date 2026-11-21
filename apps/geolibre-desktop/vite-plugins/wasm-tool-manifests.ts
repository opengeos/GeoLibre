import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Plugin } from "vite";

// Precomputes the WASM tool runner's manifests (every tool's id, name and
// parameter schema) at build time and serves them as one JSON file next to
// index.html (issue #3472).
//
// The Processing (Whitebox) dialog builds its tool list from the catalog
// snapshot plus these manifests. Asking the runner for them at runtime means
// downloading and compiling `geolibre-cli.wasm` (~24 MB, ~8 MB gzipped) before
// the list can show anything, so a `?tool=` deep link sat on "All (0) /
// Loading…" for as long as that download took (about 30 s on a slow link).
// The JSON is ~2 MB raw and a small fraction of that compressed, and the
// runner only downloads when a tool actually runs.
//
// The file is generated from the same installed `geolibre-wasm` that the build
// bundles, so it cannot drift from the runner. `wasm-client.ts` falls back to
// asking the runner when the file is missing or unreadable at runtime. A
// failure to generate it fails the build on purpose: `geolibre-wasm` is a hard
// dependency, and silently skipping the file would bring back the slow list.

/** Served file name, resolved against the document base by `wasm-client.ts`. */
export const WASM_TOOL_MANIFESTS_FILE = "whitebox-wasm-manifests.json";

/**
 * Emit the runner's tool manifests as `whitebox-wasm-manifests.json`.
 *
 * @param packageDir Directory of the installed `geolibre-wasm` package.
 * @returns A Vite plugin that serves the file in dev and emits it on build.
 */
export function wasmToolManifestsPlugin(packageDir: string): Plugin {
  let manifests: Promise<string> | null = null;
  const generate = (): Promise<string> => {
    manifests ??= (async () => {
      const tools = (await import(pathToFileURL(path.join(packageDir, "tools.mjs")).href)) as {
        initTools: (source: Uint8Array) => Promise<unknown>;
        listManifests: () => Promise<unknown[]>;
      };
      await tools.initTools(readFileSync(path.join(packageDir, "geolibre-cli.wasm")));
      const list = await tools.listManifests();
      if (!Array.isArray(list) || list.length === 0) {
        throw new Error("geolibre-wasm listManifests() returned no tools");
      }
      return JSON.stringify(list);
    })().catch((err: unknown) => {
      manifests = null; // let the next dev request or build retry
      throw err;
    });
    return manifests;
  };

  return {
    name: "geolibre:wasm-tool-manifests",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? "").split("?")[0];
        if (!pathname.endsWith(`/${WASM_TOOL_MANIFESTS_FILE}`)) {
          next();
          return;
        }
        generate().then(
          (body) => {
            res.setHeader("Content-Type", "application/json");
            res.end(body);
          },
          (err: unknown) => next(err),
        );
      });
    },
    async generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: WASM_TOOL_MANIFESTS_FILE,
        source: await generate(),
      });
    },
  };
}
