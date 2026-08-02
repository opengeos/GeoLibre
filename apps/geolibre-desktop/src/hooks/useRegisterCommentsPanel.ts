import { registerRightPanel } from "@geolibre/plugins";
import { useEffect } from "react";

/** Stable id of the Comments right panel. */
export const COMMENTS_PANEL_ID = "comments";

/**
 * Registers the Comments panel as a dockable right panel sharing the Style (right)
 * sidebar's rail (`replace-style`).
 *
 * Unlike the Browser panel, Comments is opt-in: opening it on mount would
 * displace Browser because dockable panels share one active registry slot.
 */
export function useRegisterCommentsPanel(): void {
  useEffect(() => {
    const dispose = registerRightPanel({
      id: COMMENTS_PANEL_ID,
      title: "Comments",
      dock: "replace-style",
      render: () => {},
    });
    return dispose;
  }, []);
}
