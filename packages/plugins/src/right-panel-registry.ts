import type { GeoLibreRightPanelDock, GeoLibreRightPanelRegistration } from "./types";
import { PanelTitleResolver } from "./panel-title";

/**
 * Imperative registry for plugin-owned dockable side panels.
 *
 * Mirrors the open/subscribe panel pattern used elsewhere in this package
 * (see `maplibre-components.ts`): the registry is module-level state, plugins
 * mutate it through the host API (`registerRightPanel`, `openRightPanel`, ...),
 * and the desktop shell subscribes with `useSyncExternalStore` to mount the
 * active panel in one of three dock positions. Keeping the registry in
 * `@geolibre/plugins` (rather than the app) lets the host API delegate to it
 * without the app and the plugins package depending on each other.
 *
 * Only one plugin panel is active at a time. It docks at one of four positions
 * and the user can step it between them. The built-in panel on the side the
 * panel is docked (Layers on the left, Style on the right) collapses to its
 * rail while the panel is expanded there; the shell handles that. Two further
 * docks, `replace-style` and `replace-layers`, are non-positional shared-rail
 * modes in which the panel shares the Style (right) or Layers (left) sidebar's
 * single rail rather than sitting beside it; they are not part of the steppable
 * position order.
 */

/**
 * Where a plugin panel docks. Re-exported from the public {@link
 * GeoLibreRightPanelDock} so the two never diverge.
 */
export type RightPanelDock = GeoLibreRightPanelDock;

/**
 * Steppable dock positions in left-to-right order, used to move the panel
 * between positions. Frozen so a consumer cannot mutate the validation/order
 * list. The non-positional `replace-style` mode is intentionally excluded: it
 * shares the Style rail and is not part of the move sequence.
 */
export const RIGHT_PANEL_DOCKS: readonly RightPanelDock[] = Object.freeze([
  "left-of-layers",
  "right-of-layers",
  "left-of-style",
  "right-of-style",
] as const);

/**
 * Every accepted dock value, including the non-positional `replace-style` and
 * `replace-layers` shared-rail modes. Used to validate a panel's declared dock;
 * the shared-rail modes are valid to register with and settable at runtime but
 * are not steppable (they are absent from {@link RIGHT_PANEL_DOCKS}).
 */
const ALL_DOCKS: readonly RightPanelDock[] = Object.freeze([
  ...RIGHT_PANEL_DOCKS,
  "replace-style",
  "replace-layers",
] as const);

const DEFAULT_DOCK: RightPanelDock = "right-of-style";

function normalizeDock(dock: unknown): RightPanelDock {
  return ALL_DOCKS.includes(dock as RightPanelDock) ? (dock as RightPanelDock) : DEFAULT_DOCK;
}

/**
 * Reactive snapshot consumed by `useSyncExternalStore`. The object identity is
 * stable between mutations so React can skip re-renders; `version` is bumped on
 * every change (including registration list changes) so subscribers re-read.
 */
export interface RightPanelSnapshot {
  /** Id of the active panel, or null when none is open. */
  activeId: string | null;
  /** Whether the active panel is collapsed to its rail. */
  collapsed: boolean;
  /**
   * Where the active panel docks, or null when none is open. Defaults to the
   * panel's declared `dock` ("far-right"); the user steps it with the panel's
   * move buttons (or a plugin via {@link setActiveRightPanelDock}).
   */
  dock: RightPanelDock | null;
  /** Monotonic counter bumped on every registry mutation. */
  version: number;
}

const registry = new Map<string, GeoLibreRightPanelRegistration>();
// Title resolution (string/getter normalization, throw/empty fallback, and the
// per-id warning dedup the accessors rely on because they are called unmemoized
// on every render) is shared with the floating-panel registry via
// PanelTitleResolver. Each registry owns its own instance.
const titleResolver = new PanelTitleResolver<GeoLibreRightPanelRegistration>("Right panel");
const listeners = new Set<() => void>();

let activeId: string | null = null;
let collapsed = false;
// Where the active panel currently docks; reset when the active panel changes
// so each panel starts from its own declared `dock`.
let activeDock: RightPanelDock | null = null;
let version = 0;
let snapshot: RightPanelSnapshot = {
  activeId: null,
  collapsed: false,
  dock: null,
  version: 0,
};

