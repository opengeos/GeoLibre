import type { TFunction } from "i18next";

/**
 * Catalog namespace holding a plugin's translated display name, keyed by plugin
 * id (`toolbar.plugin.<id>`). Kept here rather than inlined at each call site so
 * every surface that shows a plugin name resolves the same key.
 */
export const PLUGIN_NAME_KEY_PREFIX = "toolbar.plugin";

/**
 * Resolve a plugin's display name for the active locale.
 *
 * The Plugins menu has always translated names through `toolbar.plugin.<id>`,
 * but the command palette, Settings → Interface and Manage Plugins rendered the
 * registered (English) `plugin.name` directly, so the same plugin could read
 * "注释" in one menu and "Annotations" in the next (GeoLibre#2021). Every
 * surface now goes through this helper.
 *
 * A plugin with no catalog entry falls back to its registered name, which is the
 * right answer for the brand/proper-noun plugins (Mapillary, NASA Earthdata,
 * OpenAerialMap, …) that deliberately carry no key, and for externally installed
 * plugins whose names the host cannot know at build time.
 */
export function pluginDisplayName(t: TFunction, plugin: { id: string; name?: string }): string {
  const fallback =
    typeof plugin.name === "string" && plugin.name.length > 0 ? plugin.name : plugin.id;
  return t(`${PLUGIN_NAME_KEY_PREFIX}.${plugin.id}`, {
    defaultValue: fallback,
  });
}
