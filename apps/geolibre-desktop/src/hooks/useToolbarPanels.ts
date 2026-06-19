import {
  closeBookmarkPanel,
  closeColorbarPanel,
  closeHtmlPanel,
  closeLegendPanel,
  closeMeasurePanel,
  closeMinimapPanel,
  closePrintPanel,
  closeSearchPlacesPanel,
  closeSpinGlobePanel,
  closeViewStatePanel,
  isBookmarkPanelVisible,
  isColorbarPanelVisible,
  isEarthEnginePanelVisible,
  isHtmlPanelVisible,
  isLegendPanelVisible,
  isMeasurePanelVisible,
  isMinimapPanelVisible,
  isPrintPanelVisible,
  isSearchPlacesPanelVisible,
  isSpinGlobePanelVisible,
  isViewStatePanelVisible,
  openBookmarkPanel,
  openColorbarPanel,
  openHtmlPanel,
  openLegendPanel,
  openMeasurePanel,
  openMinimapPanel,
  openPrintPanel,
  openSearchPlacesPanel,
  openSpinGlobePanel,
  openViewStatePanel,
  subscribeBookmarkPanel,
  subscribeColorbarPanel,
  subscribeEarthEnginePanel,
  subscribeHtmlPanel,
  subscribeLegendPanel,
  subscribeMeasurePanel,
  subscribeMinimapPanel,
  subscribePrintPanel,
  subscribeSearchPlacesPanel,
  subscribeSpinGlobePanel,
  subscribeViewStatePanel,
  toggleEarthEnginePanel,
} from "@geolibre/plugins";
import { useSyncExternalStore } from "react";
import type { AppApi } from "../components/layout/toolbar/constants";

/** Visibility flag plus a toggle handler for a single toolbar panel. */
export interface ToolbarPanel {
  visible: boolean;
  toggle: () => void;
}

/** Visibility + toggle state for every panel surfaced in the toolbar menus. */
export interface ToolbarPanels {
  searchPlaces: ToolbarPanel;
  spinGlobe: ToolbarPanel;
  print: ToolbarPanel;
  colorbar: ToolbarPanel;
  legend: ToolbarPanel;
  html: ToolbarPanel;
  measure: ToolbarPanel;
  bookmark: ToolbarPanel;
  minimap: ToolbarPanel;
  viewState: ToolbarPanel;
  earthEngine: ToolbarPanel;
}

/**
 * Subscribe to the external panel stores and expose a `{ visible, toggle }`
 * pair per panel. This collapses the toolbar's many repetitive
 * `useSyncExternalStore` + handler blocks into one hook.
 *
 * @param appApi - The live app API used to open/close panels.
 * @returns Visibility flags and toggle handlers for each toolbar panel.
 */
export function useToolbarPanels(appApi: AppApi): ToolbarPanels {
  const searchPlacesVisible = useSyncExternalStore(
    subscribeSearchPlacesPanel,
    isSearchPlacesPanelVisible,
    isSearchPlacesPanelVisible,
  );
  const spinGlobeVisible = useSyncExternalStore(
    subscribeSpinGlobePanel,
    isSpinGlobePanelVisible,
    isSpinGlobePanelVisible,
  );
  const printVisible = useSyncExternalStore(
    subscribePrintPanel,
    isPrintPanelVisible,
    isPrintPanelVisible,
  );
  const colorbarVisible = useSyncExternalStore(
    subscribeColorbarPanel,
    isColorbarPanelVisible,
    isColorbarPanelVisible,
  );
  const legendVisible = useSyncExternalStore(
    subscribeLegendPanel,
    isLegendPanelVisible,
    isLegendPanelVisible,
  );
  const htmlVisible = useSyncExternalStore(
    subscribeHtmlPanel,
    isHtmlPanelVisible,
    isHtmlPanelVisible,
  );
  const measureVisible = useSyncExternalStore(
    subscribeMeasurePanel,
    isMeasurePanelVisible,
    isMeasurePanelVisible,
  );
  const bookmarkVisible = useSyncExternalStore(
    subscribeBookmarkPanel,
    isBookmarkPanelVisible,
    isBookmarkPanelVisible,
  );
  const minimapVisible = useSyncExternalStore(
    subscribeMinimapPanel,
    isMinimapPanelVisible,
    isMinimapPanelVisible,
  );
  const viewStateVisible = useSyncExternalStore(
    subscribeViewStatePanel,
    isViewStatePanelVisible,
    isViewStatePanelVisible,
  );
  const earthEngineVisible = useSyncExternalStore(
    subscribeEarthEnginePanel,
    isEarthEnginePanelVisible,
    isEarthEnginePanelVisible,
  );

  return {
    searchPlaces: {
      visible: searchPlacesVisible,
      toggle: () => {
        if (searchPlacesVisible) {
          closeSearchPlacesPanel();
          return;
        }
        openSearchPlacesPanel(appApi);
      },
    },
    spinGlobe: {
      visible: spinGlobeVisible,
      toggle: () => {
        if (spinGlobeVisible) {
          closeSpinGlobePanel(appApi);
          return;
        }
        openSpinGlobePanel(appApi);
      },
    },
    print: {
      visible: printVisible,
      toggle: () => {
        if (printVisible) {
          closePrintPanel();
          return;
        }
        openPrintPanel(appApi);
      },
    },
    colorbar: {
      visible: colorbarVisible,
      toggle: () => {
        if (colorbarVisible) {
          closeColorbarPanel(appApi);
          return;
        }
        openColorbarPanel(appApi);
      },
    },
    legend: {
      visible: legendVisible,
      toggle: () => {
        if (legendVisible) {
          closeLegendPanel(appApi);
          return;
        }
        openLegendPanel(appApi);
      },
    },
    html: {
      visible: htmlVisible,
      toggle: () => {
        if (htmlVisible) {
          closeHtmlPanel(appApi);
          return;
        }
        openHtmlPanel(appApi);
      },
    },
    measure: {
      visible: measureVisible,
      toggle: () => {
        if (measureVisible) {
          closeMeasurePanel(appApi);
          return;
        }
        openMeasurePanel(appApi);
      },
    },
    bookmark: {
      visible: bookmarkVisible,
      toggle: () => {
        if (bookmarkVisible) {
          closeBookmarkPanel(appApi);
          return;
        }
        openBookmarkPanel(appApi);
      },
    },
    minimap: {
      visible: minimapVisible,
      toggle: () => {
        if (minimapVisible) {
          closeMinimapPanel(appApi);
          return;
        }
        openMinimapPanel(appApi);
      },
    },
    viewState: {
      visible: viewStateVisible,
      toggle: () => {
        if (viewStateVisible) {
          closeViewStatePanel(appApi);
          return;
        }
        openViewStatePanel(appApi);
      },
    },
    earthEngine: {
      visible: earthEngineVisible,
      toggle: () => toggleEarthEnginePanel(appApi),
    },
  };
}
