import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, it } from "node:test";

// Cesium-capable plugins must not read the map through MapLibre-only doors
// (issue #2262). `app.getMap()` answers null on the globe, so a plugin that
// declares `engines: ["maplibre", "cesium"]` and reaches through it degrades
// to a silent no-op there — the failure mode that issue is about, and the one
// an `engines` declaration is supposed to rule out.
//
// A source scan rather than a behaviour test on purpose: the point is that no
// *future* plugin joins the Cesium list carrying one of these calls, and that
// is a property of the whole directory, not of any one module.

const PLUGIN_DIR = resolve(import.meta.dirname, "..", "packages", "plugins", "src", "plugins");

/** Declares Cesium in its `engines` list, whatever the order, spacing, or quotes. */
const DECLARES_CESIUM = /engines:\s*\[[^\]]*["']cesium["'][^\]]*\]/;

// Mapbox-capable plugins have the same problem in a different door:
// `app.getMap()` is null on the Mapbox renderer too, and the map it does hand
// out lacks MapLibre's extensions. A plugin that declares
// `engines: [..., "mapbox"]` reads the map through `getStyleMap(app)`
// (packages/plugins/src/plugins/style-map.ts), which falls back to
// `app.getMapboxMap()`, and stays on the Style Spec surface the two engines
// share.

/** Declares Mapbox in its `engines` list. */
const DECLARES_MAPBOX = /engines:\s*\[[^\]]*["']mapbox["'][^\]]*\]/;

// ArcGIS-capable plugins have no style map at all: `app.getMap()`,
// `app.getMapboxMap()` and `getStyleMap(app)` all answer null on the ArcGIS
// renderer, so a plugin that declares `engines: [..., "arcgis"]` must work
// through the store and the engine-neutral API (`getViewBounds`,
// `addGeoJsonLayer`, `addMapControl`, ...). A read that handles the null on
// purpose (the weather overlays' optional instant frame swap) says so at the
// call (issue #2477).

/** Declares ArcGIS in its `engines` list. */
const DECLARES_ARCGIS = /engines:\s*\[[^\]]*["']arcgis["'][^\]]*\]/;

/** Any read of a style map: the MapLibre or Mapbox map, directly or via getStyleMap. */
const STYLE_MAP_READ =
  /(?:\bapp(?:Ref|Api|API)?\??\.)(?:getMap|getMapboxMap)\??\.?\(\)|\bgetStyleMap\(/g;

/** Opt out one style-map read whose null answer the module handles on purpose. */
const ARCGIS_NULL_MAP_OPT_OUT = "engine-audit-allow: arcgis-null-map";

/**
 * A read of the MapLibre-only map: `app.getMap()`, `app?.getMap?.()`, or the
 * same off an `appRef` / `appApi` alias. `getMapboxMap` and a control's own
 * `control.getMap()` do not match: the member access before it must be the
 * host API, not a control. Known limit: a host API bound to some other name
 * (`const host = app; host.getMap()`) escapes; the directory does not do that.
 */
const GETMAP_READ = /(?:\bapp(?:Ref|Api|API)?\??\.)getMap\??\.?\(\)/g;

/**
 * The same read taken indirectly: `getMap` destructured off the API
 * (`const { getMap } = app`) or the bound method aliased
 * (`const read = app.getMap`). Either escapes {@link GETMAP_READ} and reaches
 * the MapLibre-only map just as silently, so both count as reads.
 */
const GETMAP_INDIRECT =
  /\{[^}]*\bgetMap\b[^}]*\}\s*=\s*app(?:Ref|Api|API)?\b|=\s*app(?:Ref|Api|API)?\??\.getMap\b(?!\??\.?\()/g;

/**
 * Members a mapbox-gl map does not have. Reaching one through the shared map
 * throws on Mapbox, or silently does nothing when guarded, which is exactly
 * the degradation the `engines` declaration promises does not happen.
 */
const MAPLIBRE_ONLY_MEMBERS =
  /\.(?:addProtocol|removeProtocol|setTransformRequest|calculateCameraOptionsFromCameraLngLatAltRotation|getCenterClampedToGround|setCenterClampedToGround|getCameraTargetElevation|setSky|getSky|setVerticalFieldOfView|_camera)\b|\.transform\.(?:[a-zA-Z_]\w*)/g;

/** Opt out one deliberate `app.getMap()` read: a branch that detects MapLibre. */
const MAPBOX_GETMAP_OPT_OUT = "engine-audit-allow: getMap-mapbox";

/** Opt out one deliberate MapLibre-only call behind a runtime engine check. */
const MAPLIBRE_ONLY_OPT_OUT = "engine-audit-allow: maplibre-only";

/** A chained read: `app.getMap?.()?.getBounds()`. */
const CHAINED_BOUNDS = /getMap\??\.?\(\)[^;\n]*\.getBounds\(\)/g;

/**
 * The same read split over two statements, which is this directory's more
 * common idiom (`const map = app.getMap?.(); … map.getBounds()`). Only names
 * bound directly from `getMap()` count, so an unrelated `bbox.getBounds()`
 * does not report.
 */
const MAP_ALIAS = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=[^;\n]*getMap\??\.?\(\)/g;

/**
 * Opt out one deliberate call. `getMap()` returning null is only a bug when it
 * *silently* weakens something the user asked for; a module that branches on
 * it and does something else instead says so at the call, rather than in a
 * list that rots somewhere else.
 *
 * Scoped to the call, not the file: it must appear on the flagged line or
 * within {@link OPT_OUT_LOOKBACK} lines above it, so a second, unrelated
 * bounds read in the same module still reports. Read off the raw source,
 * before comments are blanked.
 */
const AUDIT_OPT_OUT = "engine-audit-allow: getMap-bounds";

/** How far above a flagged call its opt-out comment may sit. */
const OPT_OUT_LOOKBACK = 6;

/**
 * Blank out comments before scanning, preserving line structure so a match
 * still maps back to its own line. A module that explains why it avoids one of
 * these calls names the call, and would otherwise report itself.
 */
function blankComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (comment) => " ".repeat(comment.length));
}

/** 1-based line number of a match offset. */
function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (source[i] === "\n") line += 1;
  return line;
}

