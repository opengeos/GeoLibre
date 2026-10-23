import type { GeoLibrePlugin } from "../types";
import { ARCGIS_HUB_SEARCH_TYPES } from "./arcgis-hub-api";
import {
  createArcGisHubPlugin,
  DEFAULT_ARCGIS_HUB_LABELS,
  type ArcGisHubLabels,
} from "./maplibre-arcgis-hub";
import { US_LOCAL_GIS_CATALOGS } from "./us-local-gis-catalogs";

export const US_LOCAL_GIS_PLUGIN_ID = "geolibre-us-local-gis";

// City and county portals publish orthoimagery and basemaps as map and image
// services, which add as raster layers.
const US_LOCAL_GIS_TYPES = [...ARCGIS_HUB_SEARCH_TYPES, "Map Service", "Image Service"];

export const DEFAULT_US_LOCAL_GIS_LABELS: ArcGisHubLabels = {
  ...DEFAULT_ARCGIS_HUB_LABELS,
  hint: "Choose a state, then a city or county, to browse and search its public GIS data portal. Add layers to the map or download data.",
  searchPlaceholder: "Search the portal's GIS data",
  noResults: "No matching datasets found in this portal.",
  searchError: "Could not search this local GIS portal.",
  catalogSet: "Choose a state",
  catalog: "City or county",
  chooseCatalogSet: "Choose a state, then a city or county, to list its GIS data.",
  openPortal: "Open portal",
};

const usLocalGis = createArcGisHubPlugin({
  id: US_LOCAL_GIS_PLUGIN_ID,
  name: "US Local GIS",
  defaultLabels: DEFAULT_US_LOCAL_GIS_LABELS,
  types: US_LOCAL_GIS_TYPES,
  catalogSets: US_LOCAL_GIS_CATALOGS,
  // A portal is listed whole as soon as it is picked, and its layers cover the
  // city or county, so the map-area filter starts off.
  browseWithoutKeyword: true,
  viewOnlyByDefault: false,
  filenameFallback: "local-gis-data",
});

export const maplibreUsLocalGisPlugin: GeoLibrePlugin = usLocalGis.plugin;
export const setUsLocalGisLabels = usLocalGis.setLabels;

export default maplibreUsLocalGisPlugin;
