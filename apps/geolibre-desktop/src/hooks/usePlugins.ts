import { useAppStore } from "@geolibre/core";
import {
  cartoLightPlugin,
  maplibreGeoAgentPlugin,
  osmBasemapPlugin,
  PluginManager,
  sampleGeoJsonPlugin,
  setSampleGeoJson,
} from "@geolibre/plugins";
import type { MapController } from "@geolibre/map";
import type { RefObject } from "react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import sampleGeojson from "../../../../sample-data/sample.geojson?url";

const manager = new PluginManager();
manager.registerAll([
  osmBasemapPlugin,
  cartoLightPlugin,
  sampleGeoJsonPlugin,
  maplibreGeoAgentPlugin,
]);

export function getPluginManager(): PluginManager {
  return manager;
}

export function usePluginRegistry() {
  useSyncExternalStore(
    (listener) => manager.subscribe(listener),
    () => manager.getVersion(),
    () => manager.getVersion(),
  );

  return {
    plugins: manager.list(),
    isActive: (id: string) => manager.isActive(id),
    toggle: (id: string, appApi: ReturnType<typeof createAppAPI>) =>
      manager.toggle(id, appApi),
  };
}

export function usePlugins() {
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    fetch(sampleGeojson)
      .then((r) => r.json())
      .then((data) => setSampleGeoJson(data as GeoJSON.FeatureCollection))
      .catch(console.error);
  }, []);
}

export function createAppAPI(
  mapControllerRef?: RefObject<MapController | null>,
) {
  const store = useAppStore.getState();
  return {
    setBasemap: (url: string) => store.setBasemapStyleUrl(url),
    addGeoJsonLayer: (
      name: string,
      data: GeoJSON.FeatureCollection,
      sourcePath?: string,
    ) => {
      const id = store.addGeoJsonLayer(name, data, sourcePath);
      return id;
    },
    getActiveBasemap: () => useAppStore.getState().basemapStyleUrl,
    addMapControl: (
      control: Parameters<MapController["addControl"]>[0],
      position?: Parameters<MapController["addControl"]>[1],
    ) => mapControllerRef?.current?.addControl(control, position) ?? false,
    removeMapControl: (control: Parameters<MapController["removeControl"]>[0]) =>
      mapControllerRef?.current?.removeControl(control),
  };
}
