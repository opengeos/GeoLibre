import {
  getRightPanelSnapshot,
  subscribeRightPanels,
  type RightPanelSnapshot,
} from "@geolibre/plugins";
import { useSyncExternalStore } from "react";

/**
 * Subscribe React to the plugin right-panel registry in `@geolibre/plugins`.
 *
 * Returns the current {@link RightPanelSnapshot} (active panel id, collapsed
 * state, and dock position). The snapshot object identity is stable between
 * mutations, so this is safe to use directly in `useSyncExternalStore` without
 * an extra selector.
 *
 * @returns The current right-panel registry snapshot.
 */
export function useRightPanelState(): RightPanelSnapshot {
  return useSyncExternalStore(
    subscribeRightPanels,
    getRightPanelSnapshot,
    getRightPanelSnapshot,
  );
}

/** Which built-in panel the active plugin panel sits next to and collapses. */
export type AutoCollapsedPanel = "layers" | "style" | null;

const selectAutoCollapsed = (): AutoCollapsedPanel => {
  const snapshot = getRightPanelSnapshot();
  // Only an expanded panel collapses its neighbor; a panel collapsed to its own
  // rail leaves room, so the built-in panel can restore.
  if (snapshot.dock === null || snapshot.collapsed) return null;
  return snapshot.dock === "left-of-layers" ||
    snapshot.dock === "right-of-layers"
    ? "layers"
    : "style";
};

/**
 * Subscribe to which built-in panel (Layers or Style) the active plugin panel
 * is docked next to and should auto-collapse, or null when none applies.
 *
 * Returns a primitive, so the shell re-renders only when that changes (the
 * panel opens, closes, moves across the map, or collapses/expands), which is
 * exactly when the built-in panel must collapse or restore.
 *
 * @returns "layers", "style", or null.
 */
export function useAutoCollapsedPanel(): AutoCollapsedPanel {
  return useSyncExternalStore(
    subscribeRightPanels,
    selectAutoCollapsed,
    selectAutoCollapsed,
  );
}
