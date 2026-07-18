import type { GeoLibreFloatingPanelRegistration } from "./types";
import { PanelTitleResolver } from "./panel-title";

/**
 * Imperative registry for plugin-owned floating panels.
 *
 * A floating panel is a draggable, closeable card the host overlays on the
 * map's top-left corner. Unlike the right-sidebar panel (a single docked
 * workspace), several floating panels can be open at once and they do not
 * shrink the map. Mirrors the open/subscribe pattern used by the other
 * registries in this package; the desktop shell subscribes with
 * `useSyncExternalStore` and renders one card per open panel.
 */

/**
 * Reactive snapshot consumed by `useSyncExternalStore`. The `openIds` array
 * identity is stable between mutations (stacking order, front-most last);
 * `version` is bumped on every change.
 */
export interface FloatingPanelsSnapshot {
  openIds: string[];
  version: number;
}

const registry = new Map<string, GeoLibreFloatingPanelRegistration>();
// Title resolution (string/getter normalization, throw/empty fallback, and the
// per-id warning dedup the accessor relies on because it is called unmemoized
// in FloatingPanelCard's render body, which re-renders on every pointermove
// during a drag/resize) is shared with the right-panel registry via
// PanelTitleResolver. Each registry owns its own instance.
const titleResolver = new PanelTitleResolver<GeoLibreFloatingPanelRegistration>("Floating panel");
const listeners = new Set<() => void>();

let openIds: string[] = [];
let version = 0;
let snapshot: FloatingPanelsSnapshot = { openIds: [], version: 0 };

function emit(): void {
  version += 1;
  snapshot = { openIds: [...openIds], version };
  for (const listener of listeners) {
    listener();
  }
}

function runHook(id: string, hookName: "onOpen" | "onClose", hook: (() => void) | undefined): void {
  if (!hook) return;
  try {
    hook();
  } catch (error) {
    console.error(`Floating panel "${id}" ${hookName} handler threw.`, error);
  }
}

/**
 * Register a plugin-owned floating panel. The panel is not shown until
 * {@link openFloatingPanel} is called. Returns an unregister function (call it
 * from the plugin's `deactivate` hook); it closes the panel if open.
 */
export function registerFloatingPanel(panel: GeoLibreFloatingPanelRegistration): () => void {
  if (!panel || typeof panel.id !== "string" || panel.id.length === 0) {
    throw new Error("registerFloatingPanel requires a panel with a non-empty id.");
  }
  if (typeof panel.title !== "string" && typeof panel.title !== "function") {
    throw new Error(
      `Floating panel "${panel.id}" must have a non-empty title string or a title getter function.`,
    );
  }
  if (typeof panel.title === "string" && panel.title.length === 0) {
    throw new Error(`Floating panel "${panel.id}" must have a non-empty title.`);
  }
  if (typeof panel.render !== "function") {
    throw new Error(`Floating panel "${panel.id}" must provide a render(container) function.`);
  }
  // Normalize title to a resolver so both strings and getters update live.
  titleResolver.set(panel);
  registry.set(panel.id, panel);
  emit();
  return () => {
    if (registry.get(panel.id) === panel) unregisterFloatingPanel(panel.id);
  };
}

/** Remove a floating panel, closing it first (running `onClose`) if open. */
export function unregisterFloatingPanel(id: string): void {
  const panel = registry.get(id);
  if (!panel) return;
  // Reset open state inline (without closeFloatingPanel's own emit) so the whole
  // removal notifies subscribers exactly once.
  const wasOpen = openIds.includes(id);
  if (wasOpen) openIds = openIds.filter((openId) => openId !== id);
  registry.delete(id);
  titleResolver.delete(id);
  emit();
  if (wasOpen) runHook(id, "onClose", panel.onClose);
}

/**
 * Open a registered floating panel (or bring an already-open one to the front).
 * Returns false (and warns) when no panel with that id is registered.
 */
export function openFloatingPanel(id: string): boolean {
  const panel = registry.get(id);
  if (!panel) {
    console.warn(`openFloatingPanel: no floating panel registered with id "${id}".`);
    return false;
  }
  const wasOpen = openIds.includes(id);
  // Move to the end so the most recently opened/focused card stacks on top.
  openIds = [...openIds.filter((openId) => openId !== id), id];
  emit();
  if (!wasOpen) {
    runHook(id, "onOpen", panel.onOpen);
  }
  return true;
}

/** Bring an open floating panel to the front of the stack. No-op if not open. */
export function focusFloatingPanel(id: string): void {
  if (!openIds.includes(id)) return;
  if (openIds[openIds.length - 1] === id) return;
  openIds = [...openIds.filter((openId) => openId !== id), id];
  emit();
}

/** Close an open floating panel. No-op if it is not open. */
export function closeFloatingPanel(id: string): void {
  if (!openIds.includes(id)) return;
  openIds = openIds.filter((openId) => openId !== id);
  emit();
  runHook(id, "onClose", registry.get(id)?.onClose);
}

/** Whether the floating panel with the given id is currently open. */
export function isFloatingPanelOpen(id: string): boolean {
  return openIds.includes(id);
}

/** Ids of the currently open floating panels, in stacking order. */
export function getOpenFloatingPanels(): string[] {
  return [...openIds];
}

/**
 * Look up a registered floating panel by id. Title is always resolved to a
 * string by re-running the panel's title resolver on every call. The registry
 * does not itself subscribe to i18n language changes, so live title
 * translation relies on the consumer re-rendering and re-reading on
 * `languageChanged`; see the `title` field on
 * {@link GeoLibreFloatingPanelRegistration} for the full contract a host must
 * satisfy.
 */
export function getFloatingPanel(
  id: string,
): (GeoLibreFloatingPanelRegistration & { title: string }) | undefined {
  const panel = registry.get(id);
  if (!panel) return undefined;
  // Returns a shallow clone with the resolved title so the caller's original
  // registration object is never mutated (its title may be a getter function
  // that must survive re-registration for i18n reactivity). Consumers that
  // need stable object identity for effect dependencies should key on
  // panel.render rather than the panel object itself. Throw/empty fallback and
  // per-id warning dedup live in the shared resolver.
  return titleResolver.resolve(panel);
}

/** Current reactive snapshot for `useSyncExternalStore`. */
export function getFloatingPanelsSnapshot(): FloatingPanelsSnapshot {
  return snapshot;
}

/** Subscribe to floating-panel registry/state changes. Returns an unsubscribe. */
export function subscribeFloatingPanels(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Test-only: reset the registry to its initial empty state. Not part of the
 * public plugin API.
 */
export function __resetFloatingPanelRegistryForTests(): void {
  registry.clear();
  titleResolver.clear();
  listeners.clear();
  openIds = [];
  version = 0;
  snapshot = { openIds: [], version: 0 };
}
