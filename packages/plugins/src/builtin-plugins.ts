import type { GeoLibrePlugin } from "./types";
import { createBuiltInPluginModules } from "./builtin-plugin-loader";
import { BUILT_IN_PLUGIN_METADATA, type BuiltInPluginId } from "./builtin-plugin-metadata";
import type { LazyPluginRegistration } from "./builtin-plugin-lifecycle";
import {
  DEFAULT_SUN_SETTINGS,
  DEFAULT_ROUTE_ANIMATION_SETTINGS,
  DEFAULT_FLIGHT_SIMULATOR_SETTINGS,
} from "./builtin-plugin-defaults";

// Static import expressions let the bundler split implementations while the
// catalog itself stays available without evaluating any implementation.
const modules = createBuiltInPluginModules({
  "layer-control": () => import("./plugins/layer-control"),
  "geo-editor": () => import("./plugins/maplibre-geo-editor"),
  annotations: () => import("./plugins/maplibre-annotations"),
  dimensions: () => import("./plugins/maplibre-dimensions"),
  "fema-wms": () => import("./plugins/maplibre-fema-wms"),
  "nasa-earthdata": () => import("./plugins/maplibre-nasa-earthdata"),
  enviroatlas: () => import("./plugins/maplibre-enviroatlas"),
  "national-map": () => import("./plugins/maplibre-national-map"),
  "usgs-nldi": () => import("./plugins/maplibre-usgs-nldi"),
  "usgs-dem": () => import("./plugins/maplibre-usgs-dem"),
  "usgs-lidar": () => import("./plugins/maplibre-usgs-lidar"),
  vantor: () => import("./plugins/maplibre-vantor"),
  stac: () => import("./plugins/maplibre-stac"),
  "earthdata-gis": () => import("./plugins/maplibre-earthdata-gis"),
  earthaccess: () => import("./plugins/maplibre-earthaccess"),
  openaerialmap: () => import("./plugins/maplibre-openaerialmap"),
  "osm-downloader": () => import("./plugins/maplibre-osm-downloader"),
  "ign-lidar-hd": () => import("./plugins/maplibre-ign-lidar-hd"),
  "arcgis-portal": () => import("./plugins/maplibre-arcgis-portal"),
  "arcgis-hub": () => import("./plugins/maplibre-arcgis-hub"),
  "tennessee-gis": () => import("./plugins/maplibre-tennessee-gis"),
  "us-federal-gis": () => import("./plugins/maplibre-us-federal-gis"),
  "us-state-gis": () => import("./plugins/maplibre-us-state-gis"),
  "us-local-gis": () => import("./plugins/maplibre-us-local-gis"),
  "india-gis": () => import("./plugins/maplibre-india-gis"),
  "open-data-catalogs": () => import("./plugins/maplibre-open-data-catalogs"),
  "source-coop": () => import("./plugins/maplibre-source-coop"),
  "s3-browser": () => import("./plugins/maplibre-s3-browser"),
  huggingface: () => import("./plugins/maplibre-huggingface"),
  "satellite-embeddings": () => import("./plugins/maplibre-satellite-embeddings"),
  "fields-of-the-world": () => import("./plugins/maplibre-fields-of-the-world"),
  "sentinel2-explorer": () => import("./plugins/maplibre-sentinel2-explorer"),
  "ocean-data-platform": () => import("./plugins/maplibre-ocean-data-platform"),
  dynamical: () => import("./plugins/maplibre-dynamical"),
  "jaxa-earth": () => import("./plugins/maplibre-jaxa-earth"),
  geolens: () => import("./plugins/maplibre-geolens"),
  streetview: () => import("./plugins/maplibre-streetview"),
  mapillary: () => import("./plugins/maplibre-mapillary"),
  h3: () => import("./plugins/maplibre-h3"),
  s2: () => import("./plugins/maplibre-s2"),
  a5: () => import("./plugins/maplibre-a5"),
  dggrid: () => import("./plugins/maplibre-dggrid"),
  dggal: () => import("./plugins/maplibre-dggal"),
  olc: () => import("./plugins/maplibre-olc"),
  geohash: () => import("./plugins/maplibre-geohash"),
  tilecode: () => import("./plugins/maplibre-tilecode"),
  "basemap-control": () => import("./plugins/maplibre-basemap-control"),
  "esri-wayback": () => import("./plugins/maplibre-esri-wayback"),
  "time-slider": () => import("./plugins/maplibre-time-slider"),
  timelapse: () => import("./plugins/maplibre-timelapse"),
  "overture-maps": () => import("./plugins/maplibre-overture-maps"),
  geoagent: () => import("./plugins/maplibre-geoagent"),
  "elevation-profile": () => import("./plugins/elevation-profile/index"),
  swipe: () => import("./plugins/maplibre-swipe"),
  graticule: () => import("./plugins/maplibre-graticule"),
  clouds: () => import("./plugins/maplibre-clouds"),
  precipitation: () => import("./plugins/maplibre-precipitation"),
  effects: () => import("./plugins/maplibre-effects"),
  sun: () => import("./plugins/maplibre-sun"),
  "route-animation": () => import("./plugins/maplibre-route-animation"),
  "flight-simulator": () => import("./plugins/flight-simulator"),
  "gods-eye-view": () => import("./plugins/gods-eye-view"),
  samgeo: () => import("./plugins/maplibre-samgeo"),
  "point-cloud-annotation": () => import("./plugins/point-cloud-annotation/index"),
  directions: () => import("./plugins/maplibre-directions"),
  "reverse-geocode": () => import("./plugins/maplibre-reverse-geocode"),
  "deckgl-viz": () => import("./plugins/maplibre-deckgl-viz"),
  components: () => import("./plugins/maplibre-components"),
});

