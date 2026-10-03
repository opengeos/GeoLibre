import {
  GEOLIBRE_MENU_CONTRIBUTION_TARGETS,
  type GeoLibreMenuContribution,
  type GeoLibreMenuContributionTarget,
} from "./types";

/**
 * Imperative registry for plugin items added to the built-in toolbar menus.
 *
 * Where `registerToolbarMenu` gives a plugin a top-level menu of its own, a
 * contribution adds items to an existing menu (Add Data, Processing, Controls),
 * the way a QGIS plugin calls `addPluginToVectorMenu` (GeoLibre#2850). The host
 * always nests a plugin's items under a submenu named after the plugin, after
 * the built-in entries, so a plugin can neither inject loose items between them
 * nor reorder them. Mirrors the open/subscribe pattern of the toolbar-menu
 * registry; the desktop menus subscribe with `useSyncExternalStore`.
 */

/**
 * A registered contribution plus the plugin that registered it. Both owner
 * fields are injected by the host (the PluginManager scopes each plugin's app
 * API), so the submenu can be named after the plugin.
 */
export interface MenuContributionEntry {
  contribution: GeoLibreMenuContribution;
  ownerPluginId?: string;
  ownerPluginName?: string;
}

/**
 * Reactive snapshot consumed by `useSyncExternalStore`. `entries` keeps a
 * stable identity between mutations so React can skip re-renders; `version` is
 * bumped on every change.
 */
export interface MenuContributionsSnapshot {
  entries: MenuContributionEntry[];
  version: number;
}

const TARGETS = new Set<string>(GEOLIBRE_MENU_CONTRIBUTION_TARGETS);

const registry = new Map<string, MenuContributionEntry>();
const listeners = new Set<() => void>();
const warnedTargets = new Set<string>();

let version = 0;
let snapshot: MenuContributionsSnapshot = { entries: [], version: 0 };

function emit(): void {
  version += 1;
  snapshot = { entries: [...registry.values()], version };
  for (const listener of listeners) {
    listener();
  }
}

/** Whether `menu` names a built-in menu that accepts plugin contributions. */
export function isMenuContributionTarget(menu: unknown): menu is GeoLibreMenuContributionTarget {
  return typeof menu === "string" && TARGETS.has(menu);
}

/**
 * Add a plugin's items to a built-in toolbar menu. Returns an unregister
 * function (call it from the plugin's `deactivate` hook). Re-registering the
 * same id replaces the contribution.
 *
 * An unknown `menu` is not an error: a plugin written against a newer host may
 * target a menu this host does not have, and failing its activation over that
 * would be worse than leaving the items out. It warns once and returns a no-op
 * disposer instead.
 *
 * `ownerPluginId`/`ownerPluginName` are injected by the host; plugins call this
 * with a single argument.
 */
export function registerMenuContribution(
  contribution: GeoLibreMenuContribution,
  ownerPluginId?: string,
  ownerPluginName?: string,
): () => void {
  if (!contribution || typeof contribution.id !== "string" || contribution.id.length === 0) {
    throw new Error("registerMenuContribution requires a contribution with a non-empty id.");
  }
  if (!Array.isArray(contribution.items)) {
    throw new Error(`Menu contribution "${contribution.id}" must have an items array.`);
  }
  if (!isMenuContributionTarget(contribution.menu)) {
    const key = `${contribution.id}:${String(contribution.menu)}`;
    if (!warnedTargets.has(key)) {
      warnedTargets.add(key);
      console.warn(
        `Menu contribution "${contribution.id}" targets unknown menu "${String(contribution.menu)}"; ` +
          `expected one of ${GEOLIBRE_MENU_CONTRIBUTION_TARGETS.join(", ")}. It is not shown.`,
      );
    }
    return () => {};
  }
  // As with toolbar menus, the disposer only removes the contribution while
  // this exact registration is current, so a stale disposer cannot evict a
  // newer contribution that reused the id.
  const entry: MenuContributionEntry = { contribution, ownerPluginId, ownerPluginName };
  registry.set(contribution.id, entry);
  emit();
  return () => {
    if (registry.get(contribution.id) === entry) unregisterMenuContribution(contribution.id);
  };
}

/** Remove a previously registered menu contribution. */
export function unregisterMenuContribution(id: string): void {
  if (!registry.delete(id)) return;
  emit();
}

/** All registered contributions, in registration order. */
export function listMenuContributions(): MenuContributionEntry[] {
  return [...registry.values()];
}

/** Current reactive snapshot for `useSyncExternalStore`. */
export function getMenuContributionsSnapshot(): MenuContributionsSnapshot {
  return snapshot;
}

/** Subscribe to menu-contribution registry changes. Returns an unsubscribe. */
export function subscribeMenuContributions(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Test-only: reset the registry to its initial empty state. Not part of the
 * public plugin API.
 */
export function __resetMenuContributionRegistryForTests(): void {
  registry.clear();
  listeners.clear();
  warnedTargets.clear();
  version = 0;
  snapshot = { entries: [], version: 0 };
}
