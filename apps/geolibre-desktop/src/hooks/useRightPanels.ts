import {
  getRightPanelSnapshot,
  subscribeRightPanels,
  type RightPanelSide,
  type RightPanelSnapshot,
} from "@geolibre/plugins";
import { useSyncExternalStore } from "react";

/**
 * Subscribe React to the plugin right-panel registry in `@geolibre/plugins`.
 *
 * Returns the current {@link RightPanelSnapshot} (active panel id + collapsed
 * state). The snapshot object identity is stable between mutations, so this is
 * safe to use directly in `useSyncExternalStore` without an extra selector.
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

/** Which workspace edge holds an *expanded* plugin panel, or null. */
export type DockedPanelEdge = RightPanelSide | null;

const selectExpandedEdge = (): DockedPanelEdge => {
  const snapshot = getRightPanelSnapshot();
  // Only an expanded panel claims the edge; a panel collapsed to its rail
  // leaves room, so the built-in Style/Layers panel can restore.
  return snapshot.side !== null && !snapshot.collapsed ? snapshot.side : null;
};

/**
 * Subscribe to which workspace edge currently holds an *expanded* plugin panel.
 *
 * Returns "left", "right", or null — a primitive, so the shell re-renders only
 * when that changes (a panel opens, closes, moves sides, or collapses/expands),
 * which is exactly when the built-in Style/Layers panel must collapse or
 * restore.
 *
 * @returns The edge with an expanded plugin panel, or null.
 */
export function useExpandedPanelEdge(): DockedPanelEdge {
  return useSyncExternalStore(
    subscribeRightPanels,
    selectExpandedEdge,
    selectExpandedEdge,
  );
}
