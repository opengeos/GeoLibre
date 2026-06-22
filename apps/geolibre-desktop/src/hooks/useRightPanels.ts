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

const selectSide = () => getRightPanelSnapshot().side;

/**
 * Subscribe only to which side the active plugin right panel docks on.
 *
 * Returns "left", "right", or null (no panel open) — a primitive, so consumers
 * (e.g. the shell) re-render only when a panel opens, closes, or moves sides,
 * not on every collapse/expand toggle.
 *
 * @returns The active panel's side, or null when none is open.
 */
export function useActiveRightPanelSide(): RightPanelSide | null {
  return useSyncExternalStore(subscribeRightPanels, selectSide, selectSide);
}
