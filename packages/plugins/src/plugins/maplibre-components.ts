// The Components plugin (the maplibre-gl-components ControlGrid) and the public
// surface of its standalone sub-controls.
//
// Each sub-control lives in its own module under ./components/ and owns its
// state there; this coordinator mounts the ControlGrid, tears every sub-control
// down on deactivate, round-trips the Colorbar/Legend/HTML panels through the
// project file, and re-exports the sub-controls' public API so importers keep a
// single entry point (opengeos/GeoLibre#2633). Dependencies point one way:
// this file imports ./components/*, and nothing under ./components/ imports it.

import type { ControlGrid, ControlGridOptions, DefaultControlName } from "maplibre-gl-components";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition, GeoLibrePlugin } from "../types";
import { INTERNAL_HELPER_LAYER_PATTERNS } from "./internal-layers";
import { teardownBookmarkControl } from "./components/bookmark";
import { teardownCogRasterControl } from "./components/cog";
import {
  colorbarControl,
  colorbarPanelVisible,
  restoreColorbarPanel,
  teardownColorbarControl,
} from "./components/colorbar";
import { getComponentsConstructors } from "./components/constructors";
import { teardownFlatGeobufControl } from "./components/flatgeobuf";
import { teardownGeoTiffRasterOverlay } from "./components/geotiff";
import {
  type ComponentsProjectState,
  normalizeColorbarState,
  normalizeComponentsProjectState,
  normalizeHtmlState,
  normalizeLegendState,
} from "./components/gui-state";
import {
  htmlControl,
  htmlPanelVisible,
  restoreHtmlPanel,
  teardownHtmlControl,
} from "./components/html";
import {
  legendControl,
  legendPanelVisible,
  restoreLegendPanel,
  teardownLegendControl,
} from "./components/legend";
import { teardownLidarControl } from "./components/lidar";
import { teardownMeasureControl } from "./components/measure";
import { teardownMinimapControl } from "./components/minimap";
import { teardownPMTilesControl } from "./components/pmtiles";
import { teardownPrintControl } from "./components/print";
import { teardownSearchControl } from "./components/search";
import { teardownSpinGlobeControl } from "./components/spin-globe";
import { teardownSplattingControl } from "./components/splatting";
import { teardownStacSearchControl } from "./components/stac-search";
import { teardownViewStateControl } from "./components/view-state";
import { teardownZarrControl } from "./components/zarr";

