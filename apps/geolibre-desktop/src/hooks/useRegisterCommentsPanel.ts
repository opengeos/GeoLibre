import { collapseRightPanel, openRightPanel, registerRightPanel } from "@geolibre/plugins";
import { useEffect } from "react";
import i18n from "../i18n";
import { useDesktopSettingsStore } from "./useDesktopSettings";

/** Stable id of the Comments right panel. */
export const COMMENTS_PANEL_ID = "comments";

/**
 * Registers the Comments panel as a dockable right panel sharing the Style (right)
 * sidebar's rail (`replace-style`).
 *
 * Comments is enabled by default but collapsed onto the Style rail, so it is
 * discoverable without taking map space. "By default" means the default of the
 * persisted `layout.commentsPanelVisible` setting: a user who turned the panel
 * off in Settings → Layout gets it back off on the next launch instead of having
 * the toggle silently reset (#1935).
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
    // Read the setting here rather than subscribing: this seeds the panel's
    // startup state only. Once mounted the Settings toggle drives the registry
    // directly, so the user can also close the panel from its own header
    // without that being written back as a preference.
    if (useDesktopSettingsStore.getState().desktopSettings.layout.commentsPanelVisible) {
      openRightPanel(COMMENTS_PANEL_ID);
      collapseRightPanel(COMMENTS_PANEL_ID);
    }
    return dispose;
  }, []);
}
