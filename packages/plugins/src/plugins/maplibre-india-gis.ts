import type { GeoLibrePlugin } from "../types";
import {
  createArcGisHubPlugin,
  DEFAULT_ARCGIS_HUB_LABELS,
  type ArcGisHubLabels,
} from "./maplibre-arcgis-hub";
import { INDIA_GIS_CATALOGS } from "./india-gis-catalogs";

export const INDIA_GIS_PLUGIN_ID = "geolibre-india-gis";

export const DEFAULT_INDIA_GIS_LABELS: ArcGisHubLabels = {
  ...DEFAULT_ARCGIS_HUB_LABELS,
  hint: "Choose a region, then a portal, to browse open GIS data for India. Add layers to the map or download data.",
  searchPlaceholder: "Search India GIS datasets",
  noResults: "No matching datasets found for this portal.",
  searchError: "Could not list this portal's datasets.",
  catalogSet: "Choose a region",
  catalog: "Portal",
  chooseCatalogSet: "Choose a region, then a portal, to list its GIS data.",
  openPortal: "Open portal",
};

const indiaGis = createArcGisHubPlugin({
  id: INDIA_GIS_PLUGIN_ID,
  name: "India GIS",
  defaultLabels: DEFAULT_INDIA_GIS_LABELS,
  catalogSets: INDIA_GIS_CATALOGS,
  defaultCatalogSetId: "national",
  // Every portal is a short fixed list of GeoJSON datasets, listed whole as
  // soon as it is picked.
  browseWithoutKeyword: true,
  viewOnlyByDefault: false,
  filenameFallback: "india-gis-data",
});

export const maplibreIndiaGisPlugin: GeoLibrePlugin = indiaGis.plugin;
export const setIndiaGisLabels = indiaGis.setLabels;

export default maplibreIndiaGisPlugin;
