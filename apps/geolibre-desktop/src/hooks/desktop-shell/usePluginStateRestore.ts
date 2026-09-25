import { useAppStore } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { setExternalDeckLayerOrderHandler } from "@geolibre/map";
import {
  applyRasterLayerOrder,
  applyStacSearchLayerOrder,
  DECK_VIZ_PLUGIN_ID,
  DIRECTIONS_PLUGIN_ID,
  EFFECTS_PLUGIN_ID,
  reattachFlightSimulator,
  reattachGodsEyeView,
  reattachRouteAnimation,
  reattachSun,
  restoreArcGISViewportLayers,
  restoreArcgisZarrLayers,
  restoreDeckViz,
  restoreDirections,
  restoreEffects,
  restoreLidarLayers,
  restorePlanetaryComputerLayers,
  restoreRasterLayers,
  restoreReverseGeocode,
  restoreSplattingLayers,
  restoreThreeDTilesLayers,
  restoreVectorLayers,
  REVERSE_GEOCODE_PLUGIN_ID,
} from "@geolibre/plugins";
import { useEffect, useRef, type RefObject } from "react";
import { restoreLocalFileLayers } from "../../lib/restore-local-layers";
import { hasReverseGeocodeConsent } from "../../lib/reverse-geocode-consent";
import { createAppAPI, getPluginManager } from "../usePlugins";

interface PluginStateRestoreOptions {
  mapControllerRef: RefObject<MapEngine | null>;
  enforceViewerPlugins: () => void;
  externalPluginsReady: boolean;
  mapReadyGeneration: number;
  projectGeneration: number;
}

/**
 * Restores the project's plugin state onto the map after a project load or map
 * (re)initialisation, and snapshots live plugin state before a renderer swap.
 *
 * @param options - The map engine, the viewer guard, and the generations that
 *   trigger a restore.
 */