export {
  closeBookmarkPanel,
  isBookmarkPanelVisible,
  openBookmarkPanel,
  setBookmarkLabels,
  subscribeBookmarkPanel,
} from "./components/bookmark";
export {
  addCogRasterLayer,
  clearMirrorCogLayers,
  createSwipeCogMirrorControl,
  getCogRasterMainVisibility,
  getSwipeCogRasters,
  getSwipeMaplibreRasters,
  mirrorAddCogLayer,
  mirrorRemoveCogLayer,
  mirrorSetCogOpacity,
  setCogRasterMainVisibility,
  subscribeSwipeCogChanges,
  type SwipeCogRasterSnapshot,
  type SwipeMaplibreRasterSnapshot,
} from "./components/cog";
export {
  closeColorbarPanel,
  isColorbarPanelVisible,
  openColorbarPanel,
  subscribeColorbarPanel,
} from "./components/colorbar";
export {
  __setComponentsModuleLoaderForTests,
  type ComponentsModules,
  getComponentsConstructors,
} from "./components/constructors";
export { openFlatGeobufAddVectorLayerPanel } from "./components/flatgeobuf";
export { normalizeColorbarState } from "./components/gui-state";
export {
  closeHtmlPanel,
  isHtmlPanelVisible,
  openHtmlPanel,
  subscribeHtmlPanel,
} from "./components/html";
export {
  closeLegendPanel,
  isLegendPanelVisible,
  openLegendPanel,
  openLegendPanelWithItems,
  subscribeLegendPanel,
} from "./components/legend";
export {
  addLidarLayerFromUrl,
  LIDAR_SOURCE_KIND,
  openLidarLayerPanel,
  restoreLidarLayers,
  withLidarAutoZoomSuppressed,
} from "./components/lidar";
export {
  closeMeasurePanel,
  isMeasurePanelVisible,
  openMeasurePanel,
  subscribeMeasurePanel,
} from "./components/measure";
export {
  closeMinimapPanel,
  isMinimapPanelVisible,
  openMinimapPanel,
  subscribeMinimapPanel,
} from "./components/minimap";
export {
  __beginProgrammaticPMTilesAddForTests,
  __getPMTilesControlForTests,
  __mountPMTilesControlForTests,
  __resetPMTilesControlForTests,
  addPMTilesLayerFromUrl,
  createPMTilesLayerAddHandler,
  createPMTilesLayerRemoveHandler,
  openPMTilesLayerPanel,
  pmtilesArchivesFullyRemoved,
  pmtilesLayerIdsToRemove,
  pmtilesStoreLayers,
  teardownPMTilesControl,
} from "./components/pmtiles";
export {
  closePrintPanel,
  isPrintPanelVisible,
  openPrintPanel,
  subscribePrintPanel,
} from "./components/print";
export {
  closeSearchPlacesPanel,
  isSearchPlacesPanelVisible,
  openSearchPlacesPanel,
  subscribeSearchPlacesPanel,
} from "./components/search";
export { type CogRasterLayerOptions } from "./components/shared";
export {
  closeSpinGlobePanel,
  isSpinGlobePanelVisible,
  openSpinGlobePanel,
  subscribeSpinGlobePanel,
} from "./components/spin-globe";
export { openSplattingLayerPanel } from "./components/splatting";
export { applyStacSearchLayerOrder, openStacSearchLayerPanel } from "./components/stac-search";
export {
  closeViewStatePanel,
  isViewStatePanelVisible,
  openViewStatePanel,
  setViewStateLabels,
  subscribeViewStatePanel,
} from "./components/view-state";
export {
  addCloudNetcdfLayer,
  addZarrRasterLayer,
  type CloudNetcdfLayerOptions,
  openZarrLayerPanel,
  queryZarrLayer,
  restoreArcgisZarrLayers,
  setZarrLayerSelector,
  setZarrLocalStoreProvider,
  type ZarrRasterLayerOptions,
  type ZarrReadableStore,
  type ZarrTimeAttributesReader,
} from "./components/zarr";

let componentsControlPosition: GeoLibreMapControlPosition = "top-right";

const COMPONENT_CONTROL_NAMES = [
  "spinGlobe",
  "fullscreen",
  "north",
  "terrain",
  "search",
  "viewState",
  "inspect",
  "vectorDataset",
  "basemap",
  "measure",
  "geoEditor",
  "bookmark",
  "print",
  "swipe",
  "streetView",
  "addVector",
  "cogLayer",
  "zarrLayer",
  "pmtilesLayer",
  "stacLayer",
  "stacSearch",
  "planetaryComputer",
  "gaussianSplat",
  "colorbarGui",
  "legendGui",
  "htmlGui",
  "lidar",
  "usgsLidar",
] satisfies DefaultControlName[];

const COMPONENTS_OPTIONS = {
  className: "geolibre-components-control",
  collapsed: false,
  columns: 5,
  defaultControls: COMPONENT_CONTROL_NAMES,
  // Shared with Layer Swipe (and any other layer-list control) so the hidden
  // "chrome" layer set stays consistent; see INTERNAL_HELPER_LAYER_PATTERNS.
  excludeLayers: [...INTERNAL_HELPER_LAYER_PATTERNS],
  gap: 2,
  rows: 5,
  showRowColumnControls: true,
} satisfies Omit<ControlGridOptions, "position" | "basemapStyleUrl">;

let componentsControl: ControlGrid | null = null;
let pluginActive = false;
let componentsControlRevision = 0;

const createComponentsControl = async (app: GeoLibreAppAPI): Promise<ControlGrid | null> => {
  const { ControlGrid: ControlGridClass } = await getComponentsConstructors();
  if (!pluginActive) return null;
  return new ControlGridClass(getComponentsOptions(app));
};

const createAndMountComponentsControl = (app: GeoLibreAppAPI): void => {
  const revision = ++componentsControlRevision;
  void createComponentsControl(app).then((control) => {
    if (!pluginActive || componentsControl || !control || revision !== componentsControlRevision) {
      return;
    }
    componentsControl = control;
    mountComponentsControl(app);
  });
};

const mountComponentsControl = (app: GeoLibreAppAPI): boolean => {
  if (!componentsControl) return false;
  const added = app.addMapControl(componentsControl, componentsControlPosition);
  if (!added) {
    componentsControl = null;
    return false;
  }
  setTimeout(() => componentsControl?.expand(), 0);
  return true;
};

