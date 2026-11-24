import { useAppStore } from "@geolibre/core";
import {
  closeBookmarkPanel,
  closeColorbarPanel,
  closeHtmlPanel,
  closeMeasurePanel,
  closeMinimapPanel,
  closePrintPanel,
  closeSearchPlacesPanel,
  closeSpinGlobePanel,
  closeViewStatePanel,
  isBookmarkPanelVisible,
  isColorbarPanelVisible,
  isHtmlPanelVisible,
  isMeasurePanelVisible,
  isMinimapPanelVisible,
  isPrintPanelVisible,
  isSearchPlacesPanelVisible,
  isSpinGlobePanelVisible,
  isViewStatePanelVisible,
  openBookmarkPanel,
  openColorbarPanel,
  openHtmlPanel,
  openMeasurePanel,
  openMinimapPanel,
  openPrintPanel,
  openSearchPlacesPanel,
  openSpinGlobePanel,
  openViewStatePanel,
  subscribeBookmarkPanel,
  subscribeColorbarPanel,
  getImageControlStates,
  removeImageControl,
  setImageControl,
  subscribeHtmlPanel,
  subscribeImagePanel,
  subscribeMeasurePanel,
  subscribeMinimapPanel,
  subscribePrintPanel,
  subscribeSearchPlacesPanel,
  subscribeSpinGlobePanel,
  subscribeViewStatePanel,
} from "@geolibre/plugins/component-helpers";
import {
  isEarthEnginePanelVisible,
  subscribeEarthEnginePanel,
  toggleEarthEnginePanel,
} from "@geolibre/plugins/maplibre-earth-engine";
import { type ComponentImageState } from "@geolibre/plugins";
import { useSyncExternalStore } from "react";
import type { AppApi } from "../components/layout/toolbar/constants";
import { setImageControlDialogOpen } from "../lib/image-control-dialog-store";
import {
  sunPanelStore,
  routeAnimationPanelStore,
  flightSimulatorPanelStore,
} from "../lib/plugin-panel-stores";
import { getPluginManager, reportPluginError } from "./usePlugins";
import type { BuiltInPluginId } from "@geolibre/plugins/builtin-plugin-metadata";
import type { GeoLibreAppAPI } from "@geolibre/plugins";

/** Visibility flag plus a toggle handler for a single toolbar panel. */
export interface ToolbarPanel {
  visible: boolean;
  toggle: () => void;
}

/**
 * The Image control: its toggle opens the dialog; `images` lists what is on the
 * map and apply/remove edit it. `visible` means at least one image is shown.
 */
export interface ToolbarImagePanel extends ToolbarPanel {
  images: readonly ComponentImageState[];
  /** Adds an image, or updates the one with the same id; returns its id. */
  apply: (state: Partial<ComponentImageState>) => string | null;
  remove: (id: string) => void;
}

