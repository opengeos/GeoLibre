import type { GeoLibrePlugin } from "../types";
import { ARCGIS_HUB_SEARCH_TYPES } from "./arcgis-hub-api";
import {
  createArcGisHubPlugin,
  DEFAULT_ARCGIS_HUB_LABELS,
  type ArcGisHubLabels,
} from "./maplibre-arcgis-hub";
import { US_FEDERAL_GIS_CATALOGS } from "./us-federal-gis-catalogs";

export const US_FEDERAL_GIS_PLUGIN_ID = "geolibre-us-federal-gis";

// Federal agencies publish much of their national data as map and image
// services (NOAA radar, LANDFIRE and land cover rasters, NAIP), which add as
// raster layers.
const US_FEDERAL_GIS_TYPES = [...ARCGIS_HUB_SEARCH_TYPES, "Map Service", "Image Service"];

export const DEFAULT_US_FEDERAL_GIS_LABELS: ArcGisHubLabels = {
  ...DEFAULT_ARCGIS_HUB_LABELS,
  hint: "Choose a department, then an agency, to browse and search its public GIS data. Add layers to the map or download data.",
  searchPlaceholder: "Search the agency's GIS data",
  noResults: "No matching datasets found for this agency.",
  searchError: "Could not search this federal GIS portal.",
  catalogSet: "Choose a department",
  catalog: "Agency",
  chooseCatalogSet: "Choose a department, then an agency, to list its GIS data.",
  openPortal: "Open portal",
};

const usFederalGis = createArcGisHubPlugin({
  id: US_FEDERAL_GIS_PLUGIN_ID,
  name: "US Federal GIS",
  defaultLabels: DEFAULT_US_FEDERAL_GIS_LABELS,
  types: US_FEDERAL_GIS_TYPES,
  catalogSets: US_FEDERAL_GIS_CATALOGS,
  // An agency is listed whole as soon as it is picked, and its layers are
  // mostly national, so the map-area filter starts off.
  browseWithoutKeyword: true,
  viewOnlyByDefault: false,
  filenameFallback: "federal-gis-data",
});

export const maplibreUsFederalGisPlugin: GeoLibrePlugin = usFederalGis.plugin;
export const setUsFederalGisLabels = usFederalGis.setLabels;

export default maplibreUsFederalGisPlugin;