function emit(): void {
  version += 1;
  snapshot = { activeId, collapsed, dock: activeDock, version };
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
 * Register a plugin-owned dockable side panel. The panel is not shown until
 * `openRightPanel(panel.id)` is called. Returns an unregister function that
 * closes the panel (if active) and removes it from the registry; a plugin
 * should call it from its `deactivate` hook.
 */
export function registerRightPanel(panel: GeoLibreRightPanelRegistration): () => void {
  if (!panel || typeof panel.id !== "string" || panel.id.length === 0) {
    throw new Error("registerRightPanel requires a panel with a non-empty id.");
  }
  if (typeof panel.title !== "string" && typeof panel.title !== "function") {
    throw new Error(
      `Right panel "${panel.id}" must have a non-empty title string or a title getter function.`,
    );
  }
  if (typeof panel.title === "string" && panel.title.length === 0) {
    throw new Error(`Right panel "${panel.id}" must have a non-empty title.`);
  }
  if (typeof panel.render !== "function") {
    throw new Error(`Right panel "${panel.id}" must provide a render(container) function.`);
  }
  // Normalize title to a resolver so both strings and getters update live.
  titleResolver.set(panel);
  // Re-registering an id replaces it (a plugin may rebuild its panel). The
  // returned disposer only removes the panel while this exact registration is
  // still the current one, so a stale disposer cannot evict a newer panel that
  // reused the id.
  registry.set(panel.id, panel);
  emit();
  return () => {
    if (registry.get(panel.id) === panel) {
      unregisterRightPanel(panel.id);
    }
  };
}

/**
 * Remove a right panel. If it is the active one it is closed first (its
 * `onClose` hook runs).
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
    activeDock = null;
  }
  registry.delete(id);
  titleResolver.delete(id);
  emit();
  if (wasActive) runHook(id, "onClose", panel.onClose);
}

/**
 * Make `id` the active panel and expand it. Returns false (and warns) if no
 * panel with that id is registered. Re-opening an already-open panel just
 * expands it from its rail (keeping its current dock).
 */
export function openRightPanel(id: string): boolean {
  const panel = registry.get(id);
  if (!panel) {
    console.warn(`openRightPanel: no right panel registered with id "${id}".`);
    return false;
  }
  if (activeId === id && !collapsed) return true;
  const wasInactive = activeId !== id;
  // A different panel taking over displaces the current owner; release it
  // (onClose) so a plugin can free resources allocated for its panel.
  const displacedId = wasInactive ? activeId : null;
  // Release the displaced panel first, while it is still the active owner, so
  // its onClose hook doesn't observe the incoming panel as active.
  if (displacedId !== null) {
    runHook(displacedId, "onClose", registry.get(displacedId)?.onClose);
  }
  // A new panel starts from its own declared dock, not the previous user move.
  if (wasInactive) activeDock = normalizeDock(panel.dock);
  activeId = id;
  collapsed = false;
  emit();
  if (wasInactive) {
    runHook(id, "onOpen", panel.onOpen);
  }
  return true;
}

/**
 * Collapse the active panel to its rail without closing it. The panel keeps the
 * dock (it stays the active panel); the rail is just a narrow strip. No-op
 * unless `id` is the active panel and currently expanded.
 */
export function collapseRightPanel(id: string): void {
  if (activeId !== id || collapsed) return;
  collapsed = true;
  emit();
  runHook(id, "onCollapse", registry.get(id)?.onCollapse);
}

/**
 * Close the active panel. No-op unless `id` is active.
 */
export function closeRightPanel(id: string): void {
  if (activeId !== id) return;
  activeId = null;
  collapsed = false;
  activeDock = null;
  emit();
  runHook(id, "onClose", registry.get(id)?.onClose);
}

/**
 * Dock the active panel at a specific dock. Accepts any valid dock, including
 * the non-positional `replace-style` shared-rail mode, so a panel can switch
 * between a movable positional panel and the shared Style rail at runtime (the
 * host's merge/detach buttons use this). No-op when no panel is active, the dock
 * is unknown, or the panel is already there.
 */
export function setActiveRightPanelDock(dock: RightPanelDock): void {
  if (activeId === null || !ALL_DOCKS.includes(dock) || activeDock === dock) {
    return;
  }
  activeDock = dock;
  emit();
}

/**
 * Step the active panel one dock position toward `direction` (left or right),
 * stopping at the ends. No-op when no panel is active.
 */
export function moveActiveRightPanelDock(direction: "left" | "right"): void {
  if (activeId === null || activeDock === null) return;
  const index = RIGHT_PANEL_DOCKS.indexOf(activeDock);
  // The non-positional `replace-style` mode is not in the step order, so it
  // cannot be moved between positions.
  if (index === -1) return;
  const nextIndex = direction === "left" ? index - 1 : index + 1;
  if (nextIndex < 0 || nextIndex >= RIGHT_PANEL_DOCKS.length) return;
  activeDock = RIGHT_PANEL_DOCKS[nextIndex];
  emit();
}

/** Where the active panel docks, or null when none is open. */
export function getActiveRightPanelDock(): RightPanelDock | null {
  return activeDock;
}

/** Id of the active panel, or null when none is open. */
export function getActiveRightPanel(): string | null {
  return activeId;
}

/** Whether the active right panel is collapsed to its rail. */
export function isRightPanelCollapsed(): boolean {
  return collapsed;
}

/**
 * Look up a registered right panel by id. Title is always resolved to a string
 * by re-running the panel's title resolver on every call. The registry does
 * not itself subscribe to i18n language changes, so live title translation
 * relies on the consumer re-rendering and re-reading on `languageChanged`;
 * see the `title` field on {@link GeoLibreRightPanelRegistration} for the full
 * contract a host must satisfy.
 */
export function getRightPanel(
  id: string,
): (GeoLibreRightPanelRegistration & { title: string }) | undefined {
  const panel = registry.get(id);
  if (!panel) return undefined;
  return titleResolver.resolve(panel);
}

/**
 * All registered right panels, in registration order. Each entry is a shallow
 * clone with its title resolved to a string, mirroring {@link getRightPanel}
 * so consumers can read `.title` directly without unwrapping a getter.
 */
export function listRightPanels(): (GeoLibreRightPanelRegistration & { title: string })[] {
  return [...registry.values()].map((panel) => titleResolver.resolve(panel));
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
  titleResolver.clear();
  listeners.clear();
  activeId = null;
  collapsed = false;
  activeDock = null;
  version = 0;
  snapshot = { activeId: null, collapsed: false, dock: null, version: 0 };
}
