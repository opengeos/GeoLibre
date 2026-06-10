import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Plugin } from "vite";

// Copies the framework-free backend module
// `backend/geolibre_server/geolibre_server/vector_ops.py` into the app source
// tree as `src/lib/pyodide/vector_ops.generated.py`, so the in-browser Pyodide
// engine loads the EXACT same Python the FastAPI sidecar runs (one source of
// truth → identical results). The generated file is git-ignored and imported
// with Vite's `?raw` suffix.
//
// We copy rather than `?raw`-importing the backend file directly: Rollup's
// `fs.allow` rejects imports that climb out of the app root into a sibling
// workspace, and a generated file inside `src/` keeps the module graph local
// and identical across the dev, Docker, and static builds.
//
// A short banner is prepended so the copy is never hand-edited.
const BANNER =
  "# AUTO-GENERATED — do not edit. Source of truth:\n" +
  "# backend/geolibre_server/geolibre_server/vector_ops.py\n" +
  "# Regenerated on each Vite dev-server start / build by\n" +
  "# apps/geolibre-desktop/vite-plugins/copy-vector-ops.ts\n\n";

export function copyVectorOps(sourcePath: string, destPath: string): Plugin {
  const sync = (): void => {
    if (!existsSync(sourcePath)) {
      throw new Error(
        `copy-vector-ops: source not found at ${sourcePath}. The Pyodide vector ` +
          `engine needs backend/geolibre_server/geolibre_server/vector_ops.py.`,
      );
    }
    const body = readFileSync(sourcePath, "utf8");
    const next = BANNER + body;
    // Skip the write when unchanged so the dev-server file watcher does not
    // fire an extra reload on every restart.
    if (existsSync(destPath) && readFileSync(destPath, "utf8") === next) return;
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, next, "utf8");
  };

  return {
    name: "geolibre:copy-vector-ops",
    // buildStart runs for both `vite` (dev) and `vite build`, before any module
    // in the graph is resolved, so the `?raw` import always sees a fresh copy.
    buildStart() {
      sync();
    },
    // Also regenerate when the backend source changes during `vite` dev.
    configureServer(server) {
      server.watcher.add(sourcePath);
      const onChange = (changed: string) => {
        if (changed !== sourcePath) return;
        // An atomic save can briefly remove the file, so readFileSync may throw;
        // swallow it (the next event re-syncs) rather than crash the watcher's
        // event loop and take down the dev server.
        try {
          sync();
        } catch (err) {
          server.config.logger.error(`[geolibre:copy-vector-ops] ${err}`);
        }
      };
      server.watcher.on("change", onChange);
      server.watcher.on("add", onChange);
    },
  };
}
