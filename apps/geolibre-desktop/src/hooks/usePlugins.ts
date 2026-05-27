import { useAppStore } from "@geolibre/core";
import {
  cartoLightPlugin,
  osmBasemapPlugin,
  PluginManager,
  sampleGeoJsonPlugin,
  setSampleGeoJson,
} from "@geolibre/plugins";
import { useEffect, useRef } from "react";
import sampleGeojson from "../../../../sample-data/sample.geojson?url";

const manager = new PluginManager();

export function getPluginManager(): PluginManager {
  return manager;
}

export function usePlugins() {
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    manager.registerAll([
      osmBasemapPlugin,
      cartoLightPlugin,
      sampleGeoJsonPlugin,
    ]);

    fetch(sampleGeojson)
      .then((r) => r.json())
      .then((data) => setSampleGeoJson(data as GeoJSON.FeatureCollection))
      .catch(console.error);
  }, []);
}

export function createAppAPI() {
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
  };
}
