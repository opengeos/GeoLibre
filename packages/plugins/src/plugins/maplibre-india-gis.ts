import type { GeoLibrePlugin } from "../types";
import { ARCGIS_HUB_SEARCH_TYPES } from "./arcgis-hub-api";
import {
  createArcGisHubPlugin,
  DEFAULT_ARCGIS_HUB_LABELS,
  type ArcGisHubLabels,
} from "./maplibre-arcgis-hub";
import { INDIA_GIS_CATALOGS } from "./india-gis-catalogs";

export const INDIA_GIS_PLUGIN_ID = "geolibre-india-gis";

// India geospatial portals publish map services, feature services, and image services
// (administrative boundaries, LULC, flood zones, urban sprawl, Smart Cities data).
const INDIA_GIS_TYPES = [
  ...ARCGIS_HUB_SEARCH_TYPES,
  "Map Service",
  "Image Service",
  "Feature Service",
];

export const DEFAULT_INDIA_GIS_LABELS: ArcGisHubLabels = {
  ...DEFAULT_ARCGIS_HUB_LABELS,
  hint: "Choose a state or national portal to browse and search public GIS data in India. Add layers to the map or download data.",
  searchPlaceholder: "Search India GIS datasets",
  noResults: "No matching datasets found in this Indian portal.",
  searchError: "Could not search this Indian GIS portal.",
  catalogSet: "Choose a state or national portal",
  catalog: "Portal",
  chooseCatalogSet: "Choose an Indian state or national portal to list its GIS data.",
  openPortal: "Open portal",
};

const indiaGis = createArcGisHubPlugin({
  id: INDIA_GIS_PLUGIN_ID,
  name: "India GIS",
  defaultLabels: DEFAULT_INDIA_GIS_LABELS,
  types: INDIA_GIS_TYPES,
  catalogSets: INDIA_GIS_CATALOGS,
  browseWithoutKeyword: true,
  viewOnlyByDefault: false,
  filenameFallback: "india-gis-data",
});

export const maplibreIndiaGisPlugin: GeoLibrePlugin = indiaGis.plugin;
export const setIndiaGisLabels = indiaGis.setLabels;

export default maplibreIndiaGisPlugin;
