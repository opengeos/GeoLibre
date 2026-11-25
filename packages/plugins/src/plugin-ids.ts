// Plugin ids kept apart from the plugin implementations that use them.
//
// `VIEWER_BLOCKED_PLUGIN_IDS` has to name plugins without pulling their code
// in: `maplibre-geoagent.ts` imports `maplibre-gl-earth-engine`, which touches
// `window` at module load, so importing the plugin module just to read a string
// would make the blocklist — and every test of it — browser-only. Each plugin
// module imports its id from here and re-exports it, so the id a plugin
// registers under and the id the viewer guard blocks are the same binding and
// cannot drift.

/** The geometry editor: vertex and geometry editing handles on the map. */
export const GEO_EDITOR_PLUGIN_ID = "maplibre-gl-geo-editor";

/** Annotations: the drawing toolbar (text, pin, note, arrow, freehand, …). */
export const ANNOTATIONS_PLUGIN_ID = "maplibre-gl-annotations";

/** Dimensions: CAD/ArcGIS-Pro-style linear/aligned/angular dimension lines. */
export const DIMENSIONS_PLUGIN_ID = "maplibre-gl-dimensions";

/** GeoAgent: the AI chat control, whose results sync into the store. */
export const GEOAGENT_PLUGIN_ID = "maplibre-gl-geoagent";

export const LAYER_CONTROL_PLUGIN_ID = "maplibre-layer-control";

export const USGS_NLDI_PLUGIN_ID = "maplibre-usgs-nldi";

export const USGS_DEM_PLUGIN_ID = "maplibre-gl-usgs-dem";

export const VANTOR_PLUGIN_ID = "maplibre-gl-vantor";

export const PLANET_OPEN_DATA_PLUGIN_ID = "geolibre-planet-open-data";

export const PORTOLAN_PLUGIN_ID = "geolibre-portolan";

export const EARTHDATA_GIS_PLUGIN_ID = "maplibre-gl-earthdata-gis";

export const EARTHACCESS_PLUGIN_ID = "geolibre-earthaccess";

export const OPENAERIALMAP_PLUGIN_ID = "maplibre-gl-openaerialmap";

export const OSM_DOWNLOADER_PLUGIN_ID = "geolibre-osm-downloader";

export const IGN_LIDAR_HD_PLUGIN_ID = "geolibre-ign-lidar-hd";

export const ARCGIS_PORTAL_PLUGIN_ID = "geolibre-arcgis-portal";

export const ARCGIS_HUB_PLUGIN_ID = "maplibre-gl-arcgis-hub";

export const TENNESSEE_GIS_PLUGIN_ID = "geolibre-tennessee-gis";

export const US_FEDERAL_GIS_PLUGIN_ID = "geolibre-us-federal-gis";

export const US_STATE_GIS_PLUGIN_ID = "geolibre-us-state-gis";

export const US_LOCAL_GIS_PLUGIN_ID = "geolibre-us-local-gis";

export const INDIA_GIS_PLUGIN_ID = "geolibre-india-gis";

export const SOCRATA_PLUGIN_ID = "maplibre-gl-socrata";

export const CKAN_PLUGIN_ID = "maplibre-gl-ckan";

export const STAC_PLUGIN_ID = "geolibre-stac-catalogs";

export const SOURCE_COOP_PLUGIN_ID = "maplibre-gl-source-coop";

export const S3_BROWSER_PLUGIN_ID = "geolibre-s3-browser";

export const NATURAL_EARTH_PLUGIN_ID = "maplibre-gl-natural-earth";

export const HUGGINGFACE_PLUGIN_ID = "maplibre-gl-huggingface";

export const SATELLITE_EMBEDDINGS_PLUGIN_ID = "geolibre-satellite-embeddings";

export const FIELDS_OF_THE_WORLD_PLUGIN_ID = "geolibre-fields-of-the-world";

export const SENTINEL2_EXPLORER_PLUGIN_ID = "geolibre-sentinel2-explorer";

export const OCEAN_DATA_PLATFORM_PLUGIN_ID = "geolibre-ocean-data-platform";

export const DYNAMICAL_PLUGIN_ID = "geolibre-dynamical";

export const JAXA_EARTH_PLUGIN_ID = "geolibre-jaxa-earth";

export const GEOLENS_PLUGIN_ID = "maplibre-gl-geolens";

export const MAPILLARY_PLUGIN_ID = "maplibre-gl-mapillary";

export const H3_PLUGIN_ID = "maplibre-h3-grid";

export const S2_PLUGIN_ID = "maplibre-s2-grid";

export const A5_PLUGIN_ID = "maplibre-a5-grid";

export const DGGRID_PLUGIN_ID = "maplibre-dggrid";

export const DGGAL_PLUGIN_ID = "maplibre-dggal";

export const OLC_PLUGIN_ID = "maplibre-olc";

export const GEOHASH_PLUGIN_ID = "maplibre-geohash";

export const TILECODE_PLUGIN_ID = "maplibre-tilecode";

export const BASEMAP_CONTROL_PLUGIN_ID = "maplibre-gl-basemap-control";

export const TIME_SLIDER_PLUGIN_ID = "maplibre-gl-time-slider";

export const TIMELAPSE_PLUGIN_ID = "geolibre-timelapse";

export const ELEVATION_PROFILE_PLUGIN_ID = "geolibre-elevation-profile";

export const SWIPE_PLUGIN_ID = "maplibre-gl-swipe";

export const GRATICULE_PLUGIN_ID = "maplibre-gl-graticule";

export const CLOUDS_PLUGIN_ID = "maplibre-gl-clouds";

export const PRECIPITATION_PLUGIN_ID = "maplibre-gl-precipitation";

export const EFFECTS_PLUGIN_ID = "maplibre-atmosphere-effects";

export const SUN_PLUGIN_ID = "geolibre-sun";

export const ROUTE_ANIMATION_PLUGIN_ID = "geolibre-route-animation";

export const FLIGHT_SIMULATOR_PLUGIN_ID = "geolibre-flight-simulator";

export const GODS_EYE_VIEW_PLUGIN_ID = "gods-eye-view";

export const SAMGEO_PLUGIN_ID = "maplibre-samgeo";

export const POINT_CLOUD_ANNOTATION_PLUGIN_ID = "geolibre-point-cloud-annotation";

export const DIRECTIONS_PLUGIN_ID = "maplibre-gl-directions";

export const REVERSE_GEOCODE_PLUGIN_ID = "maplibre-reverse-geocode";

export const DECK_VIZ_PLUGIN_ID = "maplibre-deckgl-viz";

export const COMPONENTS_PLUGIN_ID = "maplibre-gl-components";

/** Native graticule labels retained by map export cropping. */
export const GRATICULE_LABEL_LAYER_ID = "geolibre-graticule-labels-layer";
