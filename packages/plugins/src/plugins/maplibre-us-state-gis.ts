import type { GeoLibrePlugin } from "../types";
import { ARCGIS_HUB_SEARCH_TYPES } from "./arcgis-hub-api";
import {
  createArcGisHubPlugin,
  DEFAULT_ARCGIS_HUB_LABELS,
  type ArcGisHubLabels,
} from "./maplibre-arcgis-hub";
import { US_STATE_GIS_CATALOGS } from "./us-state-gis-catalogs";

export const US_STATE_GIS_PLUGIN_ID = "geolibre-us-state-gis";

// State portals publish statewide imagery and basemaps as map and image
// services, which add as raster layers.
const US_STATE_GIS_TYPES = [...ARCGIS_HUB_SEARCH_TYPES, "Map Service", "Image Service"];

export const DEFAULT_US_STATE_GIS_LABELS: ArcGisHubLabels = {
  ...DEFAULT_ARCGIS_HUB_LABELS,
  hint: "Choose a state to browse and search its public GIS data portal. Add layers to the map or download data.",
  searchPlaceholder: "Search the state's GIS data",
  noResults: "No matching datasets found in this portal.",
  searchError: "Could not search this state GIS portal.",
  catalogSet: "Choose a state",
  catalog: "Portal",
  chooseCatalogSet: "Choose a state to list its GIS data.",
  openPortal: "Open portal",
};

const usStateGis = createArcGisHubPlugin({
  id: US_STATE_GIS_PLUGIN_ID,
  name: "US State GIS",
  defaultLabels: DEFAULT_US_STATE_GIS_LABELS,
  types: US_STATE_GIS_TYPES,
  catalogSets: US_STATE_GIS_CATALOGS,
  // A state catalog is listed whole as soon as it is picked, and its layers are
  // mostly statewide, so the map-area filter starts off.
  browseWithoutKeyword: true,
  viewOnlyByDefault: false,
  filenameFallback: "state-gis-data",
});

export const maplibreUsStateGisPlugin: GeoLibrePlugin = usStateGis.plugin;
export const setUsStateGisLabels = usStateGis.setLabels;

export default maplibreUsStateGisPlugin;