export const loadBuiltInPluginModule = modules.loadModule;
export const configureBuiltInPluginModule = modules.configure;

const pluginLoaders = {
  "maplibre-layer-control": async () =>
    (await modules.loadModule("layer-control")).maplibreLayerControlPlugin,
  "maplibre-gl-geo-editor": async () =>
    (await modules.loadModule("geo-editor")).maplibreGeoEditorPlugin,
  "maplibre-gl-annotations": async () =>
    (await modules.loadModule("annotations")).maplibreAnnotationsPlugin,
  "maplibre-gl-dimensions": async () =>
    (await modules.loadModule("dimensions")).maplibreDimensionsPlugin,
  "maplibre-gl-fema-wms": async () => (await modules.loadModule("fema-wms")).maplibreFemaWmsPlugin,
  "maplibre-gl-nasa-earthdata": async () =>
    (await modules.loadModule("nasa-earthdata")).maplibreNasaEarthdataPlugin,
  "maplibre-gl-enviroatlas": async () =>
    (await modules.loadModule("enviroatlas")).maplibreEnviroAtlasPlugin,
  "maplibre-gl-national-map": async () =>
    (await modules.loadModule("national-map")).maplibreNationalMapPlugin,
  "maplibre-usgs-nldi": async () => (await modules.loadModule("usgs-nldi")).maplibreUsgsNldiPlugin,
  "maplibre-gl-usgs-dem": async () => (await modules.loadModule("usgs-dem")).maplibreUsgsDemPlugin,
  "maplibre-gl-usgs-lidar": async () =>
    (await modules.loadModule("usgs-lidar")).maplibreUsgsLidarPlugin,
  "maplibre-gl-vantor": async () => (await modules.loadModule("vantor")).maplibreVantorPlugin,
  "geolibre-planet-open-data": async () =>
    (await modules.loadModule("stac")).maplibrePlanetOpenDataPlugin,
  "geolibre-portolan": async () => (await modules.loadModule("stac")).maplibrePortolanPlugin,
  "maplibre-gl-earthdata-gis": async () =>
    (await modules.loadModule("earthdata-gis")).maplibreEarthdataGisPlugin,
  "geolibre-earthaccess": async () =>
    (await modules.loadModule("earthaccess")).maplibreEarthaccessPlugin,
  "maplibre-gl-openaerialmap": async () =>
    (await modules.loadModule("openaerialmap")).maplibreOpenAerialMapPlugin,
  "geolibre-osm-downloader": async () =>
    (await modules.loadModule("osm-downloader")).maplibreOsmDownloaderPlugin,
  "geolibre-ign-lidar-hd": async () =>
    (await modules.loadModule("ign-lidar-hd")).maplibreIgnLidarHdPlugin,
  "geolibre-arcgis-portal": async () =>
    (await modules.loadModule("arcgis-portal")).maplibreArcGisPortalPlugin,
  "maplibre-gl-arcgis-hub": async () =>
    (await modules.loadModule("arcgis-hub")).maplibreArcGisHubPlugin,
  "geolibre-tennessee-gis": async () =>
    (await modules.loadModule("tennessee-gis")).maplibreTennesseeGisPlugin,
  "geolibre-us-federal-gis": async () =>
    (await modules.loadModule("us-federal-gis")).maplibreUsFederalGisPlugin,
  "geolibre-us-state-gis": async () =>
    (await modules.loadModule("us-state-gis")).maplibreUsStateGisPlugin,
  "geolibre-us-local-gis": async () =>
    (await modules.loadModule("us-local-gis")).maplibreUsLocalGisPlugin,
  "geolibre-india-gis": async () => (await modules.loadModule("india-gis")).maplibreIndiaGisPlugin,
  "maplibre-gl-socrata": async () =>
    (await modules.loadModule("open-data-catalogs")).maplibreSocrataPlugin,
  "maplibre-gl-ckan": async () =>
    (await modules.loadModule("open-data-catalogs")).maplibreCkanPlugin,
  "geolibre-stac-catalogs": async () =>
    (await modules.loadModule("stac")).maplibreStacCatalogsPlugin,
  "maplibre-gl-source-coop": async () =>
    (await modules.loadModule("source-coop")).maplibreSourceCoopPlugin,
  "geolibre-s3-browser": async () =>
    (await modules.loadModule("s3-browser")).maplibreS3BrowserPlugin,
  "maplibre-gl-natural-earth": async () =>
    (await modules.loadModule("source-coop")).maplibreNaturalEarthPlugin,
  "maplibre-gl-huggingface": async () =>
    (await modules.loadModule("huggingface")).maplibreHuggingFacePlugin,
  "geolibre-satellite-embeddings": async () =>
    (await modules.loadModule("satellite-embeddings")).maplibreSatelliteEmbeddingsPlugin,
  "geolibre-fields-of-the-world": async () =>
    (await modules.loadModule("fields-of-the-world")).maplibreFieldsOfTheWorldPlugin,
  "geolibre-sentinel2-explorer": async () =>
    (await modules.loadModule("sentinel2-explorer")).maplibreSentinel2ExplorerPlugin,
  "geolibre-ocean-data-platform": async () =>
    (await modules.loadModule("ocean-data-platform")).maplibreOceanDataPlatformPlugin,
  "geolibre-dynamical": async () => (await modules.loadModule("dynamical")).maplibreDynamicalPlugin,
  "geolibre-jaxa-earth": async () =>
    (await modules.loadModule("jaxa-earth")).maplibreJaxaEarthPlugin,
  "maplibre-gl-geolens": async () => (await modules.loadModule("geolens")).maplibreGeoLensPlugin,
  "maplibre-gl-streetview": async () =>
    (await modules.loadModule("streetview")).maplibreStreetViewPlugin,
  "maplibre-gl-mapillary": async () =>
    (await modules.loadModule("mapillary")).maplibreMapillaryPlugin,
  "maplibre-h3-grid": async () => (await modules.loadModule("h3")).maplibreH3Plugin,
  "maplibre-s2-grid": async () => (await modules.loadModule("s2")).maplibreS2Plugin,
  "maplibre-a5-grid": async () => (await modules.loadModule("a5")).maplibreA5Plugin,
  "maplibre-dggrid": async () => (await modules.loadModule("dggrid")).maplibreDggridPlugin,
  "maplibre-dggal": async () => (await modules.loadModule("dggal")).maplibreDggalPlugin,
  "maplibre-olc": async () => (await modules.loadModule("olc")).maplibreOlcPlugin,
  "maplibre-geohash": async () => (await modules.loadModule("geohash")).maplibreGeohashPlugin,
  "maplibre-tilecode": async () => (await modules.loadModule("tilecode")).maplibreTilecodePlugin,
  "maplibre-gl-basemap-control": async () =>
    (await modules.loadModule("basemap-control")).maplibreBasemapControlPlugin,
  "maplibre-gl-esri-wayback": async () =>
    (await modules.loadModule("esri-wayback")).maplibreEsriWaybackPlugin,
  "maplibre-gl-time-slider": async () =>
    (await modules.loadModule("time-slider")).maplibreTimeSliderPlugin,
  "geolibre-timelapse": async () => (await modules.loadModule("timelapse")).maplibreTimelapsePlugin,
  "maplibre-gl-overture-maps": async () =>
    (await modules.loadModule("overture-maps")).maplibreOvertureMapsPlugin,
  "maplibre-gl-geoagent": async () => (await modules.loadModule("geoagent")).maplibreGeoAgentPlugin,
  "geolibre-elevation-profile": async () =>
    (await modules.loadModule("elevation-profile")).maplibreElevationProfilePlugin,
  "maplibre-gl-swipe": async () => (await modules.loadModule("swipe")).maplibreSwipePlugin,
  "maplibre-gl-graticule": async () =>
    (await modules.loadModule("graticule")).maplibreGraticulePlugin,
  "maplibre-gl-clouds": async () => (await modules.loadModule("clouds")).maplibreCloudsPlugin,
  "maplibre-gl-precipitation": async () =>
    (await modules.loadModule("precipitation")).maplibrePrecipitationPlugin,
  "maplibre-atmosphere-effects": async () =>
    (await modules.loadModule("effects")).maplibreEffectsPlugin,
  "geolibre-sun": async () => (await modules.loadModule("sun")).maplibreSunPlugin,
  "geolibre-route-animation": async () =>
    (await modules.loadModule("route-animation")).maplibreRouteAnimationPlugin,
  "geolibre-flight-simulator": async () =>
    (await modules.loadModule("flight-simulator")).flightSimulatorPlugin,
  "gods-eye-view": async () => (await modules.loadModule("gods-eye-view")).godsEyeViewPlugin,
  "maplibre-samgeo": async () => (await modules.loadModule("samgeo")).maplibreSamGeoPlugin,
  "geolibre-point-cloud-annotation": async () =>
    (await modules.loadModule("point-cloud-annotation")).pointCloudAnnotationPlugin,
  "maplibre-gl-directions": async () =>
    (await modules.loadModule("directions")).maplibreDirectionsPlugin,
  "maplibre-reverse-geocode": async () =>
    (await modules.loadModule("reverse-geocode")).maplibreReverseGeocodePlugin,
  "maplibre-deckgl-viz": async () =>
    (await modules.loadModule("deckgl-viz")).maplibreDeckGlVizPlugin,
  "maplibre-gl-components": async () =>
    (await modules.loadModule("components")).maplibreComponentsPlugin,
} satisfies Record<BuiltInPluginId, () => Promise<GeoLibrePlugin>>;