/** Whether an opt-out marker sits on, or just above, this line. */
function optedOutAt(rawLines: string[], line: number, marker = AUDIT_OPT_OUT): boolean {
  return rawLines
    .slice(Math.max(0, line - 1 - OPT_OUT_LOOKBACK), line)
    .some((text) => text.includes(marker));
}

/** Resolve a relative import to the file it names, `.ts` or `/index.ts`. */
function resolveImport(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Every module a plugin entry point pulls in by relative import, transitively.
 *
 * Scanning the entry file alone would miss a plugin split across a
 * subdirectory (`deckgl-viz/`, `elevation-profile/`, `vantor/` are already
 * shaped that way): the manifest with the `engines` declaration is in one
 * file, and the map access is in a helper next to it.
 */
function importClosure(entry: string): string[] {
  const seen = new Set<string>();
  const pending = [resolve(entry)];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = blankComments(readFileSync(file, "utf8"));
    // `from "./x"`, the side-effect form `import "./x"`, and the dynamic
    // `import("./x")` a plugin uses to defer a heavy helper — all three reach
    // code that would otherwise sit outside the audit. Either quote style, so
    // a file that escapes the formatter is still followed.
    for (const match of source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["'](\.[^"']*)["']/g)) {
      const resolved = resolveImport(file, match[1]);
      if (resolved) pending.push(resolved);
    }
  }
  return [...seen];
}

/** Lines where this module reads the viewport through the MapLibre-only map. */
function boundsReadsThroughGetMap(file: string): number[] {
  const raw = readFileSync(file, "utf8");
  const rawLines = raw.split("\n");
  const source = blankComments(raw);
  const lines = new Set<number>();
  for (const match of source.matchAll(CHAINED_BOUNDS)) lines.add(lineOf(source, match.index));
  for (const [, alias] of source.matchAll(MAP_ALIAS)) {
    const uses = new RegExp(`\\b${alias}\\??\\.getBounds\\(\\)`, "g");
    for (const use of source.matchAll(uses)) lines.add(lineOf(source, use.index));
  }
  return [...lines].filter((line) => !optedOutAt(rawLines, line)).sort((a, b) => a - b);
}

