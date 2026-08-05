import type { Plugin } from "vite";

/**
 * Rewrite `import X from "maplibre-gl"` to `import * as X from "maplibre-gl"`
 * inside the published bundles of packages that still target MapLibre v5.
 *
 * MapLibre v6 is ESM-only with **no default export**, so a dist file compiled
 * against v5's default export is a hard bundling error:
 *
 *     [MISSING_EXPORT] "default" is not exported by ".../maplibre-gl.mjs"
 *
 * A namespace object is a drop-in for what these bundles actually do with the
 * binding (`X.Map`, `new X.Popup()`, …), so the rewrite is safe.
 *
 * This is a **temporary** shim for third-party packages we do not control. Every
 * opengeos-owned package has already been migrated and released, so the list
 * below should only ever shrink. See opengeos/GeoLibre#1489 (blocker 1).
 *
 * The plugin fails the build if a listed package stops matching — that means it
 * either shipped a fix (delete the entry) or changed its bundle shape (revisit),
 * and silently shimming nothing would hide both.
 */
const SHIMMED_PACKAGES = ["@esri/maplibre-arcgis", "@geoman-io/maplibre-geoman-free"] as const;

// Matches a default import of maplibre-gl in minified or unminified ESM:
//   import Zt from"maplibre-gl"     import e from "maplibre-gl"
const DEFAULT_IMPORT = /\bimport\s+([A-Za-z_$][\w$]*)\s+from\s*(["'])maplibre-gl\2/g;

export function maplibreDefaultImportShim(): Plugin {
  const rewritten = new Set<string>();

  return {
    name: "geolibre:maplibre-default-import-shim",
    enforce: "pre",
    apply: () => true,

    transform(code, id) {
      const pkg = SHIMMED_PACKAGES.find((name) => id.includes(`/node_modules/${name}/`));
      if (!pkg || !code.includes("maplibre-gl")) return null;

      DEFAULT_IMPORT.lastIndex = 0;
      if (!DEFAULT_IMPORT.test(code)) return null;

      rewritten.add(pkg);
      DEFAULT_IMPORT.lastIndex = 0;
      return {
        code: code.replace(
          DEFAULT_IMPORT,
          (_match, binding: string, quote: string) =>
            `import * as ${binding} from ${quote}maplibre-gl${quote}`,
        ),
        map: null,
      };
    },

    buildEnd(error) {
      if (error) return;
      const stale = SHIMMED_PACKAGES.filter((name) => !rewritten.has(name));
      if (stale.length === 0) return;
      this.error(
        `maplibre default-import shim matched nothing in: ${stale.join(", ")}. ` +
          `If the package now ships a v6-compatible build, remove it from ` +
          `SHIMMED_PACKAGES in vite-plugins/maplibre-default-import-shim.ts.`,
      );
    },
  };
}
