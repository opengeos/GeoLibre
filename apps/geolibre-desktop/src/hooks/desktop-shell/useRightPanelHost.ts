import { getRightPanel } from "@geolibre/plugins";
import { useEffect, useState } from "react";
import {
  PLUGIN_PANEL_DEFAULT_WIDTH,
  clampPluginPanelWidth,
} from "../../components/panels/PluginRightPanel";
import { BROWSER_PANEL_ID } from "../useRegisterBrowserPanel";
import { COMMENTS_PANEL_ID } from "../useRegisterCommentsPanel";
import type { LayoutOptions } from "../useLayoutOptions";
import { useRightPanelState } from "../useRightPanels";

/**
 * Hosts the active right-dock panel's content and its shared width.
 *
 * @param layoutOptions - The shell's layout options (`viewer` empties the host).
 * @returns The active panel id, the dock content hosts, and the panel width.
 */
export function useRightPanelHost(layoutOptions: LayoutOptions) {
  const [pluginPanelWidth, setPluginPanelWidth] = useState(PLUGIN_PANEL_DEFAULT_WIDTH);
  // The active plugin panel's content lives in this one host element (created
  // once per app instance). The active dock slot adopts it via appendChild, so
  // moving the panel between docks relocates the same DOM and preserves the
  // plugin's state. `contents` keeps it transparent to layout.
  const [pluginContentEl] = useState(() => {
    const el = document.createElement("div");
    el.className = "contents";
    return el;
  });
  // A second, dedicated host for the Browser panel's React portal (below). Kept
  // separate from pluginContentEl so the imperative plugin-render effect's
  // `replaceChildren` can never wipe the portal-managed DOM, and vice versa.
  const [browserContentEl] = useState(() => {
    const el = document.createElement("div");
    el.className = "contents";
    return el;
  });
  // A third, dedicated host for the Comments panel's React portal.
  const [commentsContentEl] = useState(() => {
    const el = document.createElement("div");
    el.className = "contents";
    return el;
  });
  const rightPanelState = useRightPanelState();
  const activePanelId = rightPanelState.activeId;
  const replaceStylePanelIds = rightPanelState.visibleIds.filter(
    (id) => rightPanelState.panelDocks[id] === "replace-style",
  );
  const replaceLayersPanelIds = rightPanelState.visibleIds.filter(
    (id) => rightPanelState.panelDocks[id] === "replace-layers",
  );
  const activePanel = activePanelId ? getRightPanel(activePanelId) : undefined;
  // The dock slots adopt whichever host owns the active panel's content: the
  // Browser's dedicated portal host, the Comments dedicated portal host, or the shared imperative plugin host.
  const dockContentEl =
    activePanelId === BROWSER_PANEL_ID
      ? browserContentEl
      : activePanelId === COMMENTS_PANEL_ID
        ? commentsContentEl
        : pluginContentEl;
  // Render the active panel into the shared host once; re-run when its
  // registration is replaced (re-registration refresh) but not on dock/collapse
  // changes. Keyed on the render function identity so that a plugin
  // re-registering the same id with a new render function tears down the old
  // render and calls the new one, but title resolution (which returns a new
  // object each call) does not cause spurious re-runs.
  useEffect(() => {
    const host = pluginContentEl;
    if (layoutOptions.viewer) {
      host.replaceChildren();
      return;
    }
    if (!activePanelId || !activePanel) return;
    let cleanup: void | (() => void);
    try {
      cleanup = activePanel.render(host);
    } catch (error) {
      console.error(`Right panel "${activePanelId}" render() threw.`, error);
    }
    return () => {
      try {
        cleanup?.();
      } catch (error) {
        console.error(`Right panel "${activePanelId}" cleanup threw.`, error);
      }
      host.replaceChildren();
    };
    // `activePanel` is intentionally narrowed to `activePanel?.render`:
    // getRightPanel returns a fresh clone each call, so the whole object would
    // re-run this effect on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePanelId, activePanel?.render, layoutOptions.viewer, pluginContentEl]);
  // Reset the shared width to the panel's default when a new panel activates
  // (keyed on activePanelId only, so a user resize survives re-registration).
  useEffect(() => {
    const panel = activePanelId ? getRightPanel(activePanelId) : undefined;
    if (!panel) return;
    setPluginPanelWidth(clampPluginPanelWidth(panel.defaultWidth ?? PLUGIN_PANEL_DEFAULT_WIDTH));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePanelId]);
  return {
    activePanelId,
    browserContentEl,
    commentsContentEl,
    dockContentEl,
    pluginPanelWidth,
    replaceLayersPanelIds,
    replaceStylePanelIds,
    setPluginPanelWidth,
  };
}
