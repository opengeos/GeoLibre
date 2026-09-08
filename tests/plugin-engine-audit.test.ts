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
function optedOutAt(rawLines: string[], line: number): boolean {
  return rawLines
    .slice(Math.max(0, line - 1 - OPT_OUT_LOOKBACK), line)
    .some((text) => text.includes(AUDIT_OPT_OUT));
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

/** Plugin entry points that declare Cesium support, with everything they import. */
function cesiumPluginClosures(): { plugin: string; files: string[] }[] {
  return readdirSync(PLUGIN_DIR)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(PLUGIN_DIR, name))
    .filter((file) => DECLARES_CESIUM.test(blankComments(readFileSync(file, "utf8"))))
    .map((file) => ({ plugin: relative(PLUGIN_DIR, file), files: importClosure(file) }));
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
