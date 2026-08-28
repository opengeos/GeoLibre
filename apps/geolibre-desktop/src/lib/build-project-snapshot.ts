import {
  projectFromStore,
  redactCredentials,
  useAppStore,
  type GeoLibreLayer,
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
 * @param overrides - Replacements for store fields the caller has already
 *   transformed. Routing every caller through this one field list keeps a new
 *   project field from reaching one snapshot path but not another.
 * @returns The serializable project snapshot.
 */
export function buildProjectSnapshot(
  mapControllerRef: RefObject<MapController | null>,
  overrides: { layers?: GeoLibreLayer[] } = {},
): GeoLibreProject {
  const state = useAppStore.getState();
  return projectFromStore({
    projectName: state.projectName,
    mapView: mapControllerRef.current?.readView() ?? state.mapView,
    basemapStyleUrl: state.basemapStyleUrl,
    basemapVisible: state.basemapVisible,
    basemapOpacity: state.basemapOpacity,
    blankBackgroundColor: state.blankBackgroundColor,
    layers: overrides.layers ?? state.layers,
    selectedLayerId: state.selectedLayerId,
    layerGroups: state.layerGroups,
    preferences: state.preferences,
    plugins: {
      ...getPluginManager().getProjectState(),
      manifestUrls: state.projectPlugins?.manifestUrls ?? [],
    },
    legend: state.legend,
    printLayout: state.printLayout,
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
  // Keep the plugins barrel out of this module's eager dependency graph: some
  // optional controls load browser-only SDKs at module evaluation time.
  const { materializeEmbeddableVectorLayers } = await import("@geolibre/plugins");
  // Materialize against one layer revision and build the snapshot from that
  // same revision. Mixing two would strip `localFileReloadable` from a layer
  // added during the await while leaving it without embedded features (a layer
  // that looks portable and arrives empty), and would let `layerGroups` or
  // `selectedLayerId` name a layer the broadcast does not carry.
  let source = useAppStore.getState().layers;
  let materialized = await materializeEmbeddableVectorLayers(source);
  // An edit that lands mid-read invalidates the result, so read again rather
  // than combine revisions. Bounded: a participant editing continuously still
  // gets a broadcast, at worst one revision behind on group membership.
  for (let attempt = 0; attempt < 3 && useAppStore.getState().layers !== source; attempt += 1) {
    source = useAppStore.getState().layers;
    materialized = await materializeEmbeddableVectorLayers(source);
  }
  const layers = prepareCollaborationLayers(source, materialized);
  // Pass the prepared layers only when portability actually rewrote one, so an
  // unaffected project still snapshots straight from the live store. Nothing
  // below awaits, so the override and every field `buildProjectSnapshot` reads
  // from the store come from the same instant.
  const changed = layers.some((layer, index) => layer !== source[index]);
  return redactCredentials(buildProjectSnapshot(mapControllerRef, changed ? { layers } : {}));
}
