import { useAppStore } from "@geolibre/core";
import {
  maplibreBasemapControlPlugin,
  maplibreGeoAgentPlugin,
  maplibreGeoEditorPlugin,
  maplibreLayerControlPlugin,
  maplibreStreetViewPlugin,
  maplibreSwipePlugin,
  PluginManager,
} from "@geolibre/plugins";
import type { MapController } from "@geolibre/map";
import type { RefObject } from "react";
import { useSyncExternalStore } from "react";

const manager = new PluginManager();
manager.registerAll([
  maplibreLayerControlPlugin,
  maplibreBasemapControlPlugin,
  maplibreGeoAgentPlugin,
  maplibreGeoEditorPlugin,
  maplibreStreetViewPlugin,
  maplibreSwipePlugin,
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
  // Built-in plugin registration happens at module load so the toolbar can
  // render plugin menu items on the first pass.
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
    onBasemapChange: (callback: (styleUrl: string) => void) =>
      useAppStore.subscribe((state, prev) => {
        if (state.basemapStyleUrl !== prev.basemapStyleUrl) {
          callback(state.basemapStyleUrl);
        }
      }),
    addMapControl: (
      control: Parameters<MapController["addControl"]>[0],
      position?: Parameters<MapController["addControl"]>[1],
    ) => mapControllerRef?.current?.addControl(control, position) ?? false,
    removeMapControl: (control: Parameters<MapController["removeControl"]>[0]) =>
      mapControllerRef?.current?.removeControl(control),
    setBuiltInMapControlVisible: (
      control: Parameters<MapController["setBuiltInControlVisible"]>[0],
      visible: boolean,
    ) =>
      mapControllerRef?.current?.setBuiltInControlVisible(control, visible) ??
      false,
  };
}