/** Visibility + toggle state for every panel surfaced in the toolbar menus. */
export interface ToolbarPanels {
  searchPlaces: ToolbarPanel;
  spinGlobe: ToolbarPanel;
  sun: ToolbarPanel;
  routeAnimation: ToolbarPanel;
  flightSimulator: ToolbarPanel;
  print: ToolbarPanel;
  colorbar: ToolbarPanel;
  legend: ToolbarPanel;
  html: ToolbarPanel;
  image: ToolbarImagePanel;
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
  const runPanelAction = (id: BuiltInPluginId, action: (app: GeoLibreAppAPI) => void) => {
    void getPluginManager()
      .runPluginHelper(id, appApi, (_implementation, preparedApp) => action(preparedApp))
      .catch((error: unknown) => reportPluginError(id, "update-panel", error));
  };
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
  const sunVisible = useSyncExternalStore(
    sunPanelStore.subscribe,
    sunPanelStore.getSnapshot,
    sunPanelStore.getSnapshot,
  );
  const routeAnimationVisible = useSyncExternalStore(
    routeAnimationPanelStore.subscribe,
    routeAnimationPanelStore.getSnapshot,
    routeAnimationPanelStore.getSnapshot,
  );
  const flightSimulatorVisible = useSyncExternalStore(
    flightSimulatorPanelStore.subscribe,
    flightSimulatorPanelStore.getSnapshot,
    flightSimulatorPanelStore.getSnapshot,
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
  // The Legend panel is React-rendered from store state (MapLegendPanel), not
  // a maplibre-gl-components control like the rest.
  const legendConfig = useAppStore((state) => state.legend);
  const setLegend = useAppStore((state) => state.setLegend);
  const legendVisible = legendConfig.panelVisible === true;
  const htmlVisible = useSyncExternalStore(
    subscribeHtmlPanel,
    isHtmlPanelVisible,
    isHtmlPanelVisible,
  );
  const images = useSyncExternalStore(
    subscribeImagePanel,
    getImageControlStates,
    getImageControlStates,
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
      toggle: () =>
        runPanelAction("maplibre-gl-components", (preparedApp) => {
          if (isSearchPlacesPanelVisible()) {
            closeSearchPlacesPanel();
            return;
          }
          openSearchPlacesPanel(preparedApp);
        }),
    },
    spinGlobe: {
      visible: spinGlobeVisible,
      toggle: () =>
        runPanelAction("maplibre-gl-components", (preparedApp) => {
          if (isSpinGlobePanelVisible()) {
            closeSpinGlobePanel(preparedApp);
            return;
          }
          openSpinGlobePanel(preparedApp);
        }),
    },
    sun: {
      visible: sunVisible,
      toggle: () =>
        runPanelAction("geolibre-sun", (preparedApp) => {
          if (sunPanelStore.getSnapshot()) {
            sunPanelStore.runtime.close(preparedApp);
            return;
          }
          sunPanelStore.runtime.open(preparedApp);
        }),
    },
    routeAnimation: {
      visible: routeAnimationVisible,
      toggle: () =>
        runPanelAction("geolibre-route-animation", (preparedApp) => {
          if (routeAnimationPanelStore.getSnapshot()) {
            routeAnimationPanelStore.runtime.close(preparedApp);
            return;
          }
          routeAnimationPanelStore.runtime.open(preparedApp);
        }),
    },
    flightSimulator: {
      visible: flightSimulatorVisible,
      toggle: () =>
        runPanelAction("geolibre-flight-simulator", (preparedApp) => {
          if (flightSimulatorPanelStore.getSnapshot()) {
            flightSimulatorPanelStore.runtime.close(preparedApp);
            return;
          }
          flightSimulatorPanelStore.runtime.open(preparedApp);
        }),
    },
    print: {
      visible: printVisible,
      toggle: () =>
        runPanelAction("maplibre-gl-components", (preparedApp) => {
          if (isPrintPanelVisible()) {
            closePrintPanel();
            return;
          }
          openPrintPanel(preparedApp);
        }),
    },
    colorbar: {
      visible: colorbarVisible,
      toggle: () =>
        runPanelAction("maplibre-gl-components", (preparedApp) => {
          if (isColorbarPanelVisible()) {
            closeColorbarPanel(preparedApp);
            return;
          }
          openColorbarPanel(preparedApp);
        }),
    },
    legend: {
      visible: legendVisible,
      toggle: () => setLegend({ ...legendConfig, panelVisible: !legendVisible }),
    },
    html: {
      visible: htmlVisible,
      toggle: () =>
        runPanelAction("maplibre-gl-components", (preparedApp) => {
          if (isHtmlPanelVisible()) {
            closeHtmlPanel(preparedApp);
            return;
          }
          openHtmlPanel(preparedApp);
        }),
    },
    image: {
      visible: images.length > 0,
      toggle: () => runPanelAction("maplibre-gl-components", () => setImageControlDialogOpen(true)),
      images,
      apply: (state) => setImageControl(appApi, state),
      remove: (id) =>
        runPanelAction("maplibre-gl-components", (preparedApp) =>
          removeImageControl(preparedApp, id),
        ),
    },
    measure: {
      visible: measureVisible,
      toggle: () =>
        runPanelAction("maplibre-gl-components", (preparedApp) => {
          if (isMeasurePanelVisible()) {
            closeMeasurePanel(preparedApp);
            return;
          }
          openMeasurePanel(preparedApp);
        }),
    },
    bookmark: {
      visible: bookmarkVisible,
      toggle: () =>
        runPanelAction("maplibre-gl-components", (preparedApp) => {
          if (isBookmarkPanelVisible()) {
            closeBookmarkPanel(preparedApp);
            return;
          }
          openBookmarkPanel(preparedApp);
        }),
    },
    minimap: {
      visible: minimapVisible,
      toggle: () =>
        runPanelAction("maplibre-gl-components", (preparedApp) => {
          if (isMinimapPanelVisible()) {
            closeMinimapPanel(preparedApp);
            return;
          }
          openMinimapPanel(preparedApp);
        }),
    },
    viewState: {
      visible: viewStateVisible,
      toggle: () =>
        runPanelAction("maplibre-gl-components", (preparedApp) => {
          if (isViewStatePanelVisible()) {
            closeViewStatePanel(preparedApp);
            return;
          }
          openViewStatePanel(preparedApp);
        }),
    },
    earthEngine: {
      visible: earthEngineVisible,
      toggle: () => toggleEarthEnginePanel(appApi),
    },
  };
}
