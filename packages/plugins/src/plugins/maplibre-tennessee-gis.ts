import type { GeoLibrePlugin } from "../types";
import { ARCGIS_HUB_SEARCH_TYPES, fetchArcGisHubSiteGroups } from "./arcgis-hub-api";
import {
  createArcGisHubPlugin,
  DEFAULT_ARCGIS_HUB_LABELS,
  type ArcGisHubLabels,
} from "./maplibre-arcgis-hub";

export const TENNESSEE_GIS_PLUGIN_ID = "geolibre-tennessee-gis";
/** The State of Tennessee's downloadable GIS data portal, an ArcGIS Hub site. */
export const TENNESSEE_GIS_PORTAL_URL = "https://geodata.tn.gov";
/** The portal item behind geodata.tn.gov; its data lists the catalog groups. */
export const TENNESSEE_GIS_SITE_ID = "4649b629c9b647a8822b052cadc89072";
/**
 * The site's catalog groups as of September 2026. Used only when the live site
 * item cannot be read, so the panel keeps working through an ArcGIS Online
 * hiccup; the live list wins whenever it loads, so catalog edits on the state's
 * side are picked up without a release.
 */
export const TENNESSEE_GIS_CATALOG_GROUPS = [
  "679309d9cf42408d86ab2d2af89c369a",
  "76d68999556b4897a78370d93da9418b",
  "b17b6f40fda346d582055b867926cb19",
  "923bcb2b45c247329973187a01b198ca",
  "752c1757994d4aebad93dc2587ad6710",
  "e46d150ec8a14b97bcb07f68d7085ccc",
  "c7be394198944691a77091e2c9269c8b",
  "815a6619ee11482e937291b1e1318f1b",
  "f191947417a649aeb3719d1844660619",
] as const;

// The portal also publishes a few map and image services (e.g. statewide
// imagery), which add as raster layers.
const TENNESSEE_GIS_TYPES = [...ARCGIS_HUB_SEARCH_TYPES, "Map Service", "Image Service"];

export const DEFAULT_TENNESSEE_GIS_LABELS: ArcGisHubLabels = {
  ...DEFAULT_ARCGIS_HUB_LABELS,
  hint: "Browse and search public GIS data from the State of Tennessee (geodata.tn.gov). Add layers to the map or download data.",
  searchPlaceholder: "Search Tennessee GIS data",
  noResults: "No matching Tennessee datasets found.",
  searchError: "Could not search the Tennessee GIS portal.",
};

/**
 * Resolve the portal's catalog groups, falling back to the bundled snapshot.
 *
 * Args:
 *   signal: Aborts the site lookup.
 *
 * Returns:
 *   The group ids that define the geodata.tn.gov catalog.
 */
async function resolveTennesseeGroups(signal: AbortSignal): Promise<readonly string[]> {
  try {
    const groups = await fetchArcGisHubSiteGroups(TENNESSEE_GIS_SITE_ID, undefined, signal);
    if (groups.length > 0) return groups;
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    console.warn("Could not read the Tennessee GIS catalog; using the bundled list.", error);
  }
  return TENNESSEE_GIS_CATALOG_GROUPS;
}

const tennesseeGis = createArcGisHubPlugin({
  id: TENNESSEE_GIS_PLUGIN_ID,
  name: "Tennessee GIS",
  defaultLabels: DEFAULT_TENNESSEE_GIS_LABELS,
  pageUrl: TENNESSEE_GIS_PORTAL_URL,
  types: TENNESSEE_GIS_TYPES,
  resolveGroups: resolveTennesseeGroups,
  // ~100 datasets: small enough to list whole, and statewide layers rarely
  // match a view that is not already over Tennessee.
  browseWithoutKeyword: true,
  viewOnlyByDefault: false,
  filenameFallback: "tennessee-gis-data",
});

export const maplibreTennesseeGisPlugin: GeoLibrePlugin = tennesseeGis.plugin;
export const setTennesseeGisLabels = tennesseeGis.setLabels;

export default maplibreTennesseeGisPlugin;
