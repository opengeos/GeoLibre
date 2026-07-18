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
 * A registered toolbar menu paired with the id of the plugin that registered it
 * (when the host scoped the registration to a plugin). `ownerPluginId` lets the
 * toolbar place a menu by its owner — e.g. external plugin menus after Help.
 */
export interface ToolbarMenuEntry {
  menu: GeoLibreToolbarMenu;
  ownerPluginId?: string;
}

/**
 * Reactive snapshot consumed by `useSyncExternalStore`. The `menus`/`entries`
 * array identities are stable between mutations so React can skip re-renders;
 * `version` is bumped on every change.
 *
 * `menus` predates ownership tracking and is retained for snapshot-shape
 * backward compatibility (external consumers may read it); `entries` is the
 * richer form that additionally carries each menu's owning plugin id, and is
 * what in-repo consumers use.
 */
export interface ToolbarMenusSnapshot {
  menus: GeoLibreToolbarMenu[];
  entries: ToolbarMenuEntry[];
  version: number;
}

const registry = new Map<string, ToolbarMenuEntry>();
const listeners = new Set<() => void>();

let version = 0;
let snapshot: ToolbarMenusSnapshot = { menus: [], entries: [], version: 0 };

function emit(): void {
  version += 1;
  const entries = [...registry.values()];
  snapshot = { menus: entries.map((entry) => entry.menu), entries, version };
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Register a plugin-owned top toolbar menu. Returns an unregister function (call
 * it from the plugin's `deactivate` hook). Re-registering the same id replaces
 * the menu, so a plugin can rebuild its menu as its state changes.
 *
 * `ownerPluginId` is injected by the host (the PluginManager scopes each
 * plugin's app API to its id); plugins call this with a single argument.
 */
export function registerToolbarMenu(menu: GeoLibreToolbarMenu, ownerPluginId?: string): () => void {
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
  const entry: ToolbarMenuEntry = { menu, ownerPluginId };
  registry.set(menu.id, entry);
  emit();
  return () => {
    if (registry.get(menu.id) === entry) unregisterToolbarMenu(menu.id);
  };
}

/** Remove a previously registered toolbar menu. */
export function unregisterToolbarMenu(id: string): void {
  if (!registry.delete(id)) return;
  emit();
}

/** All registered toolbar menus, in registration order. */
export function listToolbarMenus(): GeoLibreToolbarMenu[] {
  return [...registry.values()].map((entry) => entry.menu);
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
  snapshot = { menus: [], entries: [], version: 0 };
}
