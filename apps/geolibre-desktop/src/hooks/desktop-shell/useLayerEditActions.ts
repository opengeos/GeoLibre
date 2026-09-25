import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import {
  endLayerGeometryEdit,
  GEO_EDITOR_PLUGIN_ID,
  getGeometryEditTargetLayerId,
  isPluginEngineSupported,
  maplibreGeoEditorPlugin,
  startLayerGeometryEdit,
} from "@geolibre/plugins";
import type { FeatureCollection } from "geojson";
import type { TFunction } from "i18next";
import { type Dispatch, type RefObject, type SetStateAction, useCallback, useRef } from "react";
import { createAppAPI, getPluginManager } from "../usePlugins";

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
 * @returns The geometry-edit toggle/cancel handlers and the materialize handler.
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

  const ensureLayerGeojsonFromSource = useCallback(
    async (layerId: string) => {
      const layer = useAppStore.getState().layers.find((candidate) => candidate.id === layerId);
      if (!layer || layer.geojson) return;
      const sourceIds = layer.metadata.sourceIds;
      const sourceId = Array.isArray(sourceIds) ? sourceIds[0] : undefined;
      if (typeof sourceId !== "string") return;
      const source = mapControllerRef.current?.getMap()?.getSource(sourceId) as
        | { getData?: () => Promise<unknown> }
        | undefined;
      if (!source || typeof source.getData !== "function") return;
      try {
        const data = await source.getData();
        if (
          data &&
          typeof data === "object" &&
          (data as { type?: string }).type === "FeatureCollection"
        ) {
          useAppStore.getState().updateLayer(layerId, { geojson: data as FeatureCollection });
        }
      } catch {
        // Best effort; startLayerGeometryEdit will fail and surface an error.
      }
    },
    [mapControllerRef],
  );

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
        // Add Vector Layer (geojson-mode) layers keep their features in a
        // MapLibre source rather than in `layer.geojson`. Read them back once so
        // the editor has features to load. (Plain geojson layers already have
        // `geojson`.)
        // The editor draws through a MapLibre or Mapbox map; on another
        // renderer it cannot start, and waiting for the map will not help.
        if (
          !isPluginEngineSupported(maplibreGeoEditorPlugin, useAppStore.getState().primaryRenderer)
        ) {
          setDropError(t("renderer.pluginUnsupported"));
          clearDropMessageLater();
          return;
        }
        await ensureLayerGeojsonFromSource(layerId);
        const manager = getPluginManager();
        if (!manager.isActive(GEO_EDITOR_PLUGIN_ID)) {
          manager.activate(GEO_EDITOR_PLUGIN_ID, appAPI);
          if (!manager.isActive(GEO_EDITOR_PLUGIN_ID)) {
            setDropError(t("layers.editGeometryActivateFailed"));
            clearDropMessageLater();
            return;
          }
        }
        const started = await startLayerGeometryEdit(appAPI, layerId);
        if (!started) {
          setDropError(t("layers.editGeometryStartFailed"));
          clearDropMessageLater();
        }
      } finally {
        togglingGeometryEditRef.current = false;
      }
    },
    [clearDropMessageLater, ensureLayerGeojsonFromSource, mapControllerRef, setDropError, t],
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
        if (created) mapControllerRef.current?.fitLayer(created);
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

  return { handleCancelGeometryEdit, handleMaterializeDuckDBLayer, handleToggleGeometryEdit };
}
