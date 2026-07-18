import { collapseRightPanel, openRightPanel, registerRightPanel } from "@geolibre/plugins";
import { useEffect } from "react";
import i18n from "../i18n";

/** Stable id of the Browser (Data Source Manager) right panel. */
export const BROWSER_PANEL_ID = "browser";

/**
 * Registers the Browser panel as a first-class dockable right panel, so it gets
 * the same movable/dockable chrome as plugin panels: the shell renders its
 * header, the move-left/right, merge/detach, collapse, and close controls, and
 * the left/right dock rail. It defaults to the shared **Layers** rail
 * (`replace-layers`); the user detaches and moves it from the header controls.
 * Open it with `openRightPanel(BROWSER_PANEL_ID)`.
 *
 * The panel body is a React component that needs the app's context (i18n, store,
 * the map controller ref), so it is not rendered through the imperative
 * `render(container)`. Instead DesktopShell portals `<BrowserPanel>` into a
 * dedicated content host (separate from the shared plugin host, so the plugin
 * host's imperative `replaceChildren` never wipes the portal's DOM) that the
 * dock slots adopt while this panel is active. `render` therefore only leaves
 * the host empty for that portal. Registered once for the shell's life.
 *
 * The panel is **on by default but collapsed** onto the shared Layers rail: on
 * mount it is opened and immediately collapsed, so it shows as a rail entry
 * beside Layers rather than covering the map. The user expands it from that
 * rail (or toggles it off in Settings → Layout). It reopens collapsed on the
 * next load, matching the "on by default" behavior of the Layout toggle.
 */
export function useRegisterBrowserPanel(): void {
  useEffect(() => {
    // i18n.t (not the useTranslation hook) so registration carries no
    // render-time dependency; the body still localizes live via useTranslation.
    const dispose = registerRightPanel({
      id: BROWSER_PANEL_ID,
      title: () => i18n.t("browser.title"),
      dock: "replace-layers",
      render: () => {},
    });
    // Default on, but docked collapsed to the Layers rail (open then collapse),
    // so it is present without burying the map on first load.
    openRightPanel(BROWSER_PANEL_ID);
    collapseRightPanel(BROWSER_PANEL_ID);
    return dispose;
  }, []);
}
