import assert from "node:assert/strict";
import { describe, it } from "node:test";
import i18next from "i18next";
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

describe("registerTranslations", () => {
  /** A real i18next instance configured like the app's (en fallback, sync init). */
  async function realI18n(catalogs: Record<string, Record<string, unknown>>) {
    const instance = i18next.createInstance();
    await instance.init({
      lng: "en",
      fallbackLng: "en",
      resources: Object.fromEntries(
        Object.entries(catalogs).map(([lng, translation]) => [lng, { translation }]),
      ),
      interpolation: { escapeValue: false },
      returnNull: false,
    });
    return instance;
  }

  it("lets a plugin ship translations that translate() then resolves", async () => {
    const i18n = await realI18n({ en: {} });
    const api = createPluginLocaleApi(i18n as unknown as PluginLocaleI18n);
    api.registerTranslations({
      de: { "plugin.demo.title": "Werkbank", "plugin.demo.count": "{{n}} Objekte" },
    });
    assert.equal(api.translate("plugin.demo.title", "Workbench"), "Workbench");
    await i18n.changeLanguage("de");
    assert.equal(api.translate("plugin.demo.title", "Workbench"), "Werkbank");
    assert.equal(api.translate("plugin.demo.count", "{{n}} features", { n: 2 }), "2 Objekte");
  });

  it("never overrides a key the host catalog already ships", async () => {
    const i18n = await realI18n({ en: {}, de: { plugin: { demo: { title: "Host" } } } });
    const api = createPluginLocaleApi(i18n as unknown as PluginLocaleI18n);
    api.registerTranslations({ de: { "plugin.demo.title": "Plugin" } });
    await i18n.changeLanguage("de");
    assert.equal(api.translate("plugin.demo.title", "Workbench"), "Host");
  });

  it("keeps a host catalog that lazy-loads later in charge of shared keys", async () => {
    const i18n = await realI18n({ en: {} });
    const api = createPluginLocaleApi(i18n as unknown as PluginLocaleI18n);
    api.registerTranslations({
      fr: { "plugin.demo.title": "Plugin", "plugin.demo.only": "Seulement" },
    });
    // The app lazy-loads a locale with a deep, overwriting merge (i18n/index.ts).
    i18n.addResourceBundle(
      "fr",
      "translation",
      { plugin: { demo: { title: "Hôte" } } },
      true,
      true,
    );
    await i18n.changeLanguage("fr");
    assert.equal(api.translate("plugin.demo.title", "Workbench"), "Hôte");
    assert.equal(api.translate("plugin.demo.only", "Only"), "Seulement");
  });

  it("rejects keys outside plugin.<id>. and non-string values", async () => {
    const i18n = await realI18n({ en: { common: { cancel: "Cancel" } } });
    const api = createPluginLocaleApi(i18n as unknown as PluginLocaleI18n);
    const warn = console.warn;
    const warnings: unknown[] = [];
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      api.registerTranslations({
        en: {
          "common.cancel": "Hijacked",
          "plugin.x": "too shallow",
          "plugin.demo.__proto__.polluted": "nope",
          "plugin.demo.ok": "Fine",
          "plugin.demo.bad": 42 as unknown as string,
        },
      });
    } finally {
      console.warn = warn;
    }
    assert.equal(warnings.length, 1);
    assert.equal(api.translate("common.cancel", "x"), "Cancel");
    assert.equal(api.translate("plugin.demo.ok", "x"), "Fine");
    assert.equal((Object.prototype as Record<string, unknown>).polluted, undefined);
    assert.equal(i18n.exists("plugin.demo.__proto__.polluted"), false);
  });

  it("is a no-op on a host without addResourceBundle", () => {
    const api = createPluginLocaleApi(fakeI18n());
    api.registerTranslations({ de: { "plugin.demo.title": "Werkbank" } });
    assert.equal(api.translate("plugin.demo.title", "Workbench"), "Workbench");
  });
});
