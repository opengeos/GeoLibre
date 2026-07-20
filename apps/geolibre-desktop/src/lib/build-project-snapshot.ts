import { projectFromStore, useAppStore, type GeoLibreProject } from "@geolibre/core";
import type { RefObject } from "react";
import type { MapEngineClient } from "@geolibre/map";
import { getPluginManager } from "../hooks/usePlugins";

/**
 * Build a `GeoLibreProject` snapshot from the live store and map engine.
 *
 * This is the single definition shared by the embed bridge (postMessage) and the
 * live-collaboration adapter (WebSocket), so both broadcast byte-identical
 * project state. It mirrors the Save/Share path: the camera is read from the
 * camera port (so pan/zoom round-trips), falling back to the store before the map
 * is ready, and plugin state is merged in from the plugin manager.
 *
 * @param mapControllerRef - Ref to the live map engine; its camera port
 *   supplies the current camera.
 * @returns The serializable project snapshot.
 */
export function buildProjectSnapshot(
  mapControllerRef: RefObject<MapEngineClient | null>,
): GeoLibreProject {
  const state = useAppStore.getState();
  return projectFromStore({
    projectName: state.projectName,
    mapView: mapControllerRef.current?.camera.readView() ?? state.mapView,
    basemapStyleUrl: state.basemapStyleUrl,
    basemapVisible: state.basemapVisible,
    basemapOpacity: state.basemapOpacity,
    layers: state.layers,
    layerGroups: state.layerGroups,
    preferences: state.preferences,
    plugins: {
      ...getPluginManager().getProjectState(),
      manifestUrls: state.projectPlugins?.manifestUrls ?? [],
    },
    legend: state.legend,
    storymap: state.storymap,
    models: state.models,
    processingHistory: state.processingHistory,
    widgets: state.widgets,
    dashboardColumns: state.dashboardColumns,
    mapLayout: state.mapLayout,
    secondaryMapViews: state.secondaryMapViews,
    primaryMapLabel: state.primaryMapLabel,
    styleLibrary: state.projectStyleLibrary,
    metadata: state.metadata,
  });
}
