import { collapseRightPanel, openRightPanel, registerRightPanel } from "@geolibre/plugins";
import { useEffect } from "react";
import i18n from "../i18n";

/** Stable id of the Comments right panel. */
export const COMMENTS_PANEL_ID = "comments";

/**
 * Registers the Comments panel as a dockable right panel sharing the Style (right)
 * sidebar's rail (`replace-style`).
 *
 * Comments is enabled by default but collapsed onto the Style rail, so it is
 * discoverable without taking map space.
 */
export function useRegisterCommentsPanel(): void {
  useEffect(() => {
    // i18n.t (not the useTranslation hook) so registration carries no
    // render-time dependency; the rail entry re-resolves the getter on render.
    const dispose = registerRightPanel({
      id: COMMENTS_PANEL_ID,
      title: () => i18n.t("comments.title"),
      dock: "replace-style",
      render: () => {},
    });
    openRightPanel(COMMENTS_PANEL_ID);
    collapseRightPanel(COMMENTS_PANEL_ID);
    return dispose;
  }, []);
}
