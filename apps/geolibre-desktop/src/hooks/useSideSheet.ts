import { useEffect, useSyncExternalStore } from "react";
import {
  getSideSheetState,
  setSideSheetExpanded,
  shouldYieldSideSheet,
  subscribeSideSheets,
  type SideSheetId,
} from "../lib/side-sheets";
import { useIsMobileViewport } from "./useIsMobileViewport";

/**
 * Keep the Layers and Style sheets from stacking over the map on a narrow
 * viewport: report this panel's expanded state, and fold it back to its rail
 * when the other panel is opened after it (see `lib/side-sheets`).
 *
 * @param id - Which panel this is.
 * @param isCollapsed - The panel's current collapse state.
 * @param setIsCollapsed - The panel's collapse setter (routed to its owner in
 *   the shared-rail mode).
 */
export function useSideSheet(
  id: SideSheetId,
  isCollapsed: boolean,
  setIsCollapsed: (collapsed: boolean) => void,
): void {
  const narrow = useIsMobileViewport();
  const state = useSyncExternalStore(subscribeSideSheets, getSideSheetState, getSideSheetState);

  useEffect(() => {
    setSideSheetExpanded(id, !isCollapsed);
  }, [id, isCollapsed]);
  useEffect(() => () => setSideSheetExpanded(id, false), [id]);

  const shouldYield = shouldYieldSideSheet(state, id, narrow);
  useEffect(() => {
    if (shouldYield) setIsCollapsed(true);
  }, [shouldYield, setIsCollapsed]);
}
