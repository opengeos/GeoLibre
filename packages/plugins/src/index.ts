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
  closeColorbarPanel,
  closeHtmlPanel,
  closeLegendPanel,
  closeMaplibreComponentControls,
  closeSearchPlacesPanel,
  isColorbarPanelVisible,
  isHtmlPanelVisible,
  isLegendPanelVisible,
  isSearchPlacesPanelVisible,
  maplibreComponentsPlugin,
  openFlatGeobufAddVectorLayerPanel,
  openColorbarPanel,
  openHtmlPanel,
  openLegendPanel,
  openLidarLayerPanel,
  openPMTilesLayerPanel,
  openSearchPlacesPanel,
  openSplattingLayerPanel,
  openStacSearchLayerPanel,
  openZarrLayerPanel,
  subscribeColorbarPanel,
  subscribeHtmlPanel,
  subscribeLegendPanel,
  subscribeSearchPlacesPanel,
  type CogRasterLayerOptions,
} from "./plugins/maplibre-components";
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
  closeGeoParquetLayerPanel,
  openGeoParquetLayerPanel,
} from "./plugins/maplibre-geoparquet";
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
  closeRasterLayerPanel,
  openRasterLayerPanel,
  restoreRasterLayers,
} from "./plugins/maplibre-raster";
// The raster-layer-sync internals are not re-exported: the app drives the
// panel through the two functions above, and the tests import the sync
// helpers from the module path directly.
export { maplibreEsriWaybackPlugin } from "./plugins/maplibre-esri-wayback";
export { maplibreGeoEditorPlugin } from "./plugins/maplibre-geo-editor";
export { maplibreGeoAgentPlugin } from "./plugins/maplibre-geoagent";
export { maplibreLidarPlugin } from "./plugins/maplibre-lidar";
export { maplibreStreetViewPlugin } from "./plugins/maplibre-streetview";
export { maplibreSwipePlugin } from "./plugins/maplibre-swipe";
export {
  sampleGeoJsonPlugin,
  setSampleGeoJson,
} from "./plugins/sample-geojson";
