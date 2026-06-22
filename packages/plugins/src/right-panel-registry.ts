import type { GeoLibreRightPanelRegistration } from "./types";

/**
 * Imperative registry for plugin-owned right-sidebar panels.
 *
 * Mirrors the open/subscribe panel pattern used elsewhere in this package
 * (see `maplibre-components.ts`): the registry is module-level state, plugins
 * mutate it through the host API (`registerRightPanel`, `openRightPanel`, ...),
 * and the desktop shell subscribes with `useSyncExternalStore` to mount the
 * active panel beside the built-in Style panel. Keeping the registry in
 * `@geolibre/plugins` (rather than the app) lets the host API delegate to it
 * without the app and the plugins package depending on each other.
 *
 * Only one plugin right panel is the "active right-side workspace" at a time.
 * While one is active the shell collapses the Style panel to its rail and
 * restores it when the plugin panel closes.
 */

/**
 * Reactive snapshot consumed by `useSyncExternalStore`. The object identity is
 * stable between mutations so React can skip re-renders; `version` is bumped on
 * every change (including registration list changes) so subscribers re-read.
 */
export interface RightPanelSnapshot {
  /** Id of the active right-side workspace panel, or null when none is open. */
  activeId: string | null;
  /** Whether the active panel is collapsed to its rail. */
  collapsed: boolean;
  /** Monotonic counter bumped on every registry mutation. */
  version: number;
}

const registry = new Map<string, GeoLibreRightPanelRegistration>();
const listeners = new Set<() => void>();

let activeId: string | null = null;
let collapsed = false;
let version = 0;
let snapshot: RightPanelSnapshot = {
  activeId: null,
  collapsed: false,
  version: 0,
};

function emit(): void {
  version += 1;
  snapshot = { activeId, collapsed, version };
  for (const listener of listeners) {
    listener();
  }
}

function runHook(
  id: string,
  hookName: "onOpen" | "onCollapse" | "onClose",
  hook: (() => void) | undefined,
): void {
  if (!hook) return;
  try {
    hook();
  } catch (error) {
    console.error(`Right panel "${id}" ${hookName} handler threw.`, error);
  }
}

/**
 * Register a plugin-owned right-sidebar panel. The panel is not shown until
 * `openRightPanel(panel.id)` is called. Returns an unregister function that
 * closes the panel (if active) and removes it from the registry; a plugin
 * should call it from its `deactivate` hook.
 */
export function registerRightPanel(
  panel: GeoLibreRightPanelRegistration,
): () => void {
  if (!panel || typeof panel.id !== "string" || panel.id.length === 0) {
    throw new Error("registerRightPanel requires a panel with a non-empty id.");
  }
  if (typeof panel.render !== "function") {
    throw new Error(
      `Right panel "${panel.id}" must provide a render(container) function.`,
    );
  }
  registry.set(panel.id, panel);
  emit();
  return () => unregisterRightPanel(panel.id);
}

/**
 * Remove a right panel. If it is the active workspace it is closed first (its
 * `onClose` hook runs) so the shell restores the Style panel.
 */
export function unregisterRightPanel(id: string): void {
  if (!registry.has(id)) return;
  if (activeId === id) {
    closeRightPanel(id);
  }
  registry.delete(id);
  emit();
}

/**
 * Make `id` the active right-side workspace and expand it. Collapses the Style
 * panel via the shell. Returns false (and warns) if no panel with that id is
 * registered. Re-opening an already-open panel just expands it from its rail.
 */
export function openRightPanel(id: string): boolean {
  const panel = registry.get(id);
  if (!panel) {
    console.warn(`openRightPanel: no right panel registered with id "${id}".`);
    return false;
  }
  if (activeId === id && !collapsed) return true;
  const wasInactive = activeId !== id;
  activeId = id;
  collapsed = false;
  emit();
  if (wasInactive) {
    runHook(id, "onOpen", panel.onOpen);
  }
  return true;
}

/**
 * Collapse the active panel to its rail without closing it. The panel keeps
 * ownership of the right-side workspace (the Style panel stays collapsed).
 * No-op unless `id` is the active panel and currently expanded.
 */
export function collapseRightPanel(id: string): void {
  if (activeId !== id || collapsed) return;
  collapsed = true;
  emit();
  runHook(id, "onCollapse", registry.get(id)?.onCollapse);
}

/**
 * Close the active panel and release the right-side workspace so the shell
 * restores the Style panel to its previous state. No-op unless `id` is active.
 */
export function closeRightPanel(id: string): void {
  if (activeId !== id) return;
  activeId = null;
  collapsed = false;
  emit();
  runHook(id, "onClose", registry.get(id)?.onClose);
}

/** Id of the active right-side workspace panel, or null when none is open. */
export function getActiveRightPanel(): string | null {
  return activeId;
}

/** Whether the active right panel is collapsed to its rail. */
export function isRightPanelCollapsed(): boolean {
  return collapsed;
}

/** Look up a registered right panel by id. */
export function getRightPanel(
  id: string,
): GeoLibreRightPanelRegistration | undefined {
  return registry.get(id);
}

/** All registered right panels, in registration order. */
export function listRightPanels(): GeoLibreRightPanelRegistration[] {
  return [...registry.values()];
}

/** Current reactive snapshot for `useSyncExternalStore`. */
export function getRightPanelSnapshot(): RightPanelSnapshot {
  return snapshot;
}

/** Subscribe to right-panel registry/state changes. Returns an unsubscribe. */
export function subscribeRightPanels(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Test-only: reset the registry to its initial empty state. Not part of the
 * public plugin API.
 */
export function __resetRightPanelRegistryForTests(): void {
  registry.clear();
  listeners.clear();
  activeId = null;
  collapsed = false;
  version = 0;
  snapshot = { activeId: null, collapsed: false, version: 0 };
}
