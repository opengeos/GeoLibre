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
