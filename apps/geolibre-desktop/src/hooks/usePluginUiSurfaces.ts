import {
  getFloatingPanelsSnapshot,
  getToolbarMenusSnapshot,
  subscribeFloatingPanels,
  subscribeToolbarMenus,
  type FloatingPanelsSnapshot,
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
