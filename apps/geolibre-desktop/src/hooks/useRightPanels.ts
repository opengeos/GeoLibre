import {
  getRightPanelSnapshot,
  subscribeRightPanels,
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

const selectActive = () => getRightPanelSnapshot().activeId !== null;

/**
 * Subscribe only to whether a plugin right panel is the active workspace.
 *
 * Returns a boolean, so consumers (e.g. the shell) re-render only when a panel
 * opens or closes, not on every collapse/expand toggle of the active panel.
 *
 * @returns True when a plugin right panel is open.
 */
export function useRightPanelActive(): boolean {
  return useSyncExternalStore(subscribeRightPanels, selectActive, selectActive);
}
