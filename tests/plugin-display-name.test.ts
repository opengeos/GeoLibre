import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TFunction } from "i18next";
import { pluginDisplayName } from "../apps/geolibre-desktop/src/lib/plugin-display-name";

/**
 * Stand-in for i18next's `t`: returns the catalog entry for a key, or the
 * caller's `defaultValue` when there is none — the only behavior this helper
 * depends on.
 */
function fakeT(catalog: Record<string, string>): TFunction {
  return ((key: string, options?: { defaultValue?: string }) =>
    catalog[key] ?? options?.defaultValue ?? key) as unknown as TFunction;
}

describe("pluginDisplayName", () => {
  it("prefers the plugin's translated name", () => {
    const t = fakeT({ "toolbar.plugin.maplibre-gl-annotations": "注释" });
    assert.equal(
      pluginDisplayName(t, { id: "maplibre-gl-annotations", name: "Annotations" }),
      "注释",
    );
  });

  it("falls back to the registered name when the locale has no entry", () => {
    // Brand/proper-noun plugins deliberately carry no key, and externally
    // installed plugins cannot have one.
    const t = fakeT({});
    assert.equal(
      pluginDisplayName(t, { id: "maplibre-gl-mapillary", name: "Mapillary" }),
      "Mapillary",
    );
  });

  it("falls back to the plugin id when it has no usable name", () => {
    const t = fakeT({});
    assert.equal(pluginDisplayName(t, { id: "some-plugin" }), "some-plugin");
    assert.equal(pluginDisplayName(t, { id: "some-plugin", name: "" }), "some-plugin");
  });

  it("resolves the same key the Plugins menu has always used", () => {
    // The bug this helper fixes was the command palette / Settings / Manage
    // Plugins reading `plugin.name` while the Plugins menu read this key, so a
    // drift here would silently reintroduce the split (GeoLibre#2021).
    const seen: string[] = [];
    const t = ((key: string, options?: { defaultValue?: string }) => {
      seen.push(key);
      return options?.defaultValue ?? key;
    }) as unknown as TFunction;
    pluginDisplayName(t, { id: "maplibre-gl-basemaps", name: "Basemaps" });
    assert.deepEqual(seen, ["toolbar.plugin.maplibre-gl-basemaps"]);
  });
});
