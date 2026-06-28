/**
 * Constants and default values shared across the Add Data dialog sources.
 */

import type { ArcGISLayerType } from "@geolibre/plugins";
import type {
  AddDataKind,
  DelimitedTextDelimiter,
} from "./types";

// ~10 MB; deck-viz data is stored inline in the project file, so warn (but do
// not block) when a very large payload would bloat saved projects.
export const DECK_VIZ_SIZE_WARN_BYTES = 10 * 1024 * 1024;

/** The `addData.kind.<key>` segments, kept as a literal union so the dialog's
 * `t(\`addData.kind.${key}.label\`)` lookups stay type-checked against en.json. */
export type KindI18nKey =
  | "xyz"
  | "wms"
  | "wfs"
  | "wmts"
  | "gpx"
  | "georss"
  | "delimitedText"
  | "cad"
  | "photos"
  | "mbtiles"
  | "arcgis"
  | "postgres"
  | "deckglViz"
  | "video";

/**
 * Maps each Add Data kind to its `addData.kind.<key>` i18n segment. The dialog
 * title and description are resolved via `t()` from these keys; `en.json` is the
 * source of truth (see `i18n/locales/en.json`).
 */
export const KIND_I18N_KEY: Record<AddDataKind, KindI18nKey> = {
  xyz: "xyz",
  wms: "wms",
  wfs: "wfs",
  wmts: "wmts",
  gpx: "gpx",
  georss: "georss",
  "delimited-text": "delimitedText",
  cad: "cad",
  photos: "photos",
  mbtiles: "mbtiles",
  arcgis: "arcgis",
  postgres: "postgres",
  "deckgl-viz": "deckglViz",
  video: "video",
};

export const DEFAULT_XYZ_URL =
  "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}";
export const DEFAULT_WMS_ENDPOINT =
  "https://imagery.nationalmap.gov/arcgis/services/USGSNAIPImagery/ImageServer/WMSServer";
export const DEFAULT_WMS_LAYERS = "USGSNAIPImagery:FalseColorComposite";
export const DEFAULT_WFS_ENDPOINT = "https://ahocevar.com/geoserver/wfs";
export const DEFAULT_WFS_TYPE_NAME = "topp:states";
export const DEFAULT_WMTS_URL =
  "https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/119/{z}/{y}/{x}";
export const DEFAULT_GPX_URL =
  "https://data.source.coop/giswqs/opengeos/fells_loop.gpx";
// USGS "Magnitude 2.5+ Earthquakes, Past Day" Atom feed (Simple georss:point).
export const DEFAULT_GEORSS_URL =
  "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.atom";
export const DEFAULT_DELIMITED_TEXT_URL =
  "https://data.source.coop/giswqs/opengeos/us_cities.csv";
export const DEFAULT_DELIMITED_TEXT_LATITUDE_FIELD = "latitude";
export const DEFAULT_DELIMITED_TEXT_LONGITUDE_FIELD = "longitude";
// MapLibre's "Add a video" sample (a drone clip over San Francisco), pre-filled
// so the dialog works out of the box. The corners are [lng, lat] pairs.
export const DEFAULT_VIDEO_MP4_URL =
  "https://static-assets.mapbox.com/mapbox-gl-js/drone.mp4";
export const DEFAULT_VIDEO_WEBM_URL =
  "https://static-assets.mapbox.com/mapbox-gl-js/drone.webm";
export const DEFAULT_VIDEO_TOP_LEFT = "-122.51596391201019, 37.56238816766053";
export const DEFAULT_VIDEO_TOP_RIGHT = "-122.51467645168304, 37.56410183312965";
export const DEFAULT_VIDEO_BOTTOM_RIGHT =
  "-122.51309394836426, 37.563391708549425";
export const DEFAULT_VIDEO_BOTTOM_LEFT =
  "-122.51423120498657, 37.56161849366671";
export const DEFAULT_ARCGIS_FEATURE_URL =
  "https://services3.arcgis.com/GVgbJbqm8hXASVYi/arcgis/rest/services/USA_Major_Cities/FeatureServer/0";
export const DEFAULT_ARCGIS_VECTOR_TILE_URL =
  "https://vectortileservices3.arcgis.com/GVgbJbqm8hXASVYi/arcgis/rest/services/Santa_Monica_parcels_VTL/VectorTileServer";
export const DEFAULT_ARCGIS_URLS: Record<ArcGISLayerType, string> = {
  feature: DEFAULT_ARCGIS_FEATURE_URL,
  "vector-tile": DEFAULT_ARCGIS_VECTOR_TILE_URL,
};
// Keep in sync with GPX_PROXY_PATH in vite.config.ts (the dev proxy binds it there).
export const GPX_PROXY_PATH = "/__geolibre_gpx_proxy";
export const POSTGRES_CONNECTIONS_STORAGE_KEY =
  "geolibre.postgres.connectionStrings";
export const MAX_SAVED_POSTGRES_CONNECTIONS = 10;
// Cross-project catalog of reusable web-service layer definitions (see
// service-library.ts). Bumping the key would orphan a user's saved services.
export const SERVICE_LIBRARY_STORAGE_KEY = "geolibre.serviceLibrary";
export const MAX_SAVED_SERVICES = 200;
// A short list of common coordinate systems offered as quick presets in the Add
// CAD Layer dialog (CAD files carry no CRS of their own, so the user names one).
// The labels are CRS proper names and stay untranslated; selecting one fills the
// free-text EPSG field, which remains the source of truth.
export const CAD_CRS_PRESETS: readonly { label: string; value: string }[] = [
  { label: "WGS 84 (EPSG:4326)", value: "EPSG:4326" },
  { label: "Web Mercator (EPSG:3857)", value: "EPSG:3857" },
  { label: "NAD83 (EPSG:4269)", value: "EPSG:4269" },
  { label: "NAD83 / UTM zone 15N (EPSG:26915)", value: "EPSG:26915" },
  { label: "NAD83 / Conus Albers (EPSG:5070)", value: "EPSG:5070" },
  { label: "British National Grid (EPSG:27700)", value: "EPSG:27700" },
  { label: "ETRS89 / UTM zone 32N (EPSG:25832)", value: "EPSG:25832" },
];

// Sample CAD drawings offered in the Add CAD Layer dialog's "Load sample data"
// dropdown. Each is a recognizable dataset written in a known CRS (CAD carries
// none), so selecting one fetches the file and pre-fills the matching EPSG; a
// blank `crs` loads the drawing as-is (already lon/lat). Hosted on Source
// Cooperative alongside the other GeoLibre samples.
export const CAD_SAMPLES: readonly {
  label: string;
  url: string;
  crs: string;
}[] = [
  {
    label: "US states (Albers, EPSG:5070)",
    url: "https://data.source.coop/giswqs/opengeos/us_states_albers_5070.dxf",
    crs: "EPSG:5070",
  },
  {
    label: "NYC boroughs (State Plane, EPSG:2263)",
    url: "https://data.source.coop/giswqs/opengeos/nyc_boroughs_stateplane_2263.dxf",
    crs: "EPSG:2263",
  },
  {
    label: "World populated places (WGS84)",
    url: "https://data.source.coop/giswqs/opengeos/ne_populated_places_wgs84.dxf",
    crs: "",
  },
];

export const DELIMITED_TEXT_DELIMITERS: Record<
  Exclude<DelimitedTextDelimiter, "custom">,
  string
> = {
  comma: ",",
  pipe: "|",
  semicolon: ";",
  tab: "\t",
};
