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
export type RightPanelSide = "left" | "right";

export interface RightPanelSnapshot {
  /** Id of the active right-side workspace panel, or null when none is open. */
  activeId: string | null;
  /** Whether the active panel is collapsed to its rail. */
  collapsed: boolean;
  /**
   * Which side of the workspace the active panel docks on, or null when none is
   * open. Defaults to the panel's declared `side` ("right"), overridable at
   * runtime via {@link setActiveRightPanelSide} so a user can move it.
   */
  side: RightPanelSide | null;
  /** Monotonic counter bumped on every registry mutation. */
  version: number;
}

const registry = new Map<string, GeoLibreRightPanelRegistration>();
const listeners = new Set<() => void>();

let activeId: string | null = null;
let collapsed = false;
// User override of the active panel's docking side; reset when the active panel
// changes so each panel starts from its own declared `side`.
let sideOverride: RightPanelSide | null = null;
let version = 0;
let snapshot: RightPanelSnapshot = {
  activeId: null,
  collapsed: false,
  side: null,
  version: 0,
};

function currentSide(): RightPanelSide | null {
  if (activeId === null) return null;
  return sideOverride ?? registry.get(activeId)?.side ?? "right";
}

function emit(): void {
  version += 1;
  snapshot = { activeId, collapsed, side: currentSide(), version };
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
  if (typeof panel.title !== "string" || panel.title.length === 0) {
    throw new Error(`Right panel "${panel.id}" must have a non-empty title.`);
  }
  if (typeof panel.render !== "function") {
    throw new Error(
      `Right panel "${panel.id}" must provide a render(container) function.`,
    );
  }
  // Re-registering an id replaces it (a plugin may rebuild its panel). The
  // returned disposer only removes the panel while this exact registration is
  // still the current one, so a stale disposer cannot evict a newer panel that
  // reused the id.
  registry.set(panel.id, panel);
  emit();
  return () => {
    if (registry.get(panel.id) === panel) unregisterRightPanel(panel.id);
  };
}

/**
 * Remove a right panel. If it is the active workspace it is closed first (its
 * `onClose` hook runs) so the shell restores the Style panel.
 */
export function unregisterRightPanel(id: string): void {
  const panel = registry.get(id);
  if (!panel) return;
  // Reset active state inline (without closeRightPanel's own emit) so the whole
  // removal notifies subscribers exactly once.
  const wasActive = activeId === id;
  if (wasActive) {
    activeId = null;
    collapsed = false;
    sideOverride = null;
  }
  registry.delete(id);
  emit();
  if (wasActive) runHook(id, "onClose", panel.onClose);
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
  // A different panel taking the workspace displaces the current owner; release
  // it (onClose) so a plugin can free resources allocated for its panel.
  const displacedId = wasInactive ? activeId : null;
  // A new panel starts from its own declared side, not the previous user move.
  if (wasInactive) sideOverride = null;
  activeId = id;
  collapsed = false;
  emit();
  if (displacedId !== null) {
    runHook(displacedId, "onClose", registry.get(displacedId)?.onClose);
  }
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
  sideOverride = null;
  emit();
  runHook(id, "onClose", registry.get(id)?.onClose);
}

/**
 * Move the active panel to the given side of the workspace ("left" or "right"),
 * overriding the panel's declared `side` until it closes or another panel
 * opens. Lets a user dock the plugin panel left or right of the Style panel.
 * No-op when no panel is active.
 */
export function setActiveRightPanelSide(side: RightPanelSide): void {
  if (activeId === null || currentSide() === side) return;
  sideOverride = side;
  emit();
}

/** Which side the active panel docks on, or null when none is open. */
export function getActiveRightPanelSide(): RightPanelSide | null {
  return currentSide();
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
  sideOverride = null;
  version = 0;
  snapshot = { activeId: null, collapsed: false, side: null, version: 0 };
}
