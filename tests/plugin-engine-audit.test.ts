import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

const PLUGIN_DIR = join(import.meta.dirname, "..", "packages", "plugins", "src", "plugins");

/** Declares Cesium in its `engines` list, whatever the order or spacing. */
const DECLARES_CESIUM = /engines:\s*\[[^\]]*"cesium"[^\]]*\]/;

/** `getMap()`-routed viewport read: `app.getMap?.()?.getBounds()` and friends. */
const GET_MAP_BOUNDS = /getMap\??\.?\(\)[^;\n]*\.getBounds\(\)/;

/**
 * Drop comments before scanning: a module that explains why it avoids one of
 * these calls names the call, and would otherwise report itself.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function cesiumPluginSources(): { name: string; source: string }[] {
  return readdirSync(PLUGIN_DIR)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ name, source: stripComments(readFileSync(join(PLUGIN_DIR, name), "utf8")) }))
    .filter(({ source }) => DECLARES_CESIUM.test(source));
}

describe("plugin engine audit", () => {
  it("finds the Cesium-capable plugins to audit", () => {
    // A regex that stops matching would make every assertion below vacuous.
    assert.ok(cesiumPluginSources().length > 0, "no plugin declares Cesium support");
  });

  it("reads the viewport through app.getViewBounds, not getMap()?.getBounds()", () => {
    const offenders = cesiumPluginSources()
      .filter(({ source }) => GET_MAP_BOUNDS.test(source))
      .map(({ name }) => name);
    assert.deepEqual(
      offenders,
      [],
      "these plugins declare Cesium support but read bounds through the MapLibre map, " +
        "which is null on the globe: use app.getViewBounds()",
    );
  });
});