const pluginPeeks = {
  "maplibre-layer-control": () => modules.peekModule("layer-control")?.maplibreLayerControlPlugin,
  "maplibre-gl-geo-editor": () => modules.peekModule("geo-editor")?.maplibreGeoEditorPlugin,
  "maplibre-gl-annotations": () => modules.peekModule("annotations")?.maplibreAnnotationsPlugin,
  "maplibre-gl-dimensions": () => modules.peekModule("dimensions")?.maplibreDimensionsPlugin,
  "maplibre-gl-fema-wms": () => modules.peekModule("fema-wms")?.maplibreFemaWmsPlugin,
  "maplibre-gl-nasa-earthdata": () =>
    modules.peekModule("nasa-earthdata")?.maplibreNasaEarthdataPlugin,
  "maplibre-gl-enviroatlas": () => modules.peekModule("enviroatlas")?.maplibreEnviroAtlasPlugin,
  "maplibre-gl-national-map": () => modules.peekModule("national-map")?.maplibreNationalMapPlugin,
  "maplibre-usgs-nldi": () => modules.peekModule("usgs-nldi")?.maplibreUsgsNldiPlugin,
  "maplibre-gl-usgs-dem": () => modules.peekModule("usgs-dem")?.maplibreUsgsDemPlugin,
  "maplibre-gl-usgs-lidar": () => modules.peekModule("usgs-lidar")?.maplibreUsgsLidarPlugin,
  "maplibre-gl-vantor": () => modules.peekModule("vantor")?.maplibreVantorPlugin,
  "geolibre-planet-open-data": () => modules.peekModule("stac")?.maplibrePlanetOpenDataPlugin,
  "geolibre-portolan": () => modules.peekModule("stac")?.maplibrePortolanPlugin,
  "maplibre-gl-earthdata-gis": () =>
    modules.peekModule("earthdata-gis")?.maplibreEarthdataGisPlugin,
  "geolibre-earthaccess": () => modules.peekModule("earthaccess")?.maplibreEarthaccessPlugin,
  "maplibre-gl-openaerialmap": () =>
    modules.peekModule("openaerialmap")?.maplibreOpenAerialMapPlugin,
  "geolibre-osm-downloader": () =>
    modules.peekModule("osm-downloader")?.maplibreOsmDownloaderPlugin,
  "geolibre-ign-lidar-hd": () => modules.peekModule("ign-lidar-hd")?.maplibreIgnLidarHdPlugin,
  "geolibre-arcgis-portal": () => modules.peekModule("arcgis-portal")?.maplibreArcGisPortalPlugin,
  "maplibre-gl-arcgis-hub": () => modules.peekModule("arcgis-hub")?.maplibreArcGisHubPlugin,
  "geolibre-tennessee-gis": () => modules.peekModule("tennessee-gis")?.maplibreTennesseeGisPlugin,
  "geolibre-us-federal-gis": () => modules.peekModule("us-federal-gis")?.maplibreUsFederalGisPlugin,
  "geolibre-us-state-gis": () => modules.peekModule("us-state-gis")?.maplibreUsStateGisPlugin,
  "geolibre-us-local-gis": () => modules.peekModule("us-local-gis")?.maplibreUsLocalGisPlugin,
  "geolibre-india-gis": () => modules.peekModule("india-gis")?.maplibreIndiaGisPlugin,
  "maplibre-gl-socrata": () => modules.peekModule("open-data-catalogs")?.maplibreSocrataPlugin,
  "maplibre-gl-ckan": () => modules.peekModule("open-data-catalogs")?.maplibreCkanPlugin,
  "geolibre-stac-catalogs": () => modules.peekModule("stac")?.maplibreStacCatalogsPlugin,
  "maplibre-gl-source-coop": () => modules.peekModule("source-coop")?.maplibreSourceCoopPlugin,
  "geolibre-s3-browser": () => modules.peekModule("s3-browser")?.maplibreS3BrowserPlugin,
  "maplibre-gl-natural-earth": () => modules.peekModule("source-coop")?.maplibreNaturalEarthPlugin,
  "maplibre-gl-huggingface": () => modules.peekModule("huggingface")?.maplibreHuggingFacePlugin,
  "geolibre-satellite-embeddings": () =>
    modules.peekModule("satellite-embeddings")?.maplibreSatelliteEmbeddingsPlugin,
  "geolibre-fields-of-the-world": () =>
    modules.peekModule("fields-of-the-world")?.maplibreFieldsOfTheWorldPlugin,
  "geolibre-sentinel2-explorer": () =>
    modules.peekModule("sentinel2-explorer")?.maplibreSentinel2ExplorerPlugin,
  "geolibre-ocean-data-platform": () =>
    modules.peekModule("ocean-data-platform")?.maplibreOceanDataPlatformPlugin,
  "geolibre-dynamical": () => modules.peekModule("dynamical")?.maplibreDynamicalPlugin,
  "geolibre-jaxa-earth": () => modules.peekModule("jaxa-earth")?.maplibreJaxaEarthPlugin,
  "maplibre-gl-geolens": () => modules.peekModule("geolens")?.maplibreGeoLensPlugin,
  "maplibre-gl-streetview": () => modules.peekModule("streetview")?.maplibreStreetViewPlugin,
  "maplibre-gl-mapillary": () => modules.peekModule("mapillary")?.maplibreMapillaryPlugin,
  "maplibre-h3-grid": () => modules.peekModule("h3")?.maplibreH3Plugin,
  "maplibre-s2-grid": () => modules.peekModule("s2")?.maplibreS2Plugin,
  "maplibre-a5-grid": () => modules.peekModule("a5")?.maplibreA5Plugin,
  "maplibre-dggrid": () => modules.peekModule("dggrid")?.maplibreDggridPlugin,
  "maplibre-dggal": () => modules.peekModule("dggal")?.maplibreDggalPlugin,
  "maplibre-olc": () => modules.peekModule("olc")?.maplibreOlcPlugin,
  "maplibre-geohash": () => modules.peekModule("geohash")?.maplibreGeohashPlugin,
  "maplibre-tilecode": () => modules.peekModule("tilecode")?.maplibreTilecodePlugin,
  "maplibre-gl-basemap-control": () =>
    modules.peekModule("basemap-control")?.maplibreBasemapControlPlugin,
  "maplibre-gl-esri-wayback": () => modules.peekModule("esri-wayback")?.maplibreEsriWaybackPlugin,
  "maplibre-gl-time-slider": () => modules.peekModule("time-slider")?.maplibreTimeSliderPlugin,
  "geolibre-timelapse": () => modules.peekModule("timelapse")?.maplibreTimelapsePlugin,
  "maplibre-gl-overture-maps": () =>
    modules.peekModule("overture-maps")?.maplibreOvertureMapsPlugin,
  "maplibre-gl-geoagent": () => modules.peekModule("geoagent")?.maplibreGeoAgentPlugin,
  "geolibre-elevation-profile": () =>
    modules.peekModule("elevation-profile")?.maplibreElevationProfilePlugin,
  "maplibre-gl-swipe": () => modules.peekModule("swipe")?.maplibreSwipePlugin,
  "maplibre-gl-graticule": () => modules.peekModule("graticule")?.maplibreGraticulePlugin,
  "maplibre-gl-clouds": () => modules.peekModule("clouds")?.maplibreCloudsPlugin,
  "maplibre-gl-precipitation": () =>
    modules.peekModule("precipitation")?.maplibrePrecipitationPlugin,
  "maplibre-atmosphere-effects": () => modules.peekModule("effects")?.maplibreEffectsPlugin,
  "geolibre-sun": () => modules.peekModule("sun")?.maplibreSunPlugin,
  "geolibre-route-animation": () =>
    modules.peekModule("route-animation")?.maplibreRouteAnimationPlugin,
  "geolibre-flight-simulator": () => modules.peekModule("flight-simulator")?.flightSimulatorPlugin,
  "gods-eye-view": () => modules.peekModule("gods-eye-view")?.godsEyeViewPlugin,
  "maplibre-samgeo": () => modules.peekModule("samgeo")?.maplibreSamGeoPlugin,
  "geolibre-point-cloud-annotation": () =>
    modules.peekModule("point-cloud-annotation")?.pointCloudAnnotationPlugin,
  "maplibre-gl-directions": () => modules.peekModule("directions")?.maplibreDirectionsPlugin,
  "maplibre-reverse-geocode": () =>
    modules.peekModule("reverse-geocode")?.maplibreReverseGeocodePlugin,
  "maplibre-deckgl-viz": () => modules.peekModule("deckgl-viz")?.maplibreDeckGlVizPlugin,
  "maplibre-gl-components": () => modules.peekModule("components")?.maplibreComponentsPlugin,
} satisfies Record<BuiltInPluginId, () => GeoLibrePlugin | undefined>;

