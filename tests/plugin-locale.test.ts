import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createPluginLocaleApi,
  type PluginLocaleI18n,
} from "../apps/geolibre-desktop/src/lib/plugin-locale";

/** Minimal i18next stand-in with a real listener list, so unsubscribe is observable. */
function fakeI18n(catalog: Record<string, string> = {}) {
  const listeners = new Set<(locale: string) => void>();
  const i18n: PluginLocaleI18n & {
    listenerCount: () => number;
    emit: (locale: string) => void;
  } = {
    language: "en",
    t: (key, options) => {
      const value = catalog[key];
      if (value === undefined) return options.defaultValue;
      return value.replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
        String((options as Record<string, unknown>)[name] ?? ""),
      );
    },
    on: (_event, listener) => {
      listeners.add(listener);
    },
    off: (_event, listener) => {
      listeners.delete(listener);
    },
    listenerCount: () => listeners.size,
    emit: (locale) => {
      i18n.language = locale;
      for (const listener of [...listeners]) listener(locale);
    },
  };
  return i18n;
}

describe("createPluginLocaleApi", () => {
  it("reports the host's active language", () => {
    const i18n = fakeI18n();
    const api = createPluginLocaleApi(i18n);
    assert.equal(api.getLocale(), "en");
    i18n.emit("zh");
    assert.equal(api.getLocale(), "zh");
  });

  it("notifies subscribers of a language change and stops on unsubscribe", () => {
    const i18n = fakeI18n();
    const api = createPluginLocaleApi(i18n);
    const seen: string[] = [];
    const unsubscribe = api.onLocaleChange((locale) => seen.push(locale));

    i18n.emit("fr");
    assert.deepEqual(seen, ["fr"]);

    unsubscribe();
    i18n.emit("de");
    assert.deepEqual(seen, ["fr"]);
    assert.equal(i18n.listenerCount(), 0);
  });

  it("keeps a second unsubscribe from removing a later subscription", () => {
    // A plugin that unsubscribes in `deactivate` and again on teardown must not
    // detach the listener its re-activation registered.
    const i18n = fakeI18n();
    const api = createPluginLocaleApi(i18n);
    const unsubscribe = api.onLocaleChange(() => {});
    unsubscribe();

    const seen: string[] = [];
    api.onLocaleChange((locale) => seen.push(locale));
    unsubscribe();

    i18n.emit("ja");
    assert.deepEqual(seen, ["ja"]);
  });

  it("isolates a throwing listener so later subscribers still run", () => {
    const i18n = fakeI18n();
    const api = createPluginLocaleApi(i18n);
    const seen: string[] = [];
    api.onLocaleChange(() => {
      throw new Error("plugin bug");
    });
    api.onLocaleChange((locale) => seen.push(locale));

    const errors = console.error;
    console.error = () => {};
    try {
      i18n.emit("ko");
    } finally {
      console.error = errors;
    }
    assert.deepEqual(seen, ["ko"]);
  });

  it("translates a key and falls back to the plugin's own text", () => {
    const api = createPluginLocaleApi(fakeI18n({ "plugin.demo.title": "演示" }));
    assert.equal(api.translate("plugin.demo.title", "Demo"), "演示");
    assert.equal(api.translate("plugin.demo.missing", "Untranslated"), "Untranslated");
  });

  it("interpolates params without letting one shadow the fallback", () => {
    const api = createPluginLocaleApi(fakeI18n({ "plugin.demo.count": "{{n}} 个要素" }));
    assert.equal(api.translate("plugin.demo.count", "{{n}} features", { n: 3 }), "3 个要素");
    // A plugin passing its own `defaultValue` in params must not be able to
    // replace the fallback the API contract promises.
    assert.equal(
      api.translate("plugin.demo.absent", "Fallback", {
        defaultValue: "hijacked",
      } as unknown as Record<string, string>),
      "Fallback",
    );
  });

  it("returns the fallback when a catalog entry is not a string", () => {
    const i18n = fakeI18n();
    i18n.t = (() => ({ nested: "object" })) as unknown as PluginLocaleI18n["t"];
    const api = createPluginLocaleApi(i18n);
    assert.equal(api.translate("plugin.demo.branch", "Fallback"), "Fallback");
  });
});