export function usePluginStateRestore({
  mapControllerRef,
  enforceViewerPlugins,
  externalPluginsReady,
  mapReadyGeneration,
  projectGeneration,
}: PluginStateRestoreOptions): void {
  // A renderer swap restores the plugins from the store's projectPlugins, which
  // is only refreshed when a plugin is toggled or moved, so it would roll every
  // plugin back to how it was then (a Time Slider stack added since came back
  // empty). Refresh it the moment the renderer changes: this store subscriber
  // runs synchronously inside setPrimaryRenderer, before React unmounts the old
  // map, so every plugin still reports its live state from a live control.
  // The project generation whose plugin state has been restored onto a map. A
  // swap before that restore must not snapshot the manager, which still holds
  // the previous project's plugins. Likewise the renderer they were restored
  // onto: a second swap before the new map's restore would read plugins whose
  // controls are already gone.
  const restoredPluginGeneration = useRef<number | null>(null);
  const restoredPluginRenderer = useRef<string | null>(null);
  // The map engine the plugins were last restored onto.
  const restoredPluginEngine = useRef<MapEngine | null>(null);
  useEffect(
    () =>
      useAppStore.subscribe((state, previous) => {
        if (
          state.primaryRenderer === previous.primaryRenderer ||
          // A project load brings its own plugin state; never overwrite it.
          state.projectGeneration !== previous.projectGeneration ||
          state.projectPlugins !== previous.projectPlugins ||
          restoredPluginGeneration.current !== state.projectGeneration ||
          restoredPluginRenderer.current !== previous.primaryRenderer
        )
          return;
        try {
          const manager = getPluginManager();
          const stored = state.projectPlugins;
          const live = manager.getProjectState(stored);
          // A plugin still registering (an external one loading) is not in
          // the live snapshot yet; keep what the project stored for it.
          const registered = new Set(manager.list().map((plugin) => plugin.id));
          const unregistered = (id: string) => !registered.has(id);
          const keep = <T>(record: Record<string, T> | undefined) =>
            Object.fromEntries(Object.entries(record ?? {}).filter(([id]) => unregistered(id)));
          const next = {
            ...live,
            // Keep every stored activation: a toggle already writes a
            // deliberate deactivation to the store, so an id still stored but
            // not live is one that failed to mount (or has not registered)
            // and should be retried on the new map.
            activePluginIds: [
              ...new Set([...live.activePluginIds, ...(stored?.activePluginIds ?? [])]),
            ],
            mapControlPositions: {
              ...keep(stored?.mapControlPositions),
              ...live.mapControlPositions,
            },
            settings: { ...keep(stored?.settings), ...live.settings },
            manifestUrls: stored?.manifestUrls ?? [],
          };
          if (JSON.stringify(next) === JSON.stringify(stored)) return;
          state.setProjectPlugins(next, false);
        } catch (error) {
          console.warn("[GeoLibre] Could not snapshot plugin state for the renderer swap", error);
        }
      }),
    [],
  );

  useEffect(() => {
    // Restoration should run only when a project is loaded (projectGeneration)
    // or the map is reinitialised (mapReadyGeneration), not on every
    // incremental plugin write-back. projectPlugins is read from the store
    // snapshot at call time so it is always current without being a dependency.
    // Restore compatible plugins for either renderer. Native MapLibre layer
    // producers remain below their own capability gate.
    const engine = mapControllerRef.current;
    if (!externalPluginsReady || !mapReadyGeneration || !engine) return;
    const appAPI = createAppAPI(mapControllerRef);
    const pluginManager = getPluginManager();
    pluginManager.restoreProjectState(useAppStore.getState().projectPlugins, appAPI, {
      mapReplaced: restoredPluginEngine.current !== null && restoredPluginEngine.current !== engine,
    });
    restoredPluginEngine.current = engine;
    restoredPluginGeneration.current = projectGeneration;
    restoredPluginRenderer.current = useAppStore.getState().primaryRenderer;
    // Immediately after the restore, so a project that persisted the geo-editor
    // as active cannot re-arm editing inside a read-only viewer embed.
    enforceViewerPlugins();
    const search = window.location.search;
    void pluginManager
      .handleUrlParameters(new URLSearchParams(search), appAPI, `${projectGeneration}:${search}`)
      // `handleUrlParameters` activates plugins asynchronously, so it can land
      // after the synchronous pass above. No blocked plugin registers a URL
      // handler today, but "every activation path is covered" is the whole
      // point of the guard, so re-assert it once this settles rather than
      // leaving the next one to notice.
      .catch(console.error)
      .finally(enforceViewerPlugins);
    // The environment plugins have a branch for each renderer (#2287): the
    // effects engine drives Cesium's sky box and atmosphere, the sun simulation
    // its lighting and clock, the flight simulator its camera. They rebind the
    // same way on both — a renderer swap rebuilds the engine, so the host
    // re-attaches them exactly as it does after a MapLibre re-init.
    //
    // activeByDefault plugins are marked active without activate() being
    // called, so the effects engine must be kicked explicitly to match the
    // restored active state (idempotent).
    restoreEffects(
      appAPI,
      pluginManager.isActive(EFFECTS_PLUGIN_ID),
      useAppStore.getState().projectPlugins?.settings?.[EFFECTS_PLUGIN_ID],
    );
    // The sun simulation reads/writes native map layers, so it must re-bind to
    // the (possibly new) map instance after a map re-init or basemap change.
    // Reattach only — it must NOT derive open/closed state here, which would
    // reset a locally-opened panel on an unrelated basemap swap or remote edit.
    // Project loads open/close it via the plugin's applyProjectState (invoked by
    // restoreProjectState above).
    reattachSun(appAPI);
    // The flight simulator holds a reference to the live map (and suspends its
    // interaction handlers while flying), so rebind it after a map re-init too.
    reattachFlightSimulator(appAPI);
    // VectorControl has a Cesium bridge and must restore on either engine.
    restoreVectorLayers(appAPI);
    if (engine.kind === "mapbox" || (engine.kind === "arcgis" && engine.capabilities.deckOverlay)) {
      restoreThreeDTilesLayers(appAPI);
      void restoreLidarLayers(appAPI).catch(console.error);
    }
    // Same contract for the shared deck.gl overlay: re-attach it to the current
    // map and re-render any deckgl-viz layers a restored project carries. It
    // binds to either 2D engine (`getMap()` or `getMapboxMap()`), so it sits
    // above the native-map gate below; on Cesium the plugin manager has
    // already deactivated the plugin and this only clears its layers.
    restoreDeckViz(appAPI, pluginManager.isActive(DECK_VIZ_PLUGIN_ID));
    // The route animation owns native marker/trail layers, so rebind it to the
    // (possibly new) map after a re-init/basemap swap without deriving
    // open/closed state (project loads handle that via applyProjectState). It
    // binds to either 2D engine through getStyleMap, so it sits above the
    // native-map gate like the deck.gl overlay; on Cesium the plugin manager
    // has already deactivated it and this only detaches the engine.
    reattachRouteAnimation(appAPI);
    // God's Eye View holds the Cesium handle it pushes its CZML feeds at, so it
    // has to rebind after a renderer swap too. It sits above the native-map gate
    // because the handle it wants is the globe's, which that gate excludes.
    // Reattach only — the per-feed toggles come from its applyProjectState.
    reattachGodsEyeView(appAPI);
    if (!engine.capabilities.nativeMapInstance) {
      if (engine.kind === "mapbox" || engine.kind === "arcgis") restoreRasterLayers(appAPI);
      // Both draw Zarr from the layer record, so only the Time Slider binding
      // needs restoring (opengeos/GeoLibre#2261).
      if (engine.kind === "arcgis" || engine.kind === "cesium") restoreArcgisZarrLayers();
      void restoreLocalFileLayers();
      return;
    }
    restoreThreeDTilesLayers(appAPI);
    restoreRasterLayers(appAPI);
    restorePlanetaryComputerLayers(appAPI);
    // Re-bind saved ArcGIS feature layers to the viewport. Without this a
    // reopened project's layer stays frozen on the extent it was saved with.
    restoreArcGISViewportLayers(appAPI);
    // Re-stream saved LiDAR (COPC) point clouds. A `lidar-url` layer restores
    // into the store as inert metadata; the point cloud is loaded by the LiDAR
    // control, not the store, so without this the layer shows in the panel but
    // renders nothing.
    void restoreLidarLayers(appAPI).catch((error: unknown) => {
      console.warn("[lidar] failed to restore saved point clouds", error);
    });
    // Same for saved Gaussian splats and 3D models (`splatting-url`): the
    // splatting control draws them, so reload them through it.
    void restoreSplattingLayers(appAPI).catch((error: unknown) => {
      console.warn("[splatting] failed to restore saved layers", error);
    });
    // Re-read drag-dropped / Add Data local-file GeoJSON layers from disk
    // (their data was saved as a path, not embedded).
    void restoreLocalFileLayers();
    // Let layer-sync push the store-derived beforeId into the control that owns
    // each deck.gl COG raster so it interleaves with vector layers instead of
    // always drawing on top. Two controls render such layers: the raster
    // control and the STAC Search control (#1718). The STAC one claims only its
    // own layer ids, so ask it first and fall through for everything else.
    setExternalDeckLayerOrderHandler((layerId, beforeId) => {
      if (applyStacSearchLayerOrder(layerId, beforeId)) return;
      applyRasterLayerOrder(layerId, beforeId);
    });
    // Rebind the directions tool to the (possibly new) map instance after a
    // map re-init, since restoreProjectState skips an already-active plugin.
    restoreDirections(appAPI, pluginManager.isActive(DIRECTIONS_PLUGIN_ID));
    // Reverse geocode sends clicked coordinates to a public geocoder. If a
    // restored project marks it active but this device never acknowledged the
    // privacy notice, deactivate it so no coordinates are sent without consent;
    // the user must re-enable it (which shows the notice). This makes the
    // consent gate cover every activation path, not just the toolbar toggle.
    if (pluginManager.isActive(REVERSE_GEOCODE_PLUGIN_ID) && !hasReverseGeocodeConsent()) {
      pluginManager.deactivate(REVERSE_GEOCODE_PLUGIN_ID, appAPI);
    }
    restoreReverseGeocode(appAPI, pluginManager.isActive(REVERSE_GEOCODE_PLUGIN_ID));
  }, [
    enforceViewerPlugins,
    externalPluginsReady,
    mapReadyGeneration,
    projectGeneration,
    mapControllerRef,
  ]);
}
