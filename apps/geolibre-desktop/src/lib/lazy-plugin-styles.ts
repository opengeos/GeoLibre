const loadedPlugins = new Set<string>();
const pendingLoads = new Map<string, Promise<void>>();

const PLUGIN_STYLE_LOADERS: Readonly<Record<string, () => Promise<void>>> = {
  "maplibre-gl-streetview": async () => {
    await import("maplibre-gl-streetview/style.css");
    await import("../styles/plugins/streetview.css");
  },
  "maplibre-gl-geoagent": async () => {
    await import("maplibre-gl-geoagent/style.css");
    await import("../styles/plugins/geoagent.css");
  },
  "maplibre-gl-esri-wayback": async () => {
    await import("maplibre-gl-esri-wayback/style.css");
    await import("../styles/plugins/esri-wayback.css");
  },
  "maplibre-gl-overture-maps": async () => {
    await import("maplibre-gl-overture-maps/style.css");
    await import("../styles/plugins/overture-maps.css");
  },
  "maplibre-gl-geo-editor": async () => {
    await import("@geoman-io/maplibre-geoman-free/dist/maplibre-geoman.css");
    await import("maplibre-gl-geo-editor/style.css");
    await import("../styles/plugins/geo-editor.css");
  },
  "geolibre-elevation-profile": async () => {
    await import("../styles/plugins/elevation-profile.css");
  },
  "maplibre-gl-mapillary": async () => {
    await import("mapillary-js/dist/mapillary.css");
  },
};

/**
 * Lazily load a plugin's upstream stylesheet and GeoLibre theme overrides on
 * first activation so they are not parsed during initial app boot.
 */
export function ensurePluginStylesLoaded(pluginId: string): Promise<void> {
  if (loadedPlugins.has(pluginId)) return Promise.resolve();
  const existing = pendingLoads.get(pluginId);
  if (existing) return existing;
  const loader = PLUGIN_STYLE_LOADERS[pluginId];
  if (!loader) return Promise.resolve();
  const promise = loader()
    .then(() => {
      loadedPlugins.add(pluginId);
    })
    .catch((error) => {
      console.warn(`[GeoLibre] Failed to load lazy stylesheet for plugin "${pluginId}"`, error);
    })
    .finally(() => {
      pendingLoads.delete(pluginId);
    });
  pendingLoads.set(pluginId, promise);
  return promise;
}

let cesiumToolbarLoaded = false;
let cesiumToolbarPending: Promise<void> | null = null;

/**
 * Lazily load Cesium toolbar theme overrides when a Cesium globe mounts.
 */
export function ensureCesiumToolbarStylesLoaded(): Promise<void> {
  if (cesiumToolbarLoaded) return Promise.resolve();
  if (cesiumToolbarPending) return cesiumToolbarPending;
  cesiumToolbarPending = import("../styles/plugins/cesium-toolbar.css")
    .then(() => {
      cesiumToolbarLoaded = true;
    })
    .catch((error) => {
      console.warn("[GeoLibre] Failed to load Cesium toolbar stylesheet", error);
    })
    .finally(() => {
      cesiumToolbarPending = null;
    });
  return cesiumToolbarPending;
}
