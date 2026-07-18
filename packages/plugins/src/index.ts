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
// Public so hosts and plugins that ship their own panel-like registries can
// reuse the title-resolve-or-fallback + per-id warning-dedup behavior instead
// of re-implementing (and drifting from) it.
export { PanelTitleResolver } from "./panel-title";
export { maplibreLayerControlPlugin } from "./plugins/layer-control";
export { osmBasemapPlugin } from "./plugins/osm-basemap";
export { cartoLightPlugin } from "./plugins/carto-light";
export {
  maplibreBasemapControlPlugin,
  BASEMAP_CONTROL_PLUGIN_ID,
  getActiveBasemapControl,
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
  openLegendPanelWithItems,
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
  openLocalNetcdf,
  buildInlineZarrRefs,
  type LocalNetcdfFile,
  type LocalNetcdfVariable,
  type LocalNetcdfLayerRefs,
  type InlineZarrGrid,
} from "./plugins/local-netcdf";
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
  RASTER_MAX_STORED_CLASSES,
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
export { RASTER_SOURCE_KIND, getRasterBandStats } from "./plugins/raster-symbology-texture";
export {
  disposeAllPaletteLegends,
  disposePaletteLegend,
  extractPaletteLegend,
  getPaletteLegend,
  type PaletteLegendEntry,
} from "./plugins/raster-palette";
export { colormapColors, warmColormapColors } from "./plugins/colormap-colors";
export { setTerrainMeasureLabels } from "./plugins/terrain-measure";
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
  type DirectionsRouteLegMetric,
  type DirectionsRouteMetrics,
  DIRECTIONS_PLUGIN_ID,
  getDirectionsRouteMetrics,
  getDirectionsWaypointCount,
  isDirectionsRemovalInFlight,
  isDirectionsRouteLoading,
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
  advanceSunClock,
  closeSunPanel,
  DEFAULT_SUN_SETTINGS,
  getSunSettings,
  getSunSettingsSnapshot,
  isSunPanelVisible,
  localDayStart,
  maplibreSunPlugin,
  normalizeSunSettings,
  openSunPanel,
  reattachSun,
  restoreSun,
  setSunSettings,
  SUN_PLUGIN_ID,
  SUN_SHADE_MAX,
  SUN_SHADE_MIN,
  SUN_SPEED_MAX,
  SUN_SPEED_MIN,
  type SunSettings,
  subsolarPoint,
  subscribeSunPanel,
  subscribeSunSettings,
  sunEquatorialPosition,
  sunPositionAt,
} from "./plugins/maplibre-sun";
export { DECK_VIZ_PLUGIN_ID, maplibreDeckGlVizPlugin } from "./plugins/maplibre-deckgl-viz";
export { restoreDeckViz } from "./plugins/deckgl-viz/overlay";
export { countAtlasDroppedDiagrams } from "./plugins/deckgl-viz/diagrams";
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
  GEO_EDITOR_PLUGIN_ID,
  canEditLayerGeometry,
  SKETCHES_SOURCE_KIND,
  startLayerGeometryEdit,
  endLayerGeometryEdit,
  getGeometryEditTargetLayerId,
  subscribeGeometryEdit,
  isGeoEditorAvailableForImport,
  getGeoEditorFeatureCount,
  hasViewImportBaseline,
  loadViewFeaturesIntoEditor,
  buildEditorSaveCollection,
} from "./plugins/maplibre-geo-editor";
export {
  listViewVectorLayers,
  resolveStoreLayerViewSource,
  queryViewLayerFeatures,
  VIEW_IMPORT_ID_PROPERTY,
  VIEW_IMPORT_CHANGE_PROPERTY,
  type ViewVectorLayer,
  type ViewImportMap,
  type ViewImportExport,
  type ViewImportChangeCounts,
} from "./plugins/geo-editor-view-import";
export { maplibreGeoAgentPlugin } from "./plugins/maplibre-geoagent";
export { maplibreUsgsLidarPlugin } from "./plugins/maplibre-usgs-lidar";
export { maplibreNasaEarthdataPlugin } from "./plugins/maplibre-nasa-earthdata";
export {
  DEFAULT_OPENAERIALMAP_LABELS,
  maplibreOpenAerialMapPlugin,
  OPENAERIALMAP_PLUGIN_ID,
  setOpenAerialMapLabels,
  type OpenAerialMapLabels,
} from "./plugins/maplibre-openaerialmap";
export {
  buildSearchUrl,
  buildTitilerTemplate,
  OAM_DEFAULT_ENDPOINT,
  parseSearchResponse,
  searchOpenAerialMap,
  type OamImage,
  type OamSearchResult,
  type OpenAerialMapSearchOptions,
} from "./plugins/openaerialmap-api";
export {
  DEFAULT_SOURCE_COOP_LABELS,
  maplibreNaturalEarthPlugin,
  maplibreSourceCoopPlugin,
  NATURAL_EARTH_PLUGIN_ID,
  setSourceCoopLabels,
  SOURCE_COOP_PLUGIN_ID,
  type SourceCoopLabels,
  type SourceCoopPinnedProduct,
} from "./plugins/maplibre-source-coop";
export {
  buildListObjectsUrl,
  buildObjectUrl,
  classifyKey,
  fetchCatalog,
  filterProducts,
  formatBytes,
  isAddable,
  listProductObjects,
  parseFeed,
  parseListObjects,
  parseProduct,
  parseProductList,
  parseProductRef,
  productUrl,
  SOURCE_COOP_DATA_BASE,
  SOURCE_COOP_PROXY_ENDPOINT,
  synthesizeProduct,
  type SourceCoopFormat,
  type SourceCoopListing,
  type SourceCoopObject,
  type SourceCoopProduct,
} from "./plugins/source-coop-api";
export { maplibreNationalMapPlugin } from "./plugins/maplibre-national-map";
export { maplibreOvertureMapsPlugin } from "./plugins/maplibre-overture-maps";
export { maplibreStreetViewPlugin } from "./plugins/maplibre-streetview";
export {
  maplibreMapillaryPlugin,
  MAPILLARY_PLUGIN_ID,
  setMapillaryLabels,
  type MapillaryLabels,
} from "./plugins/maplibre-mapillary";
export {
  maplibreElevationProfilePlugin,
  ELEVATION_PROFILE_PLUGIN_ID,
} from "./plugins/elevation-profile";
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
export type { WeatherAnimationState, WeatherLayerController } from "./plugins/weather-layer";
export {
  maplibreCloudsPlugin,
  CLOUDS_PLUGIN_ID,
  getCloudsAnimationState,
  setCloudsFrame,
  toggleCloudsPlaying,
  subscribeClouds,
} from "./plugins/maplibre-clouds";
export {
  maplibrePrecipitationPlugin,
  PRECIPITATION_PLUGIN_ID,
  getPrecipitationAnimationState,
  setPrecipitationFrame,
  togglePrecipitationPlaying,
  subscribePrecipitation,
} from "./plugins/maplibre-precipitation";
export {
  maplibreTimeSliderPlugin,
  TIME_SLIDER_PLUGIN_ID,
  getActiveTimeSliderControl,
  getLayerTimeBinding,
} from "./plugins/maplibre-time-slider";
export {
  DEFAULT_TIMELAPSE_LABELS,
  getActiveTimelapseControl,
  maplibreTimelapsePlugin,
  recordTimelapseCycle,
  setTimelapseLabels,
  setTimelapseVideoSaver,
  TIMELAPSE_PANEL_ID,
  TIMELAPSE_PLUGIN_ID,
  TIMELAPSE_SOURCE_KIND,
  timelapseStoreLayerId,
  TimelapseControl,
  TimelapseVideoUnsupportedError,
  type RecordTimelapseCycleOptions,
  type TimelapseLabels,
  type TimelapseRecording,
  type TimelapseVideoSaver,
} from "./plugins/maplibre-timelapse";
export {
  eoxS2CloudlessProvider,
  EOX_S2CLOUDLESS_PROVIDER_ID,
  getTimelapseProvider,
  listTimelapseProviders,
  MODIS_LANDCOVER_PROVIDER_ID,
  modisLandCoverProvider,
  NASA_GIBS_WELD_NDVI_PROVIDER_ID,
  NASA_GIBS_WELD_PROVIDER_ID,
  nasaGibsWeldNdviProvider,
  nasaGibsWeldProvider,
  registerTimelapseProvider,
  type TimelapseFrame,
  type TimelapseLegendItem,
  type TimelapseProvider,
} from "./plugins/timelapse-providers";
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
export {
  DEFAULT_ROUTE_ANIMATION_SETTINGS,
  ROUTE_ANIM_SPEED_MAX,
  ROUTE_ANIM_SPEED_MIN,
  ROUTE_ANIMATION_PLUGIN_ID,
  ROUTE_FOLLOW_PITCH_MAX,
  ROUTE_FOLLOW_PITCH_MIN,
  ROUTE_FOLLOW_ZOOM_MAX,
  ROUTE_FOLLOW_ZOOM_MIN,
  ROUTE_MARKER_STYLES,
  ROUTE_VIDEO_FPS,
  ROUTE_VIDEO_MIME_CANDIDATES,
  RouteVideoUnsupportedError,
  closeRouteAnimationPanel,
  getRouteAnimationDurationSeconds,
  getRouteAnimationSettings,
  getRouteAnimationSnapshot,
  isRouteAnimationPanelVisible,
  isRouteVideoSupported,
  maplibreRouteAnimationPlugin,
  normalizeRouteAnimationSettings,
  openRouteAnimationPanel,
  pickRouteVideoMimeType,
  pickVideoMimeType,
  reattachRouteAnimation,
  recordRouteAnimation,
  restoreRouteAnimation,
  setRouteAnimationElevation,
  setRouteAnimationProgress,
  setRouteAnimationRoute,
  setRouteAnimationSettings,
  subscribeRouteAnimation,
  subscribeRouteAnimationPanel,
  toggleRouteAnimationPlaying,
  videoExtensionForMime,
  type RecordRouteAnimationOptions,
  type RouteAnimationRecording,
  type RouteAnimationSettings,
  type RouteElevationConfig,
  type RouteMarkerStyle,
} from "./plugins/maplibre-route-animation";
export {
  bearingBetween,
  flattenToLine,
  flattenToRoute,
  measureLine,
  pointAlongLine,
  sliceLineAtDistance,
  sliceRouteAtDistance,
  type PointOnLine,
  type RouteWithElevation,
} from "./plugins/route-animation-geometry";
