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
import { writeVectorToSource } from "@geolibre/processing";
import { readLocalFileBytes } from "../file-io/local-fs";
import { isTauri } from "../is-tauri";
import { startGeoLibreSidecar } from "../sidecar";
import { editSessionToken, registerEditSyncBackend } from "./edit-outbox-runner";
import {
  captureGeoPackageBaseline,
  createGeoPackageSyncAdapter,
  pruneGeoPackageBaselines,
  reconcileGeoPackageLayerAfterSync,
  sha256Hex,
} from "./geopackage-edit-sync";
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
      // Kept only once the adapter exists, so a refused attempt holds no token.
      const adapter = createArcGISSyncAdapter(entry, session);
      arcgisSessions.set(entry.id, session);
      return adapter;
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
    // Never keep a token-bearing session past its attempt.
    afterAttempt: (entry) => {
      arcgisSessions.delete(entry.id);
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
    if (!layer?.geojson) {
      const message = i18n.t("editOutbox.save.layerGone");
      return { written: 0, errors: [message], message };
    }
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
        id: geolensOutboxId(target, request.layerId),
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

  registerEditSyncBackend("geopackage", {
    createAdapter: (entry) =>
      createGeoPackageSyncAdapter(entry, {
        readFile: readLocalFileBytes,
        parse: async (bytes, path, layer) => {
          const { loadDuckDbVectorFile } = await import("../duckdb-vector-loader");
          const name = path.split(/[\\/]/).pop() ?? "layer.gpkg";
          return loadDuckDbVectorFile(
            { name, extension: "gpkg", data: bytes },
            layer ? { layer } : {},
          );
        },
        write: async (request) => {
          if (isTauri()) await startGeoLibreSidecar();
          return writeVectorToSource(request);
        },
        sha256: sha256Hex,
      }),
    afterSync: (entry, outcome) => {
      reconcileGeoPackageLayerAfterSync(entry, outcome, {
        getLayer: (id) => useAppStore.getState().layers.find((layer) => layer.id === id),
        updateLayer: (id, patch) => useAppStore.getState().updateLayer(id, patch),
      });
    },
  });
  // Record each GeoPackage layer's base as it appears, before it is edited.
  // A layer restored with a project carries the project's copy of its
  // features, which may hold edits saved into the project (a save drops the
  // edited flag), so only one re-read from its file (localFileReloadable)
  // counts; others keep the direct save.
  const restored = new Set<string>();
  const markRestored = (layers: ReturnType<typeof useAppStore.getState>["layers"]) => {
    for (const layer of layers) {
      if (layer.metadata.localFileReloadable !== true) restored.add(layer.id);
    }
  };
  const captureBases = (layers: ReturnType<typeof useAppStore.getState>["layers"]) => {
    for (const layer of layers) {
      if (!restored.has(layer.id)) captureGeoPackageBaseline(layer);
    }
    pruneGeoPackageBaselines(layers.map((layer) => layer.id));
  };
  markRestored(useAppStore.getState().layers);
  captureBases(useAppStore.getState().layers);
  useAppStore.subscribe((state, previous) => {
    if (state.projectGeneration !== previous.projectGeneration) {
      restored.clear();
      markRestored(state.layers);
    }
    if (state.layers !== previous.layers) captureBases(state.layers);
  });
}
