import type { GeoLibrePlugin } from "../types";
import { ARCGIS_HUB_SEARCH_TYPES, type ArcGisHubItem } from "./arcgis-hub-api";
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

/**
 * Strict India-only filter ensuring no foreign or global datasets leak into the UI.
 *
 * Args:
 *   item: An ArcGIS Hub search result item.
 *
 * Returns:
 *   true if the item is located strictly within India; false otherwise.
 */
export function isIndiaGisItem(item: ArcGisHubItem): boolean {
  // Reject items whose titles explicitly indicate global or foreign geography.
  if (
    /\b(?:world|global|pacific|usa|canada|australia|indonesia|africa|ontario|ohio)\b/i.test(
      item.title,
    )
  ) {
    return false;
  }
  const extent = item.extent;
  if (!Array.isArray(extent) || extent.length !== 2) return true;
  const [[west, south], [east, north]] = extent;
  if (![west, south, east, north].every(Number.isFinite)) return true;

  const width = Math.abs(east - west);
  const height = Math.abs(north - south);
  // Full-globe or hemispheric extents: only keep if the title explicitly mentions India.
  if (width > 60 || height > 45) {
    return /\bindia\b/i.test(item.title);
  }

  // Geographical center of the dataset must fall within the Indian subcontinent (65E-99E, 5.5N-38N).
  const cx = (west + east) / 2;
  const cy = (south + north) / 2;
  return cx >= 65 && cx <= 99 && cy >= 5.5 && cy <= 38;
}

const indiaGis = createArcGisHubPlugin({
  id: INDIA_GIS_PLUGIN_ID,
  name: "India GIS",
  defaultLabels: DEFAULT_INDIA_GIS_LABELS,
  types: INDIA_GIS_TYPES,
  catalogSets: INDIA_GIS_CATALOGS,
  defaultCatalogSetId: "national",
  itemFilter: isIndiaGisItem,
  browseWithoutKeyword: true,
  viewOnlyByDefault: false,
  filenameFallback: "india-gis-data",
});

export const maplibreIndiaGisPlugin: GeoLibrePlugin = indiaGis.plugin;
export const setIndiaGisLabels = indiaGis.setLabels;

export default maplibreIndiaGisPlugin;