/** Plugin entry points whose `engines` list matches, with everything they import. */
function pluginClosures(declares: RegExp): { plugin: string; files: string[] }[] {
  return readdirSync(PLUGIN_DIR, { withFileTypes: true })
    .flatMap((entry) => {
      // A plugin split across a subdirectory declares itself in its index.ts
      // (elevation-profile/); it is an entry point like any top-level file.
      if (entry.isDirectory()) {
        const index = join(PLUGIN_DIR, entry.name, "index.ts");
        return existsSync(index) ? [index] : [];
      }
      return entry.name.endsWith(".ts") ? [join(PLUGIN_DIR, entry.name)] : [];
    })
    .filter((file) => declares.test(blankComments(readFileSync(file, "utf8"))))
    .map((file) => ({ plugin: relative(PLUGIN_DIR, file), files: importClosure(file) }));
}

/** Plugin entry points that declare Cesium support, with everything they import. */
function cesiumPluginClosures(): { plugin: string; files: string[] }[] {
  return pluginClosures(DECLARES_CESIUM);
}

/** Plugin entry points that declare Mapbox support, with everything they import. */
function mapboxPluginClosures(): { plugin: string; files: string[] }[] {
  return pluginClosures(DECLARES_MAPBOX);
}

/** Plugin entry points that declare ArcGIS support, with everything they import. */
function arcgisPluginClosures(): { plugin: string; files: string[] }[] {
  return pluginClosures(DECLARES_ARCGIS);
}

/**
 * Lines where this module reads a style map, which is null on ArcGIS.
 *
 * Out of scope: `style-map.ts`, which defines the accessor; a module that
 * declares its own `engines` without ArcGIS, which is another plugin reached
 * for a helper and is audited under its own declaration; and a read already
 * marked as a MapLibre-detection branch (`getMap-mapbox`), which by that
 * marker falls back when the map is absent.
 */
function styleMapReads(file: string): number[] {
  if (file.endsWith(`${join("plugins", "style-map.ts")}`)) return [];
  const raw = readFileSync(file, "utf8");
  const rawLines = raw.split("\n");
  const source = blankComments(raw);
  const ownEngines = /engines:\s*\[[^\]]*\]/.exec(source);
  if (ownEngines && !DECLARES_ARCGIS.test(ownEngines[0])) return [];
  const lines = new Set<number>();
  for (const pattern of [STYLE_MAP_READ, GETMAP_INDIRECT])
    for (const match of source.matchAll(pattern)) {
      const line = lineOf(source, match.index);
      if (
        !optedOutAt(rawLines, line, ARCGIS_NULL_MAP_OPT_OUT) &&
        !optedOutAt(rawLines, line, MAPBOX_GETMAP_OPT_OUT)
      )
        lines.add(line);
    }
  return [...lines].sort((a, b) => a - b);
}

/**
 * Lines where this module reads the map through `app.getMap()` alone. A read
 * that falls back to `getMapboxMap` on the same line (the STAC idiom) is fine;
 * so is one marked as a deliberate MapLibre-detection branch.
 */
function getMapOnlyReads(file: string): number[] {
  const raw = readFileSync(file, "utf8");
  const rawLines = raw.split("\n");
  const source = blankComments(raw);
  const lines = new Set<number>();
  for (const match of source.matchAll(GETMAP_READ)) {
    const line = lineOf(source, match.index);
    // The fallback must be in the same statement, read off the comment-blanked
    // source: a `getMapboxMap` in a trailing comment does not count, and a
    // fallback the formatter wrapped onto the next line does.
    const statement = source.slice(match.index, statementEnd(source, match.index));
    if (statement.includes("getMapboxMap")) continue;
    if (optedOutAt(rawLines, line, MAPBOX_GETMAP_OPT_OUT)) continue;
    lines.add(line);
  }
  for (const match of source.matchAll(GETMAP_INDIRECT)) {
    const line = lineOf(source, match.index);
    if (optedOutAt(rawLines, line, MAPBOX_GETMAP_OPT_OUT)) continue;
    lines.add(line);
  }
  return [...lines].sort((a, b) => a - b);
}

/** Offset just past the `;` that ends the statement containing `index`, or the source's end. */
function statementEnd(source: string, index: number): number {
  const end = source.indexOf(";", index);
  return end === -1 ? source.length : end + 1;
}

/** Lines where this module reaches a member only a MapLibre map has. */
function maplibreOnlyCalls(file: string): string[] {
  const raw = readFileSync(file, "utf8");
  const rawLines = raw.split("\n");
  const source = blankComments(raw);
  const hits: string[] = [];
  for (const match of source.matchAll(MAPLIBRE_ONLY_MEMBERS)) {
    const line = lineOf(source, match.index);
    if (optedOutAt(rawLines, line, MAPLIBRE_ONLY_OPT_OUT)) continue;
    hits.push(`${line} (${match[0]})`);
  }
  return hits;
}

