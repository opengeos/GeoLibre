import { useEffect } from "react";
import i18n from "../i18n";
import { registerPersistedRightPanel } from "../lib/persisted-right-panel";

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
 * rail (or toggles it off in Settings → Layout). "By default" means the default
 * of the persisted `layout.browserPanelVisible` setting, which
 * {@link registerPersistedRightPanel} seeds from and then keeps in step with the
 * panel: turning it off stays off across restarts instead of the toggle silently
 * resetting on every launch (#1935).
 */
export function useRegisterBrowserPanel(): void {
  useEffect(
    () =>
      registerPersistedRightPanel(
        {
          id: BROWSER_PANEL_ID,
          // i18n.t (not the useTranslation hook) so registration carries no
          // render-time dependency; the body localizes live via useTranslation.
          title: () => i18n.t("browser.title"),
          dock: "replace-layers",
          render: () => {},
        },
        "browserPanelVisible",
      ),
    [],
  );
}
