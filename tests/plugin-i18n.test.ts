import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createPluginTranslator,
  interpolatePluginText,
  pluginDisplayTitle,
} from "../packages/plugins/src/plugin-i18n";

describe("plugin translation helpers", () => {
  it("interpolates an English fallback like i18next would", () => {
    assert.equal(interpolatePluginText("{{n}} of {{ total }}", { n: 2, total: 5 }), "2 of 5");
    assert.equal(interpolatePluginText("{{missing}} left", {}), " left");
    assert.equal(interpolatePluginText("No params {{x}}"), "No params {{x}}");
  });

  it("namespaces keys by plugin id and passes the fallback through", () => {
    const calls: unknown[][] = [];
    const tr = createPluginTranslator(
      {
        translate: (key, fallback, params) => {
          calls.push([key, fallback, params]);
          return key === "plugin.demo.title" ? "Démo" : fallback;
        },
      },
      "demo",
    );
    assert.equal(tr("title", "Demo"), "Démo");
    assert.equal(tr("other", "Other", { n: 1 }), "Other");
    assert.deepEqual(calls[1], ["plugin.demo.other", "Other", { n: 1 }]);
  });

  it("treats an @-prefixed key as absolute", () => {
    const seen: string[] = [];
    const tr = createPluginTranslator(
      { translate: (key, fallback) => (seen.push(key), fallback) },
      "demo",
    );
    tr("@common.cancel", "Cancel");
    assert.deepEqual(seen, ["common.cancel"]);
  });

  it("falls back to interpolated English without a host translate", () => {
    assert.equal(createPluginTranslator({}, "demo")("count", "{{n}} items", { n: 3 }), "3 items");
    assert.equal(createPluginTranslator(null, "demo")("x", "Plain"), "Plain");
  });

  it("reads the app lazily through a getter", () => {
    let app: { translate?: (k: string, f: string) => string } | null = null;
    const tr = createPluginTranslator(() => app, "demo");
    assert.equal(tr("title", "Demo"), "Demo");
    app = { translate: () => "Translated" };
    assert.equal(tr("title", "Demo"), "Translated");
  });

  it("titles a panel with the plugin's translated display name", () => {
    const keys: string[] = [];
    const title = pluginDisplayTitle(
      {
        translate: (key, fallback) => (keys.push(key), key.endsWith("swipe") ? "Rideau" : fallback),
      },
      "maplibre-gl-swipe",
      "Layer Swipe",
    );
    assert.equal(title(), "Rideau");
    assert.deepEqual(keys, ["toolbar.plugin.maplibre-gl-swipe"]);
    assert.equal(pluginDisplayTitle({}, "x", "Name")(), "Name");
  });
});
