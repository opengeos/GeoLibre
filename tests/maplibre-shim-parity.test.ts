import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { SHIMMED_PACKAGES } from "./hooks/maplibre-default-import-shim.mjs";

/**
 * Two shims rewrite `import X from "maplibre-gl"` to a namespace import inside
 * third-party bundles that still target v5: a Vite plugin for the app build and
 * a Node load hook for `node --test` (Vite cannot reach the test runner). They
 * must cover the same packages — a package shimmed in only one place fails in
 * whichever environment was missed, and only there.
 *
 * Both are temporary. When `@esri/maplibre-arcgis` or
 * `@geoman-io/maplibre-geoman-free` ship v6-compatible builds, drop the package
 * from both lists together. See opengeos/GeoLibre#1489 (blocker 1).
 */
const VITE_PLUGIN = fileURLToPath(
  new URL("../apps/geolibre-desktop/vite-plugins/maplibre-default-import-shim.ts", import.meta.url),
);

function shimmedPackagesInVitePlugin(): string[] {
  const source = readFileSync(VITE_PLUGIN, "utf8");
  const list = /const SHIMMED_PACKAGES = \[([^\]]*)\]/.exec(source);
  assert.ok(list, "SHIMMED_PACKAGES array not found in the Vite plugin");
  return [...list[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

describe("maplibre default-import shims", () => {
  it("cover the same packages in the Vite build and the Node test runner", () => {
    assert.deepEqual(shimmedPackagesInVitePlugin(), [...SHIMMED_PACKAGES]);
  });

  it("rewrites the default import forms both packages actually publish", async () => {
    const { rewriteDefaultImports } = await import("./hooks/maplibre-default-import-shim.mjs");

    // @esri/maplibre-arcgis (minified, no space before the specifier — the
    // rewrite normalizes that to one space, which is still valid ESM).
    assert.equal(
      rewriteDefaultImports('import Zt from"maplibre-gl"'),
      'import * as Zt from "maplibre-gl"',
    );
    // @geoman-io/maplibre-geoman-free (spaced).
    assert.equal(
      rewriteDefaultImports('import e from "maplibre-gl"'),
      'import * as e from "maplibre-gl"',
    );
    // Named and namespace imports are already v6-safe and must be left alone.
    assert.equal(
      rewriteDefaultImports('import { Popup } from "maplibre-gl"'),
      'import { Popup } from "maplibre-gl"',
    );
    assert.equal(
      rewriteDefaultImports('import * as ml from "maplibre-gl"'),
      'import * as ml from "maplibre-gl"',
    );
  });
});
