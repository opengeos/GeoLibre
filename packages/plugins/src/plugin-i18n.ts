/**
 * Shared translation helper for plugins that render their own DOM.
 *
 * A built-in plugin cannot call `useTranslation` (its panels are plain DOM),
 * so it resolves strings through the app API's `translate`, passing its own
 * English text as the fallback. Several plugins grew a private `tr` helper for
 * that; this is the one to use for new code, so the fallback-with-interpolation
 * behavior and the `plugin.<id>.` key prefix stay consistent.
 */
import type { GeoLibreAppAPI } from "./types";

/** Interpolation values for `{{placeholder}}` tokens in a message. */
export type PluginTranslateParams = Record<string, string | number>;

/**
 * Resolves a key (relative to the plugin's namespace) to display text. The
 * English `fallback` is returned, interpolated, when no catalog has the key.
 */
export type PluginTranslate = (
  key: string,
  fallback: string,
  params?: PluginTranslateParams,
) => string;

/** The slice of the app API a translator needs. */
type TranslateHost = Pick<GeoLibreAppAPI, "translate">;

/**
 * Fills `{{name}}` tokens in an English fallback, mirroring what i18next does
 * for catalog strings, so a host without `translate` still renders counts and
 * names instead of raw placeholders.
 *
 * Args:
 *   text: The English text, possibly carrying `{{name}}` tokens.
 *   params: Values for the tokens; a missing value renders as an empty string.
 *
 * Returns:
 *   The interpolated text.
 */
export function interpolatePluginText(text: string, params?: PluginTranslateParams): string {
  if (!params) return text;
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) =>
    params[name] === undefined ? "" : String(params[name]),
  );
}

/**
 * A panel-title getter that shows the plugin's display name in the host
 * language. The host translates every built-in plugin's name under
 * `toolbar.plugin.<id>` for the Plugins menu, so resolving the dock header
 * through the same key keeps the panel and the menu that opened it in step.
 *
 * Args:
 *   app: The app API (its `translate` is optional).
 *   pluginId: The plugin id, which keys the display name.
 *   fallback: The English name, shown when no catalog has the key.
 *
 * Returns:
 *   A getter suitable for a panel registration's `title`.
 */
export function pluginDisplayTitle(
  app: TranslateHost,
  pluginId: string,
  fallback: string,
): () => string {
  return () => app.translate?.(`toolbar.plugin.${pluginId}`, fallback) ?? fallback;
}

/**
 * Builds a translator bound to one plugin's key namespace.
 *
 * Keys resolve under `plugin.<pluginId>.<key>`. A key that starts with `@` is
 * treated as absolute (the `@` is stripped), for reusing a host key such as
 * `@toolbar.plugin.<id>` (the plugin's display name, already translated in
 * every bundled locale) or `@common.cancel`.
 *
 * Args:
 *   app: The app API, or a getter for it when the plugin keeps the API in a
 *     module-level reference that is only set while it is active.
 *   pluginId: The plugin id used as the key namespace.
 *
 * Returns:
 *   A {@link PluginTranslate} function.
 */
export function createPluginTranslator(
  app: TranslateHost | null | undefined | (() => TranslateHost | null | undefined),
  pluginId: string,
): PluginTranslate {
  return (key, fallback, params) => {
    const host = typeof app === "function" ? app() : app;
    const fullKey = key.startsWith("@") ? key.slice(1) : `plugin.${pluginId}.${key}`;
    const text = host?.translate?.(fullKey, fallback, params);
    return typeof text === "string" ? text : interpolatePluginText(fallback, params);
  };
}
