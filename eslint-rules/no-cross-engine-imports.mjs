// Keeps the renderers in packages/map/src from importing each other's files.
//
// @geolibre/map hosts four map engines side by side. A module that one engine
// shares with another belongs in a neutral module named for what the code
// does (`pmtiles-archive.ts`, `protocol-tiles.ts`, `feature-style.ts`,
// `vector-style.ts`, `gl-style-compiler.ts`, `basemap-style.ts`,
// `raster-identify.ts`), never in a file named for an engine, or a change to
// one renderer silently reaches into another.
//
// A file belongs to an engine by its name:
// - ArcGIS:   `arcgis-*`, `Arcgis*`
// - Cesium:   `cesium-*`, `Cesium*`
// - Mapbox:   `mapbox-*`, `Mapbox*`
// - MapLibre: `maplibre-*`, `layer-sync`, `map-controller`, `MapCanvas`,
//   `SecondaryMapCanvas` (the original engine, which predates the prefixes)
// Everything else is neutral. Neutral modules may import any engine's files
// (the package index, `headless.ts`), and engine files may import neutral
// modules and their own engine's files.
//
// `mapbox-style`, `mapbox-style-export` and `mapbox-style-import` are named for
// the Mapbox Style Specification and the `mapbox://` URL scheme, not for the
// mapbox-gl renderer: the MapLibre controller loads Mapbox-hosted styles and
// the style import/export works for every engine. They are neutral.

import path from "node:path";

/** Format and service modules whose `mapbox-` prefix does not name the engine. */
const NEUTRAL_BASENAMES = new Set(["mapbox-style", "mapbox-style-export", "mapbox-style-import"]);

const MAPLIBRE_BASENAMES = new Set([
  "layer-sync",
  "map-controller",
  "MapCanvas",
  "SecondaryMapCanvas",
]);

const ENGINE_PREFIXES = [
  ["arcgis", /^(arcgis-|Arcgis[A-Z])/],
  ["cesium", /^(cesium-|Cesium[A-Z])/],
  ["mapbox", /^(mapbox-|Mapbox[A-Z])/],
  ["maplibre", /^(maplibre-|MapLibre[A-Z])/],
];

/**
 * The engine a packages/map/src module belongs to, judged by its file name.
 *
 * @param {string} file A file path or import specifier; only its base name,
 *   without the extension, is read.
 * @returns {"arcgis" | "cesium" | "mapbox" | "maplibre" | null} The engine,
 *   or `null` for a neutral module.
 */
export function engineOf(file) {
  const base = path.basename(file).replace(/\.(d\.)?[cm]?[jt]sx?$/, "");
  if (NEUTRAL_BASENAMES.has(base)) return null;
  if (MAPLIBRE_BASENAMES.has(base)) return "maplibre";
  for (const [engine, pattern] of ENGINE_PREFIXES) {
    if (pattern.test(base)) return engine;
  }
  return null;
}

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid a map-engine module in packages/map/src from importing another engine's module",
    },
    schema: [],
    messages: {
      crossEngine:
        "The {{from}} module imports `{{source}}`, a {{to}} module. Move what both engines share into a neutral module named for what it does (see eslint-rules/no-cross-engine-imports.mjs).",
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    const from = engineOf(filename);
    if (!from) return {};
    const absolute = path.resolve(filename);
    const dir = path.dirname(absolute);
    // The packages/map/src tree the file sits in (its own directory when the
    // path has no such segment, as for a stray fixture).
    const marker = `${path.sep}packages${path.sep}map${path.sep}src${path.sep}`;
    const at = absolute.lastIndexOf(marker);
    const root = at >= 0 ? absolute.slice(0, at + marker.length - 1) : dir;

    function check(node, source) {
      if (typeof source !== "string" || !source.startsWith(".")) return;
      // Only modules inside that tree are classified: a relative import that
      // leaves it reaches another package's files, whose names say nothing
      // about these engines.
      const relative = path.relative(root, path.resolve(dir, source));
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        return;
      const to = engineOf(source);
      if (to && to !== from) {
        context.report({ node, messageId: "crossEngine", data: { from, to, source } });
      }
    }

    const fromSource = (node) => check(node.source, node.source?.value);
    return {
      ImportDeclaration: fromSource,
      ExportNamedDeclaration: fromSource,
      ExportAllDeclaration: fromSource,
      ImportExpression(node) {
        if (node.source.type === "Literal") check(node.source, node.source.value);
      },
      // `import("./x").Type` in a type position.
      TSImportType(node) {
        const arg = node.argument;
        const literal = arg?.type === "TSLiteralType" ? arg.literal : arg;
        if (literal?.type === "Literal") check(literal, literal.value);
      },
    };
  },
};

export default rule;
