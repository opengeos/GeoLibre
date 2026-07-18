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
  return useSyncExternalStore(subscribeRightPanels, getRightPanelSnapshot, getRightPanelSnapshot);
}

/** Which built-in panel the active plugin panel sits next to and collapses. */
export type AutoCollapsedPanel = "layers" | "style" | null;

const selectAutoCollapsed = (): AutoCollapsedPanel => {
  const snapshot = getRightPanelSnapshot();
  // Only an expanded panel collapses its neighbor; a panel collapsed to its own
  // rail leaves room, so the built-in panel can restore.
  if (snapshot.dock === null || snapshot.collapsed) return null;
  // The shared-rail modes (`replace-style`/`replace-layers`) do not push a
  // neighbor aside: they share the Style/Layers sidebar surface, and
  // SharedSidebar coordinates that panel's collapse itself.
  if (snapshot.dock === "replace-style" || snapshot.dock === "replace-layers") {
    return null;
  }
  return snapshot.dock === "left-of-layers" || snapshot.dock === "right-of-layers"
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
  return useSyncExternalStore(subscribeRightPanels, selectAutoCollapsed, selectAutoCollapsed);
}

const selectReplaceStylePanelId = (): string | null => {
  const snapshot = getRightPanelSnapshot();
  return snapshot.dock === "replace-style" ? snapshot.activeId : null;
};

/**
 * Subscribe to the id of the active plugin panel docked in the shared Style rail
 * (`replace-style`) mode, or null when no such panel is active.
 *
 * When non-null, the shell renders the {@link SharedSidebar} in place of the
 * Style-slot panels so the plugin shares the Style rail instead of docking
 * beside it.
 *
 * @returns The active replace-style panel id, or null.
 */
export function useReplaceStylePanelId(): string | null {
  return useSyncExternalStore(
    subscribeRightPanels,
    selectReplaceStylePanelId,
    selectReplaceStylePanelId,
  );
}

const selectReplaceLayersPanelId = (): string | null => {
  const snapshot = getRightPanelSnapshot();
  return snapshot.dock === "replace-layers" ? snapshot.activeId : null;
};

/**
 * Subscribe to the id of the active plugin panel docked in the shared Layers rail
 * (`replace-layers`) mode, or null when no such panel is active.
 *
 * When non-null, the shell renders the {@link SharedSidebar} in place of the
 * Layers-slot panels so the plugin shares the Layers rail instead of docking
 * beside it.
 *
 * @returns The active replace-layers panel id, or null.
 */
export function useReplaceLayersPanelId(): string | null {
  return useSyncExternalStore(
    subscribeRightPanels,
    selectReplaceLayersPanelId,
    selectReplaceLayersPanelId,
  );
}
