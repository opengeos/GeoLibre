import { shouldZoomToNewLayers, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import {
  endLayerGeometryEdit,
  getGeometryEditTargetLayerId,
  isPluginEngineSupported,
  maplibreGeoEditorPlugin,
  selectGeometryEditFeature,
  startLayerGeometryEdit,
} from "@geolibre/plugins";
import type { TFunction } from "i18next";
import { type Dispatch, type RefObject, type SetStateAction, useCallback, useRef } from "react";
import { startGeometryEditSession } from "../../lib/geometry-edit-session";
import { createAppAPI, getPluginManager } from "../usePlugins";

const GEOMETRY_EDIT_START_ERRORS = {
  "unsupported-renderer": "renderer.pluginUnsupported",
  "activation-failed": "layers.editGeometryActivateFailed",
  "start-failed": "layers.editGeometryStartFailed",
} as const;

interface LayerEditActionsOptions {
  mapControllerRef: RefObject<MapEngine | null>;
  setDropError: Dispatch<SetStateAction<string | null>>;
  setDropMessage: Dispatch<SetStateAction<string | null>>;
  clearDropMessageLater: () => void;
  t: TFunction;
}

/**
 * Layers-panel actions that edit a layer in place: geometry editing and
 * materializing a DuckDB query layer into an editable GeoJSON copy.
 *
 * @param options - The map engine, the status toast setters, and `t`.
 * @returns The geometry-edit toggle/cancel/feature handlers and the materialize
 *   handler.
 */
export function useLayerEditActions({
  mapControllerRef,
  setDropError,
  setDropMessage,
  clearDropMessageLater,
  t,
}: LayerEditActionsOptions) {
  const materializingRef = useRef(false);
  const togglingGeometryEditRef = useRef(false);
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);

  const handleToggleGeometryEdit = useCallback(
    async (layerId: string) => {
      const appAPI = createAppAPI(mapControllerRef);
      if (getGeometryEditTargetLayerId() === layerId) {
        await endLayerGeometryEdit(appAPI, { save: true });
        return;
      }
      // Guard against concurrent invocations: this handler awaits before it sets
      // the session target, so two rapid clicks could otherwise both pass the
      // check above and race into startLayerGeometryEdit for different layers.
      if (togglingGeometryEditRef.current) return;
      togglingGeometryEditRef.current = true;
      // Clear any stale error from a previous failed attempt.
      setDropError(null);
      try {
        const result = await startGeometryEditSession(layerId, {
          app: appAPI,
          manager: getPluginManager(),
          map: mapControllerRef.current,
          geoEditor: { isPluginEngineSupported, maplibreGeoEditorPlugin, startLayerGeometryEdit },
        });
        if (result !== "started") {
          setDropError(t(GEOMETRY_EDIT_START_ERRORS[result]));
          clearDropMessageLater();
        }
      } finally {
        togglingGeometryEditRef.current = false;
      }
    },
    [clearDropMessageLater, mapControllerRef, setDropError, t],
  );

  /**
   * Start (or keep) a geometry-edit session on `layerId` and select one of its
   * features in the editor: Identify's Edit geometry action (#2932). Unlike
   * {@link handleToggleGeometryEdit}, a session already open on this layer is
   * kept rather than finished.
   */
  const handleEditFeatureGeometry = useCallback(
    async (layerId: string, featureId: string) => {
      if (getGeometryEditTargetLayerId() !== layerId) await handleToggleGeometryEdit(layerId);
      if (getGeometryEditTargetLayerId() === layerId) selectGeometryEditFeature(featureId);
    },
    [handleToggleGeometryEdit],
  );

  const handleCancelGeometryEdit = useCallback(() => {
    void endLayerGeometryEdit(createAppAPI(mapControllerRef), { save: false });
  }, [mapControllerRef]);

  const handleMaterializeDuckDBLayer = useCallback(
    async (layer: GeoLibreLayer) => {
      // Guard against concurrent triggers (double-click, or two layers in quick
      // succession) so we do not add duplicate materialized layers.
      if (materializingRef.current) return;
      const query = typeof layer.metadata.query === "string" ? layer.metadata.query : null;
      if (!query) {
        setDropError("This DuckDB layer has no stored query to materialize.");
        clearDropMessageLater();
        return;
      }
      materializingRef.current = true;
      setDropError(null);
      setDropMessage("Materializing DuckDB layer...");
      try {
        // The query is the layer's own stored SQL from the user's project; it is
        // intentionally run unrestricted against the in-memory DuckDB instance.
        // Import the DuckDB-WASM engine lazily here, not at module load: a static
        // import would pull the heavy `@duckdb/duckdb-wasm` chunk into the app's
        // boot graph (DesktopShell is eagerly imported by App), which then has to
        // load before the shell renders. That broke the offline cold boot — the
        // chunk is runtime-cached, not precached, so a cache miss failed the boot
        // and the map never mounted (see e2e/pwa.spec.ts). Loading it on first
        // materialize keeps DuckDB out of the offline-critical boot path.
        const { runSqlQuery } = await import("../../lib/sql-workspace");
        const result = await runSqlQuery(query, useAppStore.getState().layers);
        if (!result.geojson) {
          throw new Error("The query did not return a geometry column.");
        }
        const id = addGeoJsonLayer(`${layer.name} (editable)`, result.geojson);
        const created = useAppStore.getState().layers.find((candidate) => candidate.id === id);
        if (created && shouldZoomToNewLayers()) mapControllerRef.current?.fitLayer(created);
        setDropMessage(`Materialized ${result.geojson.features.length.toLocaleString()} features.`);
      } catch (error) {
        setDropMessage(null);
        setDropError(error instanceof Error ? error.message : "Could not materialize this layer.");
      } finally {
        materializingRef.current = false;
        clearDropMessageLater();
      }
    },
    [addGeoJsonLayer, clearDropMessageLater, mapControllerRef, setDropError, setDropMessage],
  );

  return {
    handleCancelGeometryEdit,
    handleEditFeatureGeometry,
    handleMaterializeDuckDBLayer,
    handleToggleGeometryEdit,
  };
}