/** Stable id of the Components plugin. */
export const COMPONENTS_PLUGIN_ID = "maplibre-gl-components";

export const maplibreComponentsPlugin: GeoLibrePlugin = {
  id: COMPONENTS_PLUGIN_ID,
  name: "Components",
  version: "0.18.2",
  activate: (app: GeoLibreAppAPI) => {
    pluginActive = true;
    if (componentsControl) return mountComponentsControl(app);
    createAndMountComponentsControl(app);
  },
  deactivate: (app: GeoLibreAppAPI) => {
    pluginActive = false;
    componentsControlRevision += 1;
    teardownCogRasterControl(app);
    teardownGeoTiffRasterOverlay(app);
    teardownFlatGeobufControl(app);
    teardownPMTilesControl(app);
    teardownPrintControl(app);
    teardownSearchControl(app);
    teardownSpinGlobeControl(app);
    teardownMeasureControl(app);
    teardownBookmarkControl(app);
    teardownMinimapControl(app);
    teardownViewStateControl(app);
    teardownStacSearchControl(app);
    teardownZarrControl(app);
    teardownColorbarControl(app);
    teardownLegendControl(app);
    teardownHtmlControl(app);
    teardownLidarControl(app);
    teardownSplattingControl(app);
    if (!componentsControl) return;
    app.removeMapControl(componentsControl);
    componentsControl = null;
  },
  getMapControlPosition: () => componentsControlPosition,
  setMapControlPosition: (app: GeoLibreAppAPI, position: GeoLibreMapControlPosition) => {
    componentsControlPosition = position;
    if (!componentsControl) return;
    app.removeMapControl(componentsControl);
    componentsControl = null;
    createAndMountComponentsControl(app);
  },
  getProjectState: () => componentsProjectStateSnapshot(),
  applyProjectState: (app: GeoLibreAppAPI, state: unknown) => {
    applyComponentsProjectState(app, state);
  },
};

function componentsProjectStateSnapshot(): ComponentsProjectState | undefined {
  // `colorbarControl`, `colorbarPanelVisible` and the legend/html equivalents
  // are live (read-only) bindings to the owning modules' state.
  const state: ComponentsProjectState = {};
  if (colorbarPanelVisible && colorbarControl) {
    state.colorbar = normalizeColorbarState(colorbarControl.getState());
  }
  if (legendPanelVisible && legendControl) {
    state.legend = normalizeLegendState(legendControl.getState());
  }
  if (htmlPanelVisible && htmlControl) {
    state.html = normalizeHtmlState(htmlControl.getState());
  }

  return Object.keys(state).length > 0 ? state : undefined;
}

function applyComponentsProjectState(app: GeoLibreAppAPI, state: unknown): void {
  const normalized = normalizeComponentsProjectState(state);
  if (normalized?.colorbar?.visible) {
    void restoreColorbarPanel(app, normalized.colorbar);
  } else {
    teardownColorbarControl(app);
  }

  if (normalized?.legend?.visible) {
    void restoreLegendPanel(app, normalized.legend);
  } else {
    teardownLegendControl(app);
  }

  if (normalized?.html?.visible) {
    void restoreHtmlPanel(app, normalized.html);
  } else {
    teardownHtmlControl(app);
  }
}

export function closeMaplibreComponentControls(app: GeoLibreAppAPI): void {
  teardownCogRasterControl(app);
  teardownGeoTiffRasterOverlay(app);
  teardownFlatGeobufControl(app);
  teardownPMTilesControl(app);
  teardownPrintControl(app);
  teardownSearchControl(app);
  teardownSpinGlobeControl(app);
  teardownMeasureControl(app);
  teardownBookmarkControl(app);
  teardownMinimapControl(app);
  teardownViewStateControl(app);
  teardownStacSearchControl(app);
  teardownZarrControl(app);
  teardownColorbarControl(app);
  teardownLegendControl(app);
  teardownHtmlControl(app);
  teardownLidarControl(app);
  teardownSplattingControl(app);
}

function getComponentsOptions(app: GeoLibreAppAPI): ControlGridOptions {
  return {
    ...COMPONENTS_OPTIONS,
    basemapStyleUrl: app.getActiveBasemap(),
    position: componentsControlPosition,
  };
}