/** Read an already configured implementation without starting an import. */
export function peekBuiltInPlugin(id: BuiltInPluginId): GeoLibrePlugin | undefined {
  const plugin = pluginPeeks[id]?.();
  if (plugin && plugin.id !== id)
    throw new Error(`The built-in loader for '${id}' returned a different plugin.`);
  return plugin;
}

/** Load one built-in through the shared, host-configured module registry. */
export async function loadBuiltInPlugin(id: BuiltInPluginId): Promise<GeoLibrePlugin> {
  const loader = pluginLoaders[id];
  if (typeof loader !== "function") throw new Error(`Unknown built-in plugin '${id}'.`);
  const plugin = await loader();
  if (plugin.id !== id)
    throw new Error(`The built-in loader for '${id}' returned a different plugin.`);
  return plugin;
}

function closePendingPanel(state: unknown): Record<string, unknown> | undefined {
  if (!state || typeof state !== "object" || Array.isArray(state)) return undefined;
  return { ...state, open: false };
}

function stopPendingPanel(state: unknown): unknown {
  const closed = closePendingPanel(state);
  return closed ? { ...closed, playing: false } : undefined;
}

function omitDefaultState(state: unknown, defaults: object): unknown {
  if (!state || typeof state !== "object") return state;
  const settings = state as Record<string, unknown>;
  return Object.entries(defaults).every(([key, value]) => settings[key] === value)
    ? undefined
    : state;
}