describe("plugin engine audit", () => {
  it("finds the Cesium-capable plugins to audit", () => {
    // A regex that stops matching would make every assertion below vacuous.
    assert.ok(cesiumPluginClosures().length > 0, "no plugin declares Cesium support");
  });

  it("walks a subdirectory-shaped plugin's own modules", () => {
    // The closure walk is what makes those plugins auditable at all. Asserted
    // against a plugin that is actually split that way (rather than against
    // whichever plugins declare Cesium today, none of which are), so a walk
    // that stopped resolving `./dir/file` would fail here instead of quietly
    // narrowing the audit back to entry files.
    const files = importClosure(join(PLUGIN_DIR, "maplibre-vantor.ts")).map((file) =>
      relative(PLUGIN_DIR, file),
    );
    assert.ok(
      files.includes(join("vantor", "control.ts")),
      `expected the vantor plugin's own modules in its closure, got: ${files.join(", ")}`,
    );
  });

  it("finds the Mapbox-capable plugins to audit", () => {
    assert.ok(mapboxPluginClosures().length > 0, "no plugin declares Mapbox support");
  });

  it("reads the map through getStyleMap(app), not app.getMap() alone, on Mapbox", () => {
    const offenders = mapboxPluginClosures().flatMap(({ plugin, files }) =>
      files.flatMap((file) =>
        getMapOnlyReads(file).map((line) => `${plugin} -> ${relative(PLUGIN_DIR, file)}:${line}`),
      ),
    );
    assert.deepEqual(
      offenders,
      [],
      "these modules are reachable from a plugin that declares Mapbox support but read " +
        "the map through app.getMap(), which is null on the Mapbox renderer: use " +
        "getStyleMap(app) from ./style-map, or mark a deliberate MapLibre-detection " +
        `branch with "${MAPBOX_GETMAP_OPT_OUT}"`,
    );
  });

  it("stays on the Style Spec surface a mapbox-gl map shares, on Mapbox", () => {
    const offenders = mapboxPluginClosures().flatMap(({ plugin, files }) =>
      files.flatMap((file) =>
        maplibreOnlyCalls(file).map((hit) => `${plugin} -> ${relative(PLUGIN_DIR, file)}:${hit}`),
      ),
    );
    assert.deepEqual(
      offenders,
      [],
      "these modules are reachable from a plugin that declares Mapbox support but call " +
        "a member only a MapLibre map has, which throws (or silently no-ops) on Mapbox: " +
        "branch on the engine, or mark a call guarded by a runtime engine check with " +
        `"${MAPLIBRE_ONLY_OPT_OUT}"`,
    );
  });

  it("finds the ArcGIS-capable plugins to audit", () => {
    assert.ok(arcgisPluginClosures().length > 0, "no plugin declares ArcGIS support");
  });

  it("does not lean on a style map, which the ArcGIS renderer does not have", () => {
    const offenders = arcgisPluginClosures().flatMap(({ plugin, files }) =>
      files.flatMap((file) =>
        styleMapReads(file).map((line) => `${plugin} -> ${relative(PLUGIN_DIR, file)}:${line}`),
      ),
    );
    assert.deepEqual(
      offenders,
      [],
      "these modules are reachable from a plugin that declares ArcGIS support but read " +
        "a MapLibre/Mapbox map, which is null on the ArcGIS renderer: go through the " +
        "store and the engine-neutral API, or mark a read whose null answer is handled " +
        `on purpose with "${ARCGIS_NULL_MAP_OPT_OUT}"`,
    );
  });

  it("reads the viewport through app.getViewBounds, not getMap()?.getBounds()", () => {
    const offenders = cesiumPluginClosures().flatMap(({ plugin, files }) =>
      files.flatMap((file) =>
        boundsReadsThroughGetMap(file).map(
          (line) => `${plugin} -> ${relative(PLUGIN_DIR, file)}:${line}`,
        ),
      ),
    );
    assert.deepEqual(
      offenders,
      [],
      "these modules are reachable from a plugin that declares Cesium support but read " +
        "bounds through the MapLibre map, which is null on the globe: use " +
        `app.getViewBounds(), or mark a deliberate branch with "${AUDIT_OPT_OUT}"`,
    );
  });
});
