import type { GeoLibreToolbarMenu, ToolbarMenuEntry } from "@geolibre/plugins";

/**
 * Group the registered top-level toolbar menus by the plugin that owns them.
 * Menus with no owner or no items are left out, matching what the banner
 * would show.
 */
export function toolbarMenusByOwner(
  entries: readonly ToolbarMenuEntry[],
): Map<string, GeoLibreToolbarMenu[]> {
  const byOwner = new Map<string, GeoLibreToolbarMenu[]>();
  for (const entry of entries) {
    if (!entry.ownerPluginId || entry.menu.items.length === 0) continue;
    const owned = byOwner.get(entry.ownerPluginId) ?? [];
    owned.push(entry.menu);
    byOwner.set(entry.ownerPluginId, owned);
  }
  return byOwner;
}

/**
 * The folded-menu plugin list with `pluginId` added (`folded`) or removed.
 * Returns a new array and never duplicates an id.
 */
export function withPluginMenuFolded(
  foldedPluginMenus: readonly string[],
  pluginId: string,
  folded: boolean,
): string[] {
  const others = foldedPluginMenus.filter((id) => id !== pluginId);
  return folded ? [...others, pluginId] : others;
}
