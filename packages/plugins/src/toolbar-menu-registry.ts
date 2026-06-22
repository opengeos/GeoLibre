import type { GeoLibreToolbarMenu } from "./types";

/**
 * Imperative registry for plugin-owned top toolbar menus.
 *
 * A plugin can contribute its own top-level menu button to the GeoLibre banner
 * (beside Project / Edit / View / Plugins), with nested submenus and action
 * items. Mirrors the open/subscribe pattern used by the other registries in
 * this package; the desktop toolbar subscribes with `useSyncExternalStore` and
 * renders one dropdown per registered menu.
 */

/**
 * Reactive snapshot consumed by `useSyncExternalStore`. The `menus` array
 * identity is stable between mutations so React can skip re-renders; `version`
 * is bumped on every change.
 */
export interface ToolbarMenusSnapshot {
  menus: GeoLibreToolbarMenu[];
  version: number;
}

const registry = new Map<string, GeoLibreToolbarMenu>();
const listeners = new Set<() => void>();

let version = 0;
let snapshot: ToolbarMenusSnapshot = { menus: [], version: 0 };

function emit(): void {
  version += 1;
  snapshot = { menus: [...registry.values()], version };
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Register a plugin-owned top toolbar menu. Returns an unregister function (call
 * it from the plugin's `deactivate` hook). Re-registering the same id replaces
 * the menu, so a plugin can rebuild its menu as its state changes.
 */
export function registerToolbarMenu(menu: GeoLibreToolbarMenu): () => void {
  if (!menu || typeof menu.id !== "string" || menu.id.length === 0) {
    throw new Error("registerToolbarMenu requires a menu with a non-empty id.");
  }
  if (typeof menu.label !== "string" || menu.label.length === 0) {
    throw new Error(`Toolbar menu "${menu.id}" must have a non-empty label.`);
  }
  if (!Array.isArray(menu.items)) {
    throw new Error(`Toolbar menu "${menu.id}" must have an items array.`);
  }
  // Re-registering an id replaces the menu. The returned disposer only removes
  // the menu while this exact registration is still current, so a stale disposer
  // cannot evict a newer menu that reused the id.
  registry.set(menu.id, menu);
  emit();
  return () => {
    if (registry.get(menu.id) === menu) unregisterToolbarMenu(menu.id);
  };
}

/** Remove a previously registered toolbar menu. */
export function unregisterToolbarMenu(id: string): void {
  if (!registry.delete(id)) return;
  emit();
}

/** All registered toolbar menus, in registration order. */
export function listToolbarMenus(): GeoLibreToolbarMenu[] {
  return [...registry.values()];
}

/** Current reactive snapshot for `useSyncExternalStore`. */
export function getToolbarMenusSnapshot(): ToolbarMenusSnapshot {
  return snapshot;
}

/** Subscribe to toolbar-menu registry changes. Returns an unsubscribe. */
export function subscribeToolbarMenus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Test-only: reset the registry to its initial empty state. Not part of the
 * public plugin API.
 */
export function __resetToolbarMenuRegistryForTests(): void {
  registry.clear();
  listeners.clear();
  version = 0;
  snapshot = { menus: [], version: 0 };
}
