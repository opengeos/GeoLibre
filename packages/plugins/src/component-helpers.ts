// Standalone controls share their original state without evaluating the ControlGrid plugin.
import type { GeoLibreAppAPI } from "./types";
export { setTerrainMeasureBodyNames, setTerrainMeasureLabels } from "./plugins/terrain-measure";
import { teardownBookmarkControl } from "./plugins/components/bookmark";
import { teardownFlatGeobufControl } from "./plugins/components/flatgeobuf";
import { teardownLidarControl } from "./plugins/components/lidar";
import { teardownMeasureControl } from "./plugins/components/measure";
import { teardownMinimapControl } from "./plugins/components/minimap";
import { teardownPMTilesControl } from "./plugins/components/pmtiles";
import { teardownPrintControl } from "./plugins/components/print";
import { teardownSearchControl } from "./plugins/components/search";
import { teardownSpinGlobeControl } from "./plugins/components/spin-globe";
import { teardownSplattingControl } from "./plugins/components/splatting";
import { teardownStacSearchControl } from "./plugins/components/stac-search";
import { teardownViewStateControl } from "./plugins/components/view-state";
import { teardownZarrControl } from "./plugins/components/zarr";
import { teardownColorbarControl } from "./plugins/components/colorbar";
import { teardownHtmlControl } from "./plugins/components/html";
import { teardownLegendControl } from "./plugins/components/legend";
import { teardownImageControl } from "./plugins/components/image";

export {
  closeBookmarkPanel,
  isBookmarkPanelVisible,
  openBookmarkPanel,
  setBookmarkLabels,
  subscribeBookmarkPanel,
} from "./plugins/components/bookmark";
export {
  clearMirrorCogLayers,
  createSwipeCogMirrorControl,
  getSwipeCogRasters,
  getSwipeMaplibreRasters,
  mirrorAddCogLayer,
  mirrorRemoveCogLayer,
  mirrorSetCogOpacity,
  subscribeSwipeCogChanges,
  type SwipeCogRasterSnapshot,
  type SwipeMaplibreRasterSnapshot,
} from "./plugins/components/cog";
export {
  closeColorbarPanel,
  isColorbarPanelVisible,
  openColorbarPanel,
  subscribeColorbarPanel,
} from "./plugins/components/colorbar";
export {
  __setComponentsModuleLoaderForTests,
  type ComponentsModules,
  getComponentsConstructors,
} from "./plugins/components/constructors";
export { openFlatGeobufAddVectorLayerPanel } from "./plugins/components/flatgeobuf";
export { normalizeColorbarState } from "./plugins/components/gui-state";
export {
  closeHtmlPanel,
  isHtmlPanelVisible,
  openHtmlPanel,
  openHtmlPanelWithEntry,
  subscribeHtmlPanel,
} from "./plugins/components/html";
export {
  closeImagePanel,
  getImageControlStates,
  isImagePanelVisible,
  removeImageControl,
  setImageControl,
  setImageLabels,
  subscribeImagePanel,
} from "./plugins/components/image";
export {
  type ComponentImageState,
  type ImageSizeMode,
  IMAGE_RATIO_MAX,
  IMAGE_RATIO_MIN,
  IMAGE_SIZE_MAX,
  IMAGE_SIZE_MIN,
  MAX_IMAGE_CONTROLS,
  DEFAULT_IMAGE_STATE,
  formatAspectRatio,
  normalizeImageUrl,
  isRatioHeightInRange,
  ratioHeight,
  parseAspectRatio,
} from "./plugins/components/image-model";
export {
  closeLegendPanel,
  isLegendPanelVisible,
  openLegendPanel,
  openLegendPanelWithItems,
  subscribeLegendPanel,
} from "./plugins/components/legend";
export {
  addLidarLayerFromBytes,
  addLidarLayerFromUrl,
  LIDAR_SOURCE_KIND,
  openLidarLayerPanel,
  restoreLidarLayers,
  withLidarAutoZoomSuppressed,
} from "./plugins/components/lidar";
export {
  closeMeasurePanel,
  isMeasurePanelVisible,
  openMeasurePanel,
  subscribeMeasurePanel,
} from "./plugins/components/measure";
export {
  closeMinimapPanel,
  isMinimapPanelVisible,
  openMinimapPanel,
  subscribeMinimapPanel,
} from "./plugins/components/minimap";
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
} from "./plugins/components/pmtiles";
export {
  closePrintPanel,
  isPrintPanelVisible,
  openPrintPanel,
  subscribePrintPanel,
} from "./plugins/components/print";
export {
  closeSearchPlacesPanel,
  isSearchPlacesPanelVisible,
  openSearchPlacesPanel,
  subscribeSearchPlacesPanel,
} from "./plugins/components/search";
export {
  closeSpinGlobePanel,
  isSpinGlobePanelVisible,
  openSpinGlobePanel,
  subscribeSpinGlobePanel,
} from "./plugins/components/spin-globe";
export { openSplattingLayerPanel, restoreSplattingLayers } from "./plugins/components/splatting";
export {
  applyStacSearchLayerOrder,
  openStacSearchLayerPanel,
} from "./plugins/components/stac-search";
export {
  closeViewStatePanel,
  isViewStatePanelVisible,
  openViewStatePanel,
  setViewStateLabels,
  subscribeViewStatePanel,
} from "./plugins/components/view-state";
export {
  addCloudNetcdfLayer,
  addZarrRasterLayer,
  type CloudNetcdfLayerOptions,
  openZarrLayerPanel,
  isNativeZarrRenderer,
  queryZarrLayer,
  restoreArcgisZarrLayers,
  restoreZarrLayers,
  setZarrLayerSelector,
  setZarrLocalStoreProvider,
  type ZarrRasterLayerOptions,
  type ZarrReadableStore,
  type ZarrTimeAttributesReader,
} from "./plugins/components/zarr";

export function closeMaplibreComponentControls(app: GeoLibreAppAPI): void {
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
  teardownImageControl(app);
  teardownLidarControl(app);
  teardownSplattingControl(app);
}
