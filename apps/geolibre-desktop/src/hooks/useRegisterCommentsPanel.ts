import { useEffect } from "react";
import i18n from "../i18n";
import { registerPersistedRightPanel } from "../lib/persisted-right-panel";

/** Stable id of the Comments right panel. */
export const COMMENTS_PANEL_ID = "comments";

/**
 * Registers the Comments panel as a dockable right panel sharing the Style (right)
 * sidebar's rail (`replace-style`).
 *
 * Comments is enabled by default but collapsed onto the Style rail, so it is
 * discoverable without taking map space. "By default" means the default of the
 * persisted `layout.commentsPanelVisible` setting, which
 * {@link registerPersistedRightPanel} seeds from and then keeps in step with the
 * panel: turning it off stays off across restarts instead of the toggle silently
 * resetting on every launch (#1935).
 */
export function useRegisterCommentsPanel(): void {
  useEffect(
    () =>
      registerPersistedRightPanel(
        {
          id: COMMENTS_PANEL_ID,
          // i18n.t (not the useTranslation hook) so registration carries no
          // render-time dependency; the rail entry re-resolves it on render.
          title: () => i18n.t("comments.title"),
          dock: "replace-style",
          render: () => {},
        },
        "commentsPanelVisible",
      ),
    [],
  );
}