// Match the implementations' teardown effects before an import completes.
// Other stateful providers retain their saved preferences on deactivation.
const pendingDeactivations: Partial<Record<BuiltInPluginId, (state: unknown) => unknown>> = {
  "geolibre-sun": (state) => omitDefaultState(stopPendingPanel(state), DEFAULT_SUN_SETTINGS),
  "geolibre-route-animation": (state) =>
    omitDefaultState(stopPendingPanel(state), DEFAULT_ROUTE_ANIMATION_SETTINGS),
  "geolibre-flight-simulator": (state) =>
    omitDefaultState(closePendingPanel(state), DEFAULT_FLIGHT_SIMULATOR_SETTINGS),
  // The native Components teardown removes every widget and clears its saved
  // state, including images. Match it even while the implementation is pending.
  "maplibre-gl-components": () => undefined,
};

/** Ordered registration descriptors; reading them never imports implementations. */
export const BUILT_IN_PLUGINS = BUILT_IN_PLUGIN_METADATA.map(
  (metadata) =>
    ({
      metadata,
      load: () => loadBuiltInPlugin(metadata.id),
      peek: () => peekBuiltInPlugin(metadata.id),
      deactivatePendingState: pendingDeactivations[metadata.id],
    }) satisfies LazyPluginRegistration,
);
