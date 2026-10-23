/**
 * The locale half of the plugin app API: `getLocale`, `onLocaleChange`,
 * `translate` and `registerTranslations`.
 *
 * A plugin owns its panels as plain DOM (it cannot share the host's React, so it
 * cannot call `useTranslation`), and before GeoLibre#2021 the host handed it no
 * language information at all — plugin-rendered text stayed English in every
 * locale. These three methods are the whole contract: read the current language,
 * be told when it changes, and resolve a key with the plugin's own English text
 * as the fallback.
 *
 * Kept in its own module, parameterized over a minimal i18next-shaped host, so
 * it is unit-testable without booting the app's real i18n instance.
 */

/** The slice of the i18next instance this module needs. */
export interface PluginLocaleI18n {
  language: string;
  // Narrowed to the "always pass a defaultValue" overload: every call from
  // here supplies one, and the app's `t` is typed against the English catalog,
  // which cannot know a plugin's keys.
  t: (key: string, options: { defaultValue: string } & Record<string, unknown>) => string;
  on: (event: "languageChanged", listener: (locale: string) => void) => void;
  off: (event: "languageChanged", listener: (locale: string) => void) => void;
  /**
   * i18next's resource merge, used by `registerTranslations`. Optional so a
   * minimal host (and the tests' fakes) can omit it; plugin bundles are then
   * ignored and `translate` keeps falling back to the plugin's English.
   */
  addResourceBundle?: (
    lng: string,
    ns: string,
    resources: Record<string, unknown>,
    deep: boolean,
    overwrite: boolean,
  ) => unknown;
}

/** Per-locale flat `{ "plugin.<id>.key": "text" }` maps a plugin ships. */
export type PluginTranslationResources = Record<string, Record<string, string>>;

/** The namespace every plugin-registered key must live under. */
const PLUGIN_KEY_PREFIX = "plugin.";

/** Path segments that would let a key write through an object prototype. */
const UNSAFE_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Expands flat dotted keys into the nested shape i18next stores, keeping only
 * string values under the `plugin.` namespace.
 *
 * Args:
 *   flat: A plugin's `{ "plugin.<id>.key": "text" }` map for one locale.
 *
 * Returns:
 *   The nested tree and the keys that were rejected (non-string values, keys
 *   outside `plugin.<id>.`, or keys that clash with a sibling's path).
 */
function nestPluginKeys(flat: Record<string, unknown>): {
  tree: Record<string, unknown>;
  rejected: string[];
} {
  const tree: Record<string, unknown> = {};
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split(".");
    if (
      typeof value !== "string" ||
      !key.startsWith(PLUGIN_KEY_PREFIX) ||
      parts.length < 3 ||
      parts.some((part) => part === "" || UNSAFE_SEGMENTS.has(part))
    ) {
      rejected.push(key);
      continue;
    }
    let node = tree;
    let clash = false;
    for (const part of parts.slice(0, -1)) {
      const next = node[part];
      if (next === undefined) node[part] = {};
      else if (typeof next !== "object") {
        clash = true;
        break;
      }
      node = node[part] as Record<string, unknown>;
    }
    const leaf = parts[parts.length - 1];
    if (clash || typeof node[leaf] === "object") {
      rejected.push(key);
      continue;
    }
    node[leaf] = value;
  }
  return { tree, rejected };
}

/** The locale methods mixed into the object `createAppAPI` returns. */
export interface PluginLocaleApi {
  getLocale: () => string;
  onLocaleChange: (listener: (locale: string) => void) => () => void;
  translate: (
    key: string,
    defaultValue: string,
    params?: Record<string, string | number>,
  ) => string;
  registerTranslations: (resources: PluginTranslationResources) => void;
}

export function createPluginLocaleApi(i18n: PluginLocaleI18n): PluginLocaleApi {
  return {
    getLocale: () => i18n.language,

    onLocaleChange: (listener) => {
      // A plugin listener throwing must not abort i18next's dispatch, which
      // would leave every listener registered after it (including the host's
      // own) unnotified and the UI half-switched.
      const guarded = (locale: string) => {
        try {
          listener(locale);
        } catch (error) {
          console.error("[GeoLibre] A plugin onLocaleChange listener threw.", error);
        }
      };
      i18n.on("languageChanged", guarded);
      // Idempotent: a plugin that unsubscribes in `deactivate` and again on
      // teardown must not remove a listener a later re-activation registered.
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        i18n.off("languageChanged", guarded);
      };
    },

    translate: (key, defaultValue, params) => {
      // `defaultValue` last would let a plugin's own `defaultValue` param
      // override the fallback; spread params first so it cannot.
      const value = i18n.t(key, { ...params, defaultValue });
      // i18next is configured with `returnNull: false`, but a plugin can reach
      // this with any key shape (including one whose catalog value is an
      // object); keep the declared return type honest.
      return typeof value === "string" ? value : defaultValue;
    },

    registerTranslations: (resources) => {
      if (!resources || typeof resources !== "object") return;
      for (const [locale, flat] of Object.entries(resources)) {
        if (!locale || !flat || typeof flat !== "object") continue;
        const { tree, rejected } = nestPluginKeys(flat as Record<string, unknown>);
        if (rejected.length > 0) {
          console.warn(
            `[GeoLibre] registerTranslations ignored ${rejected.length} key(s) for "${locale}" ` +
              `that are not strings under "plugin.<id>.": ${rejected.slice(0, 5).join(", ")}`,
          );
        }
        if (Object.keys(tree).length === 0) continue;
        // Deep merge, never overwrite: a plugin may add its own keys but must
        // not replace a string the host (or another plugin) already ships. A
        // bundled catalog that lazy-loads later merges with overwrite on, so
        // the host's translation still wins over a plugin's for the same key.
        i18n.addResourceBundle?.(locale, "translation", tree, true, false);
      }
    },
  };
}
