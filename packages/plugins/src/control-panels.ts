import type {
  GeoLibreAppAPI,
  GeoLibreControlPanelId,
  GeoLibreMeasureOptions,
  GeoLibreMinimapOptions,
} from "./types";
import {
  closeBookmarkPanel,
  isBookmarkPanelVisible,
  openBookmarkPanel,
} from "./plugins/components/bookmark";
import {
  closeMeasurePanel,
  isMeasurePanelVisible,
  openMeasurePanel,
} from "./plugins/components/measure";
import {
  closeMinimapPanel,
  isMinimapPanelVisible,
  openMinimapPanel,
} from "./plugins/components/minimap";
import { closePrintPanel, isPrintPanelVisible, openPrintPanel } from "./plugins/components/print";
import {
  closeSearchPlacesPanel,
  isSearchPlacesPanelVisible,
  openSearchPlacesPanel,
} from "./plugins/components/search";

/** Shared by the plugin host and scripting API so they address the same controls. */
const PANEL_TOGGLES: Record<
  GeoLibreControlPanelId,
  {
    isVisible: () => boolean;
    open: (app: GeoLibreAppAPI) => void;
    close: (app: GeoLibreAppAPI) => void;
  }
> = {
  bookmark: {
    isVisible: isBookmarkPanelVisible,
    open: openBookmarkPanel,
    close: closeBookmarkPanel,
  },
  search: {
    isVisible: isSearchPlacesPanelVisible,
    open: openSearchPlacesPanel,
    close: closeSearchPlacesPanel,
  },
  measure: { isVisible: isMeasurePanelVisible, open: openMeasurePanel, close: closeMeasurePanel },
  minimap: { isVisible: isMinimapPanelVisible, open: openMinimapPanel, close: closeMinimapPanel },
  print: { isVisible: isPrintPanelVisible, open: openPrintPanel, close: closePrintPanel },
};

function panelToggle(id: GeoLibreControlPanelId) {
  if (!Object.hasOwn(PANEL_TOGGLES, id)) throw new Error(`Unknown control panel: ${id}`);
  return PANEL_TOGGLES[id];
}

/**
 * Open a built-in panel; supplied Minimap or Measure options also update an
 * already open control.
 */
export function openControlPanel(
  app: GeoLibreAppAPI,
  id: GeoLibreControlPanelId,
  options?: GeoLibreMinimapOptions | GeoLibreMeasureOptions,
): void {
  const panel = panelToggle(id);
  if (options !== undefined) {
    if (id === "minimap") openMinimapPanel(app, options as GeoLibreMinimapOptions);
    else if (id === "measure") openMeasurePanel(app, options as GeoLibreMeasureOptions);
    else throw new Error("Control panel options are only supported for minimap and measure");
  } else if (!panel.isVisible()) {
    panel.open(app);
  }
}

/** Close a built-in panel and cancel its pending initialization. */
export function closeControlPanel(app: GeoLibreAppAPI, id: GeoLibreControlPanelId): void {
  panelToggle(id).close(app);
}

/** Read the same visibility state the menus subscribe to. */
export function isControlPanelVisible(id: GeoLibreControlPanelId): boolean {
  return panelToggle(id).isVisible();
}
