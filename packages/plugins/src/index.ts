export * from "./types";
export { PluginManager } from "./plugin-manager";
export {
  registerRightPanel,
  unregisterRightPanel,
  openRightPanel,
  collapseRightPanel,
  closeRightPanel,
  getActiveRightPanel,
  setActiveRightPanelDock,
  moveActiveRightPanelDock,
  getActiveRightPanelDock,
  RIGHT_PANEL_DOCKS,
  isRightPanelCollapsed,
  getRightPanel,
  listRightPanels,
  getRightPanelSnapshot,
  subscribeRightPanels,
  type RightPanelSnapshot,
  type RightPanelDock,
} from "./right-panel-registry";
export {
  registerToolbarMenu,
  unregisterToolbarMenu,
  listToolbarMenus,
  getToolbarMenusSnapshot,
  subscribeToolbarMenus,
  type ToolbarMenusSnapshot,
  type ToolbarMenuEntry,
} from "./toolbar-menu-registry";
export {
  registerFloatingPanel,
  unregisterFloatingPanel,
  openFloatingPanel,
  closeFloatingPanel,
  focusFloatingPanel,
  isFloatingPanelOpen,
  getOpenFloatingPanels,
  getFloatingPanel,
  getFloatingPanelsSnapshot,
  subscribeFloatingPanels,
  type FloatingPanelsSnapshot,
} from "./floating-panel-registry";
export { maplibreLayerControlPlugin } from "./plugins/layer-control";
export { osmBasemapPlugin } from "./plugins/osm-basemap";
export { cartoLightPlugin } from "./plugins/carto-light";
export {
  maplibreBasemapControlPlugin,
  setBasemapControlLabels,
  type BasemapControlLabels,
} from "./plugins/maplibre-basemap-control";
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
  closeSpinGlobePanel,
  closeViewStatePanel,
  isBookmarkPanelVisible,
  isColorbarPanelVisible,
  isHtmlPanelVisible,
  isLegendPanelVisible,
  isMeasurePanelVisible,
  isMinimapPanelVisible,
  isPrintPanelVisible,
  isSearchPlacesPanelVisible,
  isSpinGlobePanelVisible,
  isViewStatePanelVisible,
  COMPONENTS_PLUGIN_ID,
  maplibreComponentsPlugin,
  openBookmarkPanel,
  openFlatGeobufAddVectorLayerPanel,
  openColorbarPanel,
  openHtmlPanel,
  openLegendPanel,
  openLidarLayerPanel,
  restoreLidarLayers,
  openMeasurePanel,
  openMinimapPanel,
  openPMTilesLayerPanel,
  openPrintPanel,
  openSearchPlacesPanel,
  openSpinGlobePanel,
  openSplattingLayerPanel,
  openStacSearchLayerPanel,
  openViewStatePanel,
  openZarrLayerPanel,
  addCloudNetcdfLayer,
  type CloudNetcdfLayerOptions,
  setBookmarkLabels,
  setViewStateLabels,
  subscribeBookmarkPanel,
  subscribeColorbarPanel,
  subscribeHtmlPanel,
  subscribeLegendPanel,
  subscribeMeasurePanel,
  subscribeMinimapPanel,
  subscribePrintPanel,
  subscribeSearchPlacesPanel,
  subscribeSpinGlobePanel,
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
  restorePlanetaryComputerLayers,
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
  applyRasterLayerOrder,
  closeRasterLayerPanel,
  openRasterLayerPanel,
  restoreRasterLayers,
  setNonTiledRasterHandler,
  setRasterPixelInspect,
  type NonTiledRasterRequest,
} from "./plugins/maplibre-raster";
export {
  RASTER_MAX_CLASSES,
  RASTER_MIN_CLASSES,
  RASTER_MIN_CUSTOM_COLORS,
  type RasterBandStats,
  type RasterClassificationMethod,
  type RasterSymbology,
  clampRasterClassCount,
  computeRasterBreaks,
  defaultRasterSymbology,
  savedRasterSymbology,
} from "./plugins/raster-symbology";
export {
  RASTER_SOURCE_KIND,
  getRasterBandStats,
} from "./plugins/raster-symbology-texture";
export { colormapColors, warmColormapColors } from "./plugins/colormap-colors";
export {
  closeVectorLayerPanel,
  materializeEmbeddableVectorLayers,
  openVectorLayerPanel,
  reloadVectorControlLayer,
  restoreVectorLayers,
} from "./plugins/maplibre-vector";
// The raster-layer-sync and vector-layer-sync internals are not
// re-exported: the app drives the panels through the functions above, and
// the tests import the sync helpers from the module paths directly.
export {
  clearDirectionsWaypoints,
  DIRECTIONS_PLUGIN_ID,
  getDirectionsWaypointCount,
  isDirectionsRemovalInFlight,
  maplibreDirectionsPlugin,
  removeLastDirectionsWaypoint,
  restoreDirections,
  subscribeDirectionsState,
} from "./plugins/maplibre-directions";
export {
  REVERSE_GEOCODE_PLUGIN_ID,
  maplibreReverseGeocodePlugin,
  restoreReverseGeocode,
  setReverseGeocodeLabels,
  type ReverseGeocodeLabels,
} from "./plugins/maplibre-reverse-geocode";
export {
  DEFAULT_EFFECTS_SETTINGS,
  EFFECTS_PLUGIN_ID,
  type EffectsSettings,
  getEffectsSettings,
  HALO_EXTENT_MAX,
  HALO_EXTENT_MIN,
  HALO_OPACITY_MAX,
  HALO_OPACITY_MIN,
  maplibreEffectsPlugin,
  restoreEffects,
  setEffectsSettings,
} from "./plugins/maplibre-effects";
export {
  DECK_VIZ_PLUGIN_ID,
  maplibreDeckGlVizPlugin,
} from "./plugins/maplibre-deckgl-viz";
export { restoreDeckViz } from "./plugins/deckgl-viz/overlay";
export { ensureMercatorProjection } from "./plugins/map-projection-utils";
export {
  DECK_VIZ_CATEGORY_LABELS,
  DEFAULT_DECK_VIZ_SCENEGRAPH,
  DEFAULT_DECK_VIZ_STYLE,
  getDeckVizLayerDef,
  listDeckVizLayerDefs,
  type DeckVizCategory,
  type DeckVizConfig,
  type DeckVizFieldMapping,
  type DeckVizFormat,
  type DeckVizInputKind,
  type DeckVizLayerDef,
  type DeckVizRole,
  type DeckVizScenegraphConfig,
  type DeckVizStyle,
  type DeckVizStyleControl,
} from "./plugins/deckgl-viz/registry";
export {
  createDeckVizStoreLayer,
  DECK_VIZ_SOURCE_KIND,
  isDeckVizLayer,
} from "./plugins/deckgl-viz/store-layer";
export {
  maplibreAnnotationsPlugin,
  ANNOTATIONS_SOURCE_KIND,
  setAnnotationLabels,
  type AnnotationLabels,
} from "./plugins/maplibre-annotations";
export { maplibreEnviroAtlasPlugin } from "./plugins/maplibre-enviroatlas";
export { maplibreEsriWaybackPlugin } from "./plugins/maplibre-esri-wayback";
export { maplibreFemaWmsPlugin } from "./plugins/maplibre-fema-wms";
export {
  maplibreGeoEditorPlugin,
  canEditLayerGeometry,
  SKETCHES_SOURCE_KIND,
  startLayerGeometryEdit,
  endLayerGeometryEdit,
  getGeometryEditTargetLayerId,
  subscribeGeometryEdit,
} from "./plugins/maplibre-geo-editor";
export { maplibreGeoAgentPlugin } from "./plugins/maplibre-geoagent";
export { maplibreUsgsLidarPlugin } from "./plugins/maplibre-usgs-lidar";
export { maplibreNasaEarthdataPlugin } from "./plugins/maplibre-nasa-earthdata";
export { maplibreNationalMapPlugin } from "./plugins/maplibre-national-map";
export { maplibreOvertureMapsPlugin } from "./plugins/maplibre-overture-maps";
export { maplibreStreetViewPlugin } from "./plugins/maplibre-streetview";
export { maplibreSwipePlugin, SWIPE_PLUGIN_ID } from "./plugins/maplibre-swipe";
export {
  maplibreGraticulePlugin,
  GRATICULE_PLUGIN_ID,
  GRATICULE_LABEL_LAYER_ID,
  DEFAULT_GRATICULE_SETTINGS,
  DEFAULT_GRATICULE_LABELS,
  getGraticuleSettings,
  setGraticuleSettings,
  setGraticuleLabels,
  normalizeGraticuleSettings,
  type GraticuleSettings,
  type GraticuleLabels,
  type GraticuleLabelFormat,
  type GraticuleLabelEdges,
} from "./plugins/maplibre-graticule";
export {
  maplibreTimeSliderPlugin,
  TIME_SLIDER_PLUGIN_ID,
  getActiveTimeSliderControl,
  getLayerTimeBinding,
} from "./plugins/maplibre-time-slider";
export {
  bandOptionsFromResults,
  downsampleSteps,
  getTimeSliderCogSources,
  hasTimeSliderRasterStack,
  queryPixelTimeSeries,
  seriesToFeatureCollection,
  valueAtBand,
  type BandOption,
  type LabeledPixelTimeSeries,
  type PixelSeries,
  type PixelSeriesPoint,
  type PixelTimeSeriesOptions,
  type PixelTimeSeriesResult,
} from "./plugins/time-slider-pixel-series";
export {
  buildTimeBinding,
  buildTimeFilter,
  detectTimeProperties,
  type TimeBinding,
  type TimeGranularity,
  type TimePropertyCandidate,
  type TimeValueKind,
  type TimeWindow,
} from "./plugins/time-slider-binding";
export { WEB_SERVICE_PLUGIN_IDS } from "./plugins/web-service-sync";
