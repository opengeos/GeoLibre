import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { pluginDeepLinkNames } from "../apps/geolibre-desktop/src/lib/plugin-deep-link";
import { buildPluginDoc, collectBuiltInPlugins } from "../scripts/gen-plugin-reference.mjs";

// docs/user-guide/plugins.md carries a table generated from the plugin
// registry (scripts/gen-plugin-reference.mjs). These fail when a plugin is
// registered, renamed, or regrouped without regenerating the table.
describe("built-in plugin reference (docs/user-guide/plugins.md)", () => {
  it("matches the plugin registry", () => {
    const { current, expected } = buildPluginDoc();
    assert.ok(
      current === expected,
      "docs/user-guide/plugins.md is stale: run `npm run plugins:docs` and commit the result",
    );
  });

  it("lists one row per registered plugin with a unique id", () => {
    const plugins = collectBuiltInPlugins();
    assert.ok(plugins.length > 50, `expected the full registry, got ${plugins.length} plugins`);
    assert.equal(new Set(plugins.map((plugin) => plugin.id)).size, plugins.length);
    for (const plugin of plugins) {
      assert.match(plugin.id, /^[a-z0-9-]+$/, `${plugin.id} is not a plugin id`);
      assert.ok(plugin.name.length > 0, `${plugin.id} has no display name`);
    }
  });

  it("derives link names exactly as the ?plugin= parser does", () => {
    const plugins = collectBuiltInPlugins().filter((plugin) => plugin.linkName !== null);
    assert.deepEqual(
      plugins.map((plugin) => plugin.linkName).sort(),
      pluginDeepLinkNames(plugins.map((plugin) => plugin.id)),
    );
  });
});
