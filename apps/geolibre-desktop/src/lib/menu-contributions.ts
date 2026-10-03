import type {
  GeoLibreMenuContributionTarget,
  GeoLibreToolbarMenuItem,
  MenuContributionEntry,
} from "@geolibre/plugins";

/** One plugin's submenu in a built-in toolbar menu. */
export interface MenuContributionGroup {
  /** Stable key: the owning plugin's id, or the contribution id when unowned. */
  key: string;
  /** Plugin id and name for the submenu title (`pluginDisplayName`). */
  id: string;
  name?: string;
  /**
   * One section per contribution, in registration order. The host draws a
   * separator between sections; keeping them apart (rather than concatenating
   * the items) keeps item ids scoped to their own contribution.
   */
  sections: { id: string; items: GeoLibreToolbarMenuItem[] }[];
}

/**
 * Whether an item would render (`renderItems` skips anything else): an object
 * that is not a separator, and, for a submenu, one with an items array.
 */
function isRenderableItem(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const { type, items } = item as { type?: unknown; items?: unknown };
  if (type === "separator") return false;
  return type !== "submenu" || Array.isArray(items);
}

/**
 * Collect the contributions for one built-in menu into one group per plugin
 * (GeoLibre#2850).
 *
 * A plugin that registers several contributions to the same menu gets a single
 * submenu, with one section per contribution, so the menu
 * never shows the same plugin name twice. Contributions with no renderable
 * items are skipped, so a plugin never shows a submenu that opens to nothing. A
 * contribution registered without an owner (only possible when the host itself
 * calls the registry) is grouped on its own, under its id.
 *
 * Groups come back in registration order; the caller sorts them by display
 * name, which needs `t`.
 */
export function groupMenuContributions(
  entries: readonly MenuContributionEntry[],
  target: GeoLibreMenuContributionTarget,
): MenuContributionGroup[] {
  const groups = new Map<string, MenuContributionGroup>();
  for (const entry of entries) {
    const { contribution } = entry;
    if (contribution.menu !== target || !contribution.items.some(isRenderableItem)) continue;
    const key = entry.ownerPluginId ?? `contribution:${contribution.id}`;
    const group = groups.get(key);
    if (group) {
      group.sections.push({ id: contribution.id, items: contribution.items });
    } else {
      groups.set(key, {
        key,
        id: entry.ownerPluginId ?? contribution.id,
        name: entry.ownerPluginName,
        sections: [{ id: contribution.id, items: contribution.items }],
      });
    }
  }
  return [...groups.values()];
}
