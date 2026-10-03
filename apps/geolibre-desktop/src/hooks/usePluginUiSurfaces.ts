import {
  getFloatingPanelsSnapshot,
  getMenuContributionsSnapshot,
  getToolbarMenusSnapshot,
  subscribeFloatingPanels,
  subscribeMenuContributions,
  subscribeToolbarMenus,
  type FloatingPanelsSnapshot,
  type MenuContributionsSnapshot,
  type ToolbarMenusSnapshot,
} from "@geolibre/plugins";
import { useSyncExternalStore } from "react";

/**
 * Subscribe React to the plugin toolbar-menu registry in `@geolibre/plugins`.
 *
 * @returns The current toolbar-menus snapshot (stable identity between
 *   mutations, so it is safe to use directly in `useSyncExternalStore`).
 */
export function useToolbarMenus(): ToolbarMenusSnapshot {
  return useSyncExternalStore(
    subscribeToolbarMenus,
    getToolbarMenusSnapshot,
    getToolbarMenusSnapshot,
  );
}

/**
 * Subscribe React to the plugin menu-contribution registry in
 * `@geolibre/plugins` (items plugins add to the built-in toolbar menus).
 *
 * @returns The current menu-contributions snapshot (stable identity between
 *   mutations).
 */
export function useMenuContributions(): MenuContributionsSnapshot {
  return useSyncExternalStore(
    subscribeMenuContributions,
    getMenuContributionsSnapshot,
    getMenuContributionsSnapshot,
  );
}

/**
 * Subscribe React to the plugin floating-panel registry in `@geolibre/plugins`.
 *
 * @returns The current floating-panels snapshot (open ids in stacking order).
 */
export function useFloatingPanels(): FloatingPanelsSnapshot {
  return useSyncExternalStore(
    subscribeFloatingPanels,
    getFloatingPanelsSnapshot,
    getFloatingPanelsSnapshot,
  );
}
