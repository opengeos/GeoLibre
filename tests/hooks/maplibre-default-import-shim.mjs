/**
 * Node module-loader analogue of `apps/geolibre-desktop/vite-plugins/maplibre-default-import-shim.ts`.
 *
 * MapLibre v6 is ESM-only with no default export, so a third-party bundle
 * compiled against v5's default export fails to instantiate under `node --test`:
 *
 *     SyntaxError: The requested module 'maplibre-gl' does not provide an
 *     export named 'default'
 *
 * `tests/geo-editor-plugin.test.ts` hits this because the geo-editor plugin
 * statically imports Geoman. The Vite shim cannot help here — `node --test`
 * does not go through Vite — so the same rewrite is applied as a load hook.
 *
 * Temporary, and the list only ever shrinks: see opengeos/GeoLibre#1489
 * (blocker 1). `tests/maplibre-shim-parity.test.ts` fails if this list and the
 * Vite plugin's stop agreeing.
 */

/** Packages whose published ESM still default-imports maplibre-gl. */
export const SHIMMED_PACKAGES = ["@esri/maplibre-arcgis", "@geoman-io/maplibre-geoman-free"];

// Matches a default import of maplibre-gl in minified or unminified ESM:
//   import Zt from"maplibre-gl"     import e from "maplibre-gl"
const DEFAULT_IMPORT = /\bimport\s+([A-Za-z_$][\w$]*)\s+from\s*(["'])maplibre-gl\2/g;

/** Rewrite default imports of maplibre-gl to namespace imports. */
export function rewriteDefaultImports(source) {
  return source.replace(
    DEFAULT_IMPORT,
    (_match, binding, quote) => `import * as ${binding} from ${quote}maplibre-gl${quote}`,
  );
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const shimmed = SHIMMED_PACKAGES.some((name) => url.includes(`/node_modules/${name}/`));
  if (!shimmed || result.format !== "module" || result.source == null) return result;

  const source = result.source.toString();
  if (!source.includes("maplibre-gl")) return result;
  return { ...result, source: rewriteDefaultImports(source) };
}
