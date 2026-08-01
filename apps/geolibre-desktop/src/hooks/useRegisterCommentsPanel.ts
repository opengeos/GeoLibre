import { collapseRightPanel, openRightPanel, registerRightPanel } from "@geolibre/plugins";
import { useEffect } from "react";

/** Stable id of the Comments right panel. */
export const COMMENTS_PANEL_ID = "comments";

/**
 * Registers the Comments panel as a dockable right panel sharing the Style (right)
 * sidebar's rail (`replace-style`).
 *
 * Opens and collapses on mount so it is active and present as a rail entry on the
 * right sidebar by default.
 */
export function useRegisterCommentsPanel(): void {
  useEffect(() => {
    const dispose = registerRightPanel({
      id: COMMENTS_PANEL_ID,
      title: "Comments",
      dock: "replace-style",
      render: () => {},
    });
    openRightPanel(COMMENTS_PANEL_ID);
    collapseRightPanel(COMMENTS_PANEL_ID);
    return dispose;
  }, []);
}
