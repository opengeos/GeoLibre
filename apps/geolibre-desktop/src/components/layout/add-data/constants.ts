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

export const KIND_LABELS: Record<AddDataKind, string> = {
  xyz: "Add XYZ Layer",
  wms: "Add WMS Layer",
  wfs: "Add WFS Layer",
  wmts: "Add WMTS Layer",
  gpx: "Add GPX Layer",
  "delimited-text": "Add Delimited Text Layer",
  mbtiles: "Add MBTiles Layer",
  arcgis: "Add ArcGIS Layer",
  postgres: "Add PostgreSQL Layer",
  "deckgl-viz": "Add Deck.gl Layer",
  video: "Add Video Layer",
};

export const KIND_DESCRIPTIONS: Record<AddDataKind, string> = {
  xyz: "Add a raster tile template using x, y, and z placeholders.",
  wms: "Add a WMS GetMap service as a tiled raster layer.",
  wfs: "Add WFS features by requesting GeoJSON from a GetFeature service.",
  wmts: "Add a WMTS tile URL template as a raster layer.",
  gpx: "Add GPX waypoints, routes, and tracks as one or more vector layers.",
  "delimited-text":
    "Add a delimited text file or URL as a point layer using longitude and latitude fields.",
  mbtiles: "Add a local MBTiles file as a raster or vector tile layer.",
  arcgis:
    "Add an ArcGIS FeatureServer layer, VectorTileServer layer, or portal item.",
  postgres:
    "Start Martin locally, discover PostGIS sources, and add a source as vector tiles.",
  video:
    "Add a georeferenced video overlay by supplying an MP4 URL and four corner coordinates.",
  "deckgl-viz":
    "Pick a deck.gl layer type, then load the example data or upload a CSV/JSON/GeoJSON file or URL.",
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
