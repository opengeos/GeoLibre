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
  | "delimitedText"
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
  "delimited-text": "delimitedText",
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
export const DELIMITED_TEXT_DELIMITERS: Record<
  Exclude<DelimitedTextDelimiter, "custom">,
  string
> = {
  comma: ",",
  pipe: "|",
  semicolon: ";",
  tab: "\t",
};
