/**
 * Registers every built-in offline edit sync backend with the outbox runner
 * (#3530). Idempotent, so each entry point that can sync (the app-wide
 * runner, the save path) calls it.
 */

import { useAppStore } from "@geolibre/core";
import { openArcGISOutboxSession, type ArcGISOutboxSession } from "@geolibre/plugins/arcgis-layer";
import {
  createArcGISSyncAdapter,
  readFailure,
  reconcileArcGISLayerAfterSync,
} from "./arcgis-edit-sync";
import {
  getActiveGeoLensClient,
  getGeoLensBaseline,
  setGeoLensBaseline,
  setGeoLensSaveHandler,
} from "@geolibre/plugins/geolens-edit-bridge";
import i18n from "../../i18n";
import { editSessionToken, registerEditSyncBackend } from "./edit-outbox-runner";
import {
  buildGeoLensChangeSet,
  createGeoLensSyncAdapter,
  geolensOutboxId,
  geolensOutboxTarget,
  reconcileGeoLensLayerAfterSync,
  withGeoLensLocalIds,
} from "./geolens-edit-sync";
import { saveThroughOutbox } from "./outbox-save";
import { postgisEditSyncHandler } from "./postgis-edit-sync";

let registered = false;

async function arcgisSession(layerId: string): Promise<ArcGISOutboxSession | undefined> {
  try {
    return await openArcGISOutboxSession(layerId);
  } catch (error) {
    throw readFailure(error);
  }
}

/** Register the built-in backends once. */
export function ensureEditSyncBackends(): void {
  if (registered) return;
  registered = true;
  registerEditSyncBackend("postgis", postgisEditSyncHandler);
  // The session opened for a sync is reused to reconcile the layer after it.
  const arcgisSessions = new Map<string, ArcGISOutboxSession | undefined>();
  registerEditSyncBackend("arcgis", {
    createAdapter: async (entry) => {
      const session = await arcgisSession(entry.layerId);
      arcgisSessions.set(entry.id, session);
      return createArcGISSyncAdapter(entry, session);
    },
    afterSync: async (entry, outcome) => {
      const session = arcgisSessions.get(entry.id);
      arcgisSessions.delete(entry.id);
      await reconcileArcGISLayerAfterSync(entry, outcome, {
        getLayer: (id) => useAppStore.getState().layers.find((layer) => layer.id === id),
        updateLayer: (id, patch) => useAppStore.getState().updateLayer(id, patch),
        session,
      });
    },
  });

  registerEditSyncBackend("geolens", {
    createAdapter: (entry) =>
      createGeoLensSyncAdapter(
        entry,
        getActiveGeoLensClient(String((entry.target as { baseUrl?: unknown }).baseUrl ?? "")),
      ),
    afterSync: async (entry, outcome) => {
      await reconcileGeoLensLayerAfterSync(entry, outcome, {
        getLayer: (id) => useAppStore.getState().layers.find((layer) => layer.id === id),
        updateLayer: (id, patch) => useAppStore.getState().updateLayer(id, patch),
        getBaseline: getGeoLensBaseline,
        setBaseline: setGeoLensBaseline,
        connection: getActiveGeoLensClient(
          String((entry.target as { baseUrl?: unknown }).baseUrl ?? ""),
        ),
      });
    },
  });
  // The GeoLens panel's Save button queues through the outbox.
  setGeoLensSaveHandler(async (request) => {
    const store = useAppStore.getState();
    const layer = store.layers.find((candidate) => candidate.id === request.layerId);
    if (!layer?.geojson) return { written: 0, errors: [] };
    const geojson = withGeoLensLocalIds(layer.geojson);
    if (geojson !== layer.geojson) store.updateLayer(layer.id, { geojson });
    const target = geolensOutboxTarget(
      request.client.baseUrl,
      request.datasetId,
      request.baseline,
      request.featureLimit ?? 10_000,
    );
    const result = await saveThroughOutbox(
      {
        id: geolensOutboxId(target),
        backend: "geolens",
        target,
        targetLabel: request.layerName,
        layerId: request.layerId,
        layerName: request.layerName,
        ops: buildGeoLensChangeSet(geojson, request.baseline),
        session: editSessionToken(layer.id, store.projectGeneration),
      },
      i18n.t.bind(i18n),
    );
    const outcome = result.outcome;
    return {
      written: outcome ? outcome.inserted + outcome.updated + outcome.deleted : 0,
      errors: result.status === "error" ? [result.message] : [],
      message: result.message,
    };
  });
}
