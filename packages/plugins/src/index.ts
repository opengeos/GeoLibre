export * from "./types";
export { PluginManager } from "./plugin-manager";
export { maplibreLayerControlPlugin } from "./plugins/layer-control";
export { osmBasemapPlugin } from "./plugins/osm-basemap";
export { cartoLightPlugin } from "./plugins/carto-light";
export { maplibreBasemapControlPlugin } from "./plugins/maplibre-basemap-control";
export {
  addArcGISLayer,
  type ArcGISLayerOptions,
  type ArcGISLayerType,
  type ArcGISSourceType,
} from "./plugins/arcgis-layer";
export {
  addCogRasterLayer,
  closeBookmarkPanel,
  closeColorbarPanel,
  closeHtmlPanel,
  closeLegendPanel,
  closeMaplibreComponentControls,
  closeMeasurePanel,
  closeMinimapPanel,
  closePrintPanel,
  closeSearchPlacesPanel,
  closeViewStatePanel,
  isBookmarkPanelVisible,
  isColorbarPanelVisible,
  isHtmlPanelVisible,
  isLegendPanelVisible,
  isMeasurePanelVisible,
  isMinimapPanelVisible,
  isPrintPanelVisible,
  isSearchPlacesPanelVisible,
  isViewStatePanelVisible,
  maplibreComponentsPlugin,
  openBookmarkPanel,
  openFlatGeobufAddVectorLayerPanel,
  openColorbarPanel,
  openHtmlPanel,
  openLegendPanel,
  openLidarLayerPanel,
  openMeasurePanel,
  openMinimapPanel,
  openPMTilesLayerPanel,
  openPrintPanel,
  openSearchPlacesPanel,
  openSplattingLayerPanel,
  openStacSearchLayerPanel,
  openViewStatePanel,
  openZarrLayerPanel,
  addCloudNetcdfLayer,
  type CloudNetcdfLayerOptions,
  subscribeBookmarkPanel,
  subscribeColorbarPanel,
  subscribeHtmlPanel,
  subscribeLegendPanel,
  subscribeMeasurePanel,
  subscribeMinimapPanel,
  subscribePrintPanel,
  subscribeSearchPlacesPanel,
  subscribeViewStatePanel,
  type CogRasterLayerOptions,
} from "./plugins/maplibre-components";
export {
  KerchunkReferenceStore,
  loadKerchunkReference,
  listKerchunkVariables,
  normalizeKerchunkReference,
  type KerchunkRefs,
  type KerchunkVariable,
} from "./plugins/kerchunk-reference-store";
export {
  closeDuckDBLayerPanel,
  getDuckDBFeatureBounds,
  getDuckDBLayerRows,
  identifyDuckDBLayerAtPoint,
  openDuckDBLayerPanel,
  setDuckDBSelectedFeature,
  updateDuckDBLayerRows,
  type DuckDBAttributeRow,
  type DuckDBIdentifyResult,
} from "./plugins/maplibre-duckdb";
export {
  closePlanetaryComputerPanel,
  openPlanetaryComputerPanel,
} from "./plugins/maplibre-planetary-computer";
export {
  closeEarthEnginePanel,
  isEarthEnginePanelVisible,
  openEarthEnginePanel,
  subscribeEarthEnginePanel,
  toggleEarthEnginePanel,
} from "./plugins/maplibre-earth-engine";
export {
  closeThreeDTilesLayerPanel,
  openThreeDTilesLayerPanel,
  restoreThreeDTilesLayers,
} from "./plugins/maplibre-3d-tiles";
export {
  addRasterToMap,
  closeRasterLayerPanel,
  openRasterLayerPanel,
  restoreRasterLayers,
} from "./plugins/maplibre-raster";
export {
  closeVectorLayerPanel,
  openVectorLayerPanel,
  reloadVectorControlLayer,
  restoreVectorLayers,
} from "./plugins/maplibre-vector";
// The raster-layer-sync and vector-layer-sync internals are not
// re-exported: the app drives the panels through the functions above, and
// the tests import the sync helpers from the module paths directly.
export {
  DIRECTIONS_PLUGIN_ID,
  maplibreDirectionsPlugin,
  restoreDirections,
} from "./plugins/maplibre-directions";
export {
  EFFECTS_PLUGIN_ID,
  maplibreEffectsPlugin,
  restoreEffects,
} from "./plugins/maplibre-effects";
export { maplibreEnviroAtlasPlugin } from "./plugins/maplibre-enviroatlas";
export { maplibreEsriWaybackPlugin } from "./plugins/maplibre-esri-wayback";
export { maplibreFemaWmsPlugin } from "./plugins/maplibre-fema-wms";
export {
  maplibreGeoEditorPlugin,
  canEditLayerGeometry,
  startLayerGeometryEdit,
  endLayerGeometryEdit,
  getGeometryEditTargetLayerId,
  subscribeGeometryEdit,
} from "./plugins/maplibre-geo-editor";
export { maplibreGeoAgentPlugin } from "./plugins/maplibre-geoagent";
export { maplibreLidarPlugin } from "./plugins/maplibre-lidar";
export { maplibreNasaEarthdataPlugin } from "./plugins/maplibre-nasa-earthdata";
export { maplibreNationalMapPlugin } from "./plugins/maplibre-national-map";
export { maplibreOvertureMapsPlugin } from "./plugins/maplibre-overture-maps";
export { maplibreStreetViewPlugin } from "./plugins/maplibre-streetview";
export { maplibreSwipePlugin } from "./plugins/maplibre-swipe";
export { maplibreTimeSliderPlugin } from "./plugins/maplibre-time-slider";
export {
  sampleGeoJsonPlugin,
  setSampleGeoJson,
} from "./plugins/sample-geojson";
export { WEB_SERVICE_PLUGIN_IDS } from "./plugins/web-service-sync";
