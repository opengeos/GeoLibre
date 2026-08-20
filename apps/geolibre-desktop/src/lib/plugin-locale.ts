/**
 * The locale half of the plugin app API: `getLocale`, `onLocaleChange` and
 * `translate`.
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
  };
}
