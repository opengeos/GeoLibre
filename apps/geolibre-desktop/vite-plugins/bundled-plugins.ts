import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";

const VIRTUAL_ID = "virtual:bundled-plugins";
const RESOLVED_ID = "\0" + VIRTUAL_ID;

// Discovers plugins dropped into public/plugins/<id>/ at build and dev-server
// start, exposing their manifest paths (base-relative, no leading slash) as the
// virtual module `virtual:bundled-plugins`. Adding or removing a plugin folder
// changes the list with no code edit. Because the desktop app bundles the same
// frontend (tauri.conf.json `frontendDist`), one folder serves both the web and
// desktop builds; the frontend loads them through the normal URL-plugin path.
export function bundledPlugins(pluginsDir: string): Plugin {
  const discover = (): string[] => {
    if (!existsSync(pluginsDir)) return [];
    return readdirSync(pluginsDir)
      .filter((name) => {
        // statSync with throwIfNoEntry:false avoids a TOCTOU race between an
        // existsSync check and the stat, and the isDirectory guard makes the
        // "folder containing plugin.json" intent explicit.
        const entry = statSync(join(pluginsDir, name), {
          throwIfNoEntry: false,
        });
        if (!entry?.isDirectory()) return false;
        const manifest = statSync(join(pluginsDir, name, "plugin.json"), {
          throwIfNoEntry: false,
        });
        return manifest?.isFile() ?? false;
      })
      .map((name) => `plugins/${name}/plugin.json`)
      .sort();
  };

  return {
    name: "geolibre:bundled-plugins",
    resolveId: (id) => (id === VIRTUAL_ID ? RESOLVED_ID : undefined),
    load(id) {
      if (id !== RESOLVED_ID) return;
      return `export const bundledPluginManifestPaths = ${JSON.stringify(discover())};`;
    },
    configureServer(server) {
      server.watcher.add(pluginsDir);
      // chokidar watches recursively, so reload only for direct children of
      // pluginsDir; a plugin's own dist/ subdir would otherwise fire extra
      // reloads.
      const reload = (dirPath: string) => {
        if (dirname(dirPath) !== pluginsDir) return;
        const mod = server.moduleGraph.getModuleById(RESOLVED_ID);
        if (mod) server.moduleGraph.invalidateModule(mod);
        server.ws.send({ type: "full-reload" });
      };
      server.watcher.on("addDir", reload);
      server.watcher.on("unlinkDir", reload);
    },
  };
}
