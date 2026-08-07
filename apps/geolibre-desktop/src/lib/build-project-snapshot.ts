import {
  projectFromStore,
  redactCredentials,
  useAppStore,
  type GeoLibreProject,
} from "@geolibre/core";
import type { RefObject } from "react";
import type { MapController } from "@geolibre/map";
import { getPluginManager } from "../hooks/usePlugins";
import { prepareCollaborationLayers } from "./collaboration-layers";

/**
 * Build a `GeoLibreProject` snapshot from the live store and map controller.
 *
 * This is the single definition shared by the embed bridge (postMessage) and the
 * live-collaboration adapter (WebSocket), so both broadcast byte-identical
 * project state. It mirrors the Save/Share path: the camera is read from the
 * controller (so pan/zoom round-trips), falling back to the store before the map
 * is ready, and plugin state is merged in from the plugin manager.
 *
 * @param mapControllerRef - Ref to the live map controller; its `readView()`
 *   supplies the current camera.
 * @returns The serializable project snapshot.
 */
export function buildProjectSnapshot(
  mapControllerRef: RefObject<MapController | null>,
): GeoLibreProject {
  const state = useAppStore.getState();
  return projectFromStore({
    projectName: state.projectName,
    mapView: mapControllerRef.current?.readView() ?? state.mapView,
    basemapStyleUrl: state.basemapStyleUrl,
    basemapVisible: state.basemapVisible,
    basemapOpacity: state.basemapOpacity,
    layers: state.layers,
    selectedLayerId: state.selectedLayerId,
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
    comments: state.comments,
    metadata: state.metadata,
  });
}

/**
 * Build the public wire form used by collaboration and embed hosts.
 * Keeping this boundary shared prevents either transport from accidentally
 * reverting to the credential-bearing local snapshot.
 */
export function buildProjectEgressSnapshot(
  mapControllerRef: RefObject<MapController | null>,
): GeoLibreProject {
  return redactCredentials(buildProjectSnapshot(mapControllerRef));
}

/** Build a self-contained public snapshot for a remote collaborator. */
export async function buildCollaborationSnapshot(
  mapControllerRef: RefObject<MapController | null>,
): Promise<GeoLibreProject> {
  const state = useAppStore.getState();
  // Keep the plugins barrel out of this module's eager dependency graph: some
  // optional controls load browser-only SDKs at module evaluation time.
  const { materializeEmbeddableVectorLayers } = await import("@geolibre/plugins");
  const materialized = await materializeEmbeddableVectorLayers(state.layers);
  const layers = prepareCollaborationLayers(useAppStore.getState().layers, materialized);
  const snapshot = buildProjectSnapshot(mapControllerRef);
  // Rebuild only when portability changed a layer. This keeps the ordinary
  // snapshot path synchronous for embed consumers.
  if (layers.every((layer, index) => layer === useAppStore.getState().layers[index])) {
    return redactCredentials(snapshot);
  }
  const current = useAppStore.getState();
  const portable = projectFromStore({
    projectName: current.projectName,
    mapView: mapControllerRef.current?.readView() ?? current.mapView,
    basemapStyleUrl: current.basemapStyleUrl,
    basemapVisible: current.basemapVisible,
    basemapOpacity: current.basemapOpacity,
    layers,
    selectedLayerId: current.selectedLayerId,
    layerGroups: current.layerGroups,
    preferences: current.preferences,
    plugins: snapshot.plugins,
    legend: current.legend,
    storymap: current.storymap,
    models: current.models,
    processingHistory: current.processingHistory,
    widgets: current.widgets,
    dashboardColumns: current.dashboardColumns,
    mapLayout: current.mapLayout,
    secondaryMapViews: current.secondaryMapViews,
    primaryMapLabel: current.primaryMapLabel,
    styleLibrary: current.projectStyleLibrary,
    comments: current.comments,
    metadata: current.metadata,
  });
  return redactCredentials(portable);
}
