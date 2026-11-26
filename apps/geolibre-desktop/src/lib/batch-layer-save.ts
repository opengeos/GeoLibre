/**
 * Batch "Save edits to source file" and external copy helpers (issue #3528).
 *
 * Centralizes source-writeback discovery, execution, and post-save cleanup so
 * single-layer write-back, Project → Save layer edits to source files, and the
 * Save project prompt all apply the same capability, collaboration, and
 * project-generation guards.
 */

import {
  resolveLayerCapabilities,
  useAppStore,
  type CollaborationState,
  type GeoLibreLayer,
} from "@geolibre/core";
import {
  arcGISLayerHasPendingEdits,
  isArcGISWritableLayer,
  saveArcGISLayerEdits,
} from "@geolibre/plugins/arcgis-layer";
import {
  fetchMssqlStatus,
  PostgisWriteRejectedError,
  readMssqlTable,
  readPostgisTable,
  writeMssqlTable,
  writePostgisTable,
  writeVectorToSource,
} from "@geolibre/processing";
import type { FeatureCollection } from "geojson";
import type { TFunction } from "i18next";
import type { Map as MapLibreMap } from "maplibre-gl";
import {
  canWriteEditsToSource,
  isMssqlEditableLayer,
  isPostgisEditableLayer,
} from "../components/panels/layer-panel/layer-panel-utils";
import {
  commitPendingAttributeDrafts,
  type PendingAttributeDraftsResult,
} from "./attribute-draft-commit";
import { participantCanEditLayer } from "./collab-protocol";
import { databaseBaselineKeys, databaseFeatureKeys } from "./database-tables";
import { embedEditedGeometry, hasEditedGeometry } from "./edited-geometry-save";
import {
  arcgisOutboxId,
  arcgisOutboxTarget,
  buildArcGISChangeSet,
  withLocalFeatureIds,
} from "./edit-sync/arcgis-edit-sync";
import { editSessionToken } from "./edit-sync/edit-outbox-runner";
import { saveThroughOutbox } from "./edit-sync/outbox-save";
import { ensureEditSyncBackends } from "./edit-sync/register-backends";
import {
  buildPostgisChangeSet,
  EDIT_SYNC_BASELINE_KEY,
  EDIT_SYNC_REFRESH_REQUIRED_KEY,
  hasPostgisSyncBaseline,
  postgisOutboxId,
  postgisOutboxTarget,
  postgisSyncBaseline,
  recoverPostgisLayer,
} from "./edit-sync/postgis-edit-sync";
import { isGeojsonSourcePath, isImportedDocumentCopyPath, joinLocalPath } from "./file-io/paths";
import { collectGeojsonLayersForExport, type CollectGeojsonExportDeps } from "./geojson-zip-export";
import { isTauri } from "./is-tauri";
import { isDesktopRuntime } from "./is-mobile";
import { localFileSourceLayer } from "./local-file-source";
import { MssqlReconnectRequiredError, withMssqlSession } from "./mssql-sessions";
import {
  mssqlWritePayload,
  reconcileMssqlWritebackMetadata,
  rememberMssqlLoadedRows,
  runMssqlWriteRequest,
  writeMssqlAndRefresh,
} from "./mssql-writeback";
import { resolvePostgisConnection } from "./postgis-connections";
import { startGeoLibreSidecar } from "./sidecar";
import { writeLocalGeojsonFile, writeNewTextFileToPath } from "./tauri-io";
import { resolveLayerGeojson } from "./vector-export";

export type WritableLayerSourceKind = "geojson" | "geopackage" | "postgis" | "mssql" | "arcgis";

export type LayerWriteBackDisabledReason =
  | "geometryEditActive"
  | "mssqlRefreshRequired"
  | "postgisRefreshRequired"
  | "readOnlyCollaboration";

/** A layer that has a writable backing source, annotated for the batch-save modal. */
export interface WritableLayerCandidate {
  layer: GeoLibreLayer;
  kind: WritableLayerSourceKind;
  destinationLabel: string;
  hasPendingEdits: boolean;
  disabledReason?: LayerWriteBackDisabledReason;
}

/** Result of writing one layer's edits back to its source. */
export interface SingleLayerWriteBackResult {
  status: "success" | "warning" | "error";
  message: string;
  /** True when the save was silently ignored (e.g. stale request or already in flight). */
  silent?: boolean;
}

/** Per-layer outcome in a batch write-back run. */
export interface BatchLayerSaveItemResult extends SingleLayerWriteBackResult {
  layerId: string;
  layerName: string;
}

/** Aggregate summary of a batch write-back run. */
export interface BatchLayerSaveSummary {
  results: BatchLayerSaveItemResult[];
  succeeded: number;
  warnings: number;
  failed: number;
  aborted: boolean;
}

/** Shared in-flight set for SQL Server write-backs across single-layer and batch entrypoints. */
export const sharedSavingMssqlEditsIds = new Set<string>();

interface PostgisPendingRefreshEntry {
  schema: string;
  table: string;
  baselineKeys: unknown;
}

/**
 * PostGIS layers whose write committed but whose follow-up reread failed.
 * Keyed by `${projectGeneration}\0${layerId}` and pinned to the stale
 * `postgisBaselineKeys` reference so retrying before reloading cannot
 * double-insert keyless features.
 */
const postgisRefreshRequiredMap = new Map<string, PostgisPendingRefreshEntry>();

function postgisRefreshKey(projectGeneration: number, layerId: string): string {
  return `${projectGeneration}\0${layerId}`;
}

export function markPostgisWritebackRefreshRequired(
  layer: GeoLibreLayer,
  projectGeneration: number,
): void {
  const schema =
    typeof layer.metadata.postgisSchema === "string" ? layer.metadata.postgisSchema : "public";
  const table = typeof layer.metadata.postgisTable === "string" ? layer.metadata.postgisTable : "";
  postgisRefreshRequiredMap.set(postgisRefreshKey(projectGeneration, layer.id), {
    schema,
    table,
    baselineKeys: layer.metadata.postgisBaselineKeys,
  });
}

export function clearPostgisWritebackRefreshRequired(
  layerId: string,
  projectGeneration: number,
): void {
  postgisRefreshRequiredMap.delete(postgisRefreshKey(projectGeneration, layerId));
}

export function isPostgisWritebackRefreshRequired(
  layer: GeoLibreLayer,
  projectGeneration: number,
): boolean {
  const entry = postgisRefreshRequiredMap.get(postgisRefreshKey(projectGeneration, layer.id));
  if (!entry) return false;
  const schema =
    typeof layer.metadata.postgisSchema === "string" ? layer.metadata.postgisSchema : "public";
  const table = typeof layer.metadata.postgisTable === "string" ? layer.metadata.postgisTable : "";
  if (
    entry.schema !== schema ||
    entry.table !== table ||
    entry.baselineKeys !== layer.metadata.postgisBaselineKeys
  ) {
    postgisRefreshRequiredMap.delete(postgisRefreshKey(projectGeneration, layer.id));
    return false;
  }
  return true;
}

/**
 * Mirror of `useCollaboration`'s `canEditLayer`, readable outside React hooks.
 */
export function canCollaboratorEditLayer(
  collaboration: CollaborationState | undefined,
  layerId: string,
): boolean {
  if (!collaboration || !collaboration.isActive) return true;
  if (collaboration.role === "host") return true;
  const self = collaboration.participants.find((p) => p.clientId === collaboration.clientId);
  if (!self) {
    return (
      collaboration.mode === "co-edit" && !(collaboration.lockedLayerIds ?? []).includes(layerId)
    );
  }
  return participantCanEditLayer(
    self,
    collaboration.mode,
    layerId,
    collaboration.lockedLayerIds ?? [],
  );
}

/** Classify a writable layer's backing source, or return null if not writable. */
export function writableLayerSourceKind(layer: GeoLibreLayer): WritableLayerSourceKind | null {
  if (isArcGISWritableLayer(layer)) return "arcgis";
  if (isMssqlEditableLayer(layer)) return "mssql";
  if (isPostgisEditableLayer(layer)) return "postgis";
  const path = typeof layer.sourcePath === "string" ? layer.sourcePath.trim() : "";
  if (!path) return null;
  if (isGeojsonSourcePath(path)) return "geojson";
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "gpkg") return "geopackage";
  return null;
}

/** Human-readable target shown beside a layer in the Save layer edits modal. */
export function writableLayerDestinationLabel(
  layer: GeoLibreLayer,
  kind: WritableLayerSourceKind,
): string {
  if (kind === "mssql") {
    const schema =
      typeof layer.metadata.mssqlSchema === "string" ? layer.metadata.mssqlSchema : "dbo";
    return `${schema}.${String(layer.metadata.mssqlTable ?? "")}`;
  }
  if (kind === "postgis") {
    const schema =
      typeof layer.metadata.postgisSchema === "string" ? layer.metadata.postgisSchema : "public";
    return `${schema}.${String(layer.metadata.postgisTable ?? "")}`;
  }
  if (kind === "arcgis") {
    const url =
      typeof layer.source.url === "string"
        ? layer.source.url
        : typeof layer.sourcePath === "string"
          ? layer.sourcePath
          : "";
    return url || layer.name;
  }
  return typeof layer.sourcePath === "string" ? layer.sourcePath.trim() : layer.name;
}

/**
 * List every layer in the project that supports Save edits to source file,
 * along with its pending-edit status and any active blocker.
 */
export function listWritableLayerCandidates(
  layers: readonly GeoLibreLayer[],
  options?: {
    collaboration?: CollaborationState;
    geometryEditLayerId?: string | null;
    attributeTableDrafts?: Record<string, unknown>;
    projectGeneration?: number;
    /** Override for unit tests (defaults to {@link canWriteEditsToSource}). */
    canWriteSource?: (layer: GeoLibreLayer) => boolean;
  },
): WritableLayerCandidate[] {
  const canWriteSource = options?.canWriteSource ?? canWriteEditsToSource;
  const projectGeneration = options?.projectGeneration ?? useAppStore.getState().projectGeneration;
  const candidates: WritableLayerCandidate[] = [];
  for (const layer of layers) {
    if (!canWriteSource(layer)) continue;
    const caps = resolveLayerCapabilities(layer);
    if (!(caps.update || caps.create || caps.delete)) continue;
    const kind = writableLayerSourceKind(layer);
    if (!kind) continue;

    let disabledReason: LayerWriteBackDisabledReason | undefined;
    if (!canCollaboratorEditLayer(options?.collaboration, layer.id)) {
      disabledReason = "readOnlyCollaboration";
    } else if (options?.geometryEditLayerId === layer.id) {
      disabledReason = "geometryEditActive";
    } else if (kind === "mssql" && layer.mssqlWritebackPending === true) {
      disabledReason = "mssqlRefreshRequired";
    } else if (kind === "postgis" && isPostgisWritebackRefreshRequired(layer, projectGeneration)) {
      disabledReason = "postgisRefreshRequired";
    }

    const hasPendingEdits =
      hasEditedGeometry(layer) || Boolean(options?.attributeTableDrafts?.[layer.id]);

    candidates.push({
      layer,
      kind,
      destinationLabel: writableLayerDestinationLabel(layer, kind),
      hasPendingEdits,
      disabledReason,
    });
  }
  return candidates;
}

/**
 * Pick the initial checkbox selection when opening the Save layer edits modal:
 * if any enabled writable layers carry pending edits, select those; otherwise
 * select all enabled writable layers.
 */
export function defaultSelectedWritableLayerIds(
  candidates: readonly WritableLayerCandidate[],
): string[] {
  const enabled = candidates.filter((candidate) => !candidate.disabledReason);
  const edited = enabled.filter((candidate) => candidate.hasPendingEdits);
  return (edited.length > 0 ? edited : enabled).map((candidate) => candidate.layer.id);
}

/**
 * Strip the transient `metadata.geometryEdited` flag from a live store layer
 * after its edits have been written back to its backing source. Does not push
 * an undo entry or dirty the project. When `expectedGeojson` is supplied, the
 * flag is cleared only if the live layer still carries that same GeoJSON
 * revision, so edits committed while the write was in flight remain flagged.
 */
export function clearLayerGeometryEditedFlag(
  layerId: string,
  expectedProjectGeneration?: number,
  expectedGeojson?: FeatureCollection,
): void {
  const state = useAppStore.getState();
  if (
    expectedProjectGeneration !== undefined &&
    state.projectGeneration !== expectedProjectGeneration
  ) {
    return;
  }
  const existing = state.layers.find((candidate) => candidate.id === layerId);
  if (!existing || existing.metadata.geometryEdited !== true) return;
  if (expectedGeojson !== undefined && existing.geojson !== expectedGeojson) return;
  const { geometryEdited: _cleared, ...metadata } = existing.metadata;
  useAppStore.setState((current) => ({
    layers: current.layers.map((candidate) =>
      candidate.id === layerId ? { ...candidate, metadata } : candidate,
    ),
  }));
}

/** Queue-and-sync with the built-in backends registered (they load lazily elsewhere). */
const defaultSaveOutbox: typeof saveThroughOutbox = (input, t, outboxDeps) => {
  ensureEditSyncBackends();
  return saveThroughOutbox(input, t, outboxDeps);
};

/** Injectable dependencies for {@link writeLayerEditsToSource} (unit tests). */
export interface WriteLayerEditsDeps {
  isDesktop?: () => boolean;
  commitDrafts?: (layerId: string) => PendingAttributeDraftsResult;
  readLatestLayer?: (layerId: string) => GeoLibreLayer | undefined;
  readProjectGeneration?: () => number;
  resolveGeojson?: (
    layer: GeoLibreLayer,
    map: MapLibreMap | undefined,
  ) => Promise<FeatureCollection | null>;
  writeLocalGeojson?: (path: string, geojson: FeatureCollection) => Promise<void>;
  startSidecar?: () => Promise<void>;
  writeVectorSource?: typeof writeVectorToSource;
  writePostgis?: typeof writePostgisTable;
  readPostgis?: typeof readPostgisTable;
  resolvePostgisConn?: typeof resolvePostgisConnection;
  saveArcgis?: typeof saveArcGISLayerEdits;
  hasArcgisPendingEdits?: (layerId: string) => boolean;
  clearGeometryEdited?: (
    layerId: string,
    expectedProjectGeneration?: number,
    expectedGeojson?: FeatureCollection,
  ) => void;
  updateLayer?: (layerId: string, patch: Partial<GeoLibreLayer>) => void;
  markMssqlRefreshRequired?: (layerId: string) => void;
  inFlightMssqlIds?: Set<string>;
  /** Queue-and-sync through the offline edit outbox (#3530). */
  saveOutbox?: typeof saveThroughOutbox;
  /** Reload a PostGIS layer whose last sync could not be reloaded. */
  recoverPostgis?: (layer: GeoLibreLayer) => Promise<boolean>;
}

/**
 * Commit one layer's current features back to its backing source (local GeoJSON,
 * GeoPackage, PostGIS, SQL Server, or ArcGIS feature service).
 */
export async function writeLayerEditsToSource(
  clickedLayer: GeoLibreLayer,
  options: {
    map: MapLibreMap | undefined;
    t: TFunction;
    canEditLayer?: (layerId: string) => boolean;
    deps?: WriteLayerEditsDeps;
  },
): Promise<SingleLayerWriteBackResult> {
  const { map, t, deps } = options;
  const isDesktop = deps?.isDesktop ?? isTauri;
  const commitDrafts = deps?.commitDrafts ?? commitPendingAttributeDrafts;
  const readLatestLayer =
    deps?.readLatestLayer ??
    ((layerId: string) =>
      useAppStore.getState().layers.find((candidate) => candidate.id === layerId));
  const readProjectGeneration =
    deps?.readProjectGeneration ?? (() => useAppStore.getState().projectGeneration);
  const resolveGeojson = deps?.resolveGeojson ?? resolveLayerGeojson;
  const writeLocalGeojson = deps?.writeLocalGeojson ?? writeLocalGeojsonFile;
  const startSidecar = deps?.startSidecar ?? startGeoLibreSidecar;
  const writeVectorSource = deps?.writeVectorSource ?? writeVectorToSource;
  const writePostgis = deps?.writePostgis ?? writePostgisTable;
  const readPostgis = deps?.readPostgis ?? readPostgisTable;
  const resolvePostgisConn = deps?.resolvePostgisConn ?? resolvePostgisConnection;
  const saveArcgis = deps?.saveArcgis ?? saveArcGISLayerEdits;
  const hasArcgisPendingEdits = deps?.hasArcgisPendingEdits ?? arcGISLayerHasPendingEdits;
  const clearGeometryEdited = deps?.clearGeometryEdited ?? clearLayerGeometryEditedFlag;
  const updateLayer = deps?.updateLayer ?? useAppStore.getState().updateLayer;
  const markMssqlRefreshRequired =
    deps?.markMssqlRefreshRequired ??
    ((layerId: string) => {
      useAppStore.getState().updateLayer(layerId, { mssqlWritebackPending: true });
    });
  const inFlightMssqlIds = deps?.inFlightMssqlIds ?? sharedSavingMssqlEditsIds;

  const canEdit =
    options.canEditLayer ??
    ((layerId: string) => canCollaboratorEditLayer(useAppStore.getState().collaboration, layerId));

  if (!canEdit(clickedLayer.id)) {
    return { status: "error", message: t("layers.saveEditsError"), silent: true };
  }

  const requestProjectGeneration = readProjectGeneration();
  const currentBeforeCommit = readLatestLayer(clickedLayer.id);
  if (!currentBeforeCommit) {
    return { status: "error", message: t("layers.saveEditsError"), silent: true };
  }
  if (isTauri() && !isDesktopRuntime() && !canWriteEditsToSource(currentBeforeCommit)) {
    return { status: "error", message: t("layers.saveEditsError"), silent: true };
  }
  if (
    isMssqlEditableLayer(currentBeforeCommit) &&
    currentBeforeCommit.mssqlWritebackPending === true
  ) {
    return { status: "error", message: t("layers.saveEditsMssqlRefreshRequired"), silent: true };
  }
  if (
    isPostgisEditableLayer(currentBeforeCommit) &&
    isPostgisWritebackRefreshRequired(currentBeforeCommit, requestProjectGeneration)
  ) {
    return { status: "error", message: t("layers.saveEditsPostgisRefreshWarning") };
  }

  let isMssql = false;
  let isCurrentMssqlRequest = () => false;

  try {
    if (commitDrafts(clickedLayer.id) === "blocked") {
      return { status: "error", message: t("layers.pendingTableDraftsBlocked") };
    }

    const layer = readLatestLayer(clickedLayer.id);
    if (!layer || readProjectGeneration() !== requestProjectGeneration) {
      return { status: "error", message: t("layers.saveEditsError") };
    }
    isMssql = isMssqlEditableLayer(layer);
    const mssqlBaseline = isMssql ? databaseBaselineKeys(layer, "mssqlBaselineKeys") : undefined;
    isCurrentMssqlRequest = () => {
      const current = readLatestLayer(layer.id);
      return (
        readProjectGeneration() === requestProjectGeneration &&
        current !== undefined &&
        current.metadata.sourceKind === layer.metadata.sourceKind &&
        current.metadata.mssqlConnectionId === layer.metadata.mssqlConnectionId &&
        current.metadata.mssqlSchema === layer.metadata.mssqlSchema &&
        current.metadata.mssqlTable === layer.metadata.mssqlTable &&
        current.metadata.mssqlGeometryColumn === layer.metadata.mssqlGeometryColumn
      );
    };
    const isPostgis = isPostgisEditableLayer(layer);
    const isCurrentPostgisRequest = () => {
      const current = readLatestLayer(layer.id);
      return (
        readProjectGeneration() === requestProjectGeneration &&
        current !== undefined &&
        current.metadata.sourceKind === layer.metadata.sourceKind &&
        current.metadata.postgisSchema === layer.metadata.postgisSchema &&
        current.metadata.postgisTable === layer.metadata.postgisTable &&
        current.metadata.postgisGeometryColumn === layer.metadata.postgisGeometryColumn
      );
    };
    const path = typeof layer.sourcePath === "string" ? layer.sourcePath.trim() : "";
    if (!isMssql && !isPostgis && !isArcGISWritableLayer(layer) && !path) {
      return { status: "error", message: t("layers.saveEditsError"), silent: true };
    }

    if (isArcGISWritableLayer(layer) && layer.metadata.arcgisSaveUncertain !== true) {
      // Offline-first save (#3530): queue the changed features, then sync with
      // per-feature conflict detection against the service's current version.
      const target = arcgisOutboxTarget(layer);
      if (target && layer.geojson) {
        // New features need a stable id to receive their assigned object ID.
        const geojsonWithIds = withLocalFeatureIds(layer.geojson, target.objectIdField);
        if (geojsonWithIds !== layer.geojson) updateLayer(layer.id, { geojson: geojsonWithIds });
        const ops = buildArcGISChangeSet({ ...layer, geojson: geojsonWithIds }, target);
        if (ops) {
          const saveOutbox = deps?.saveOutbox ?? defaultSaveOutbox;
          return await saveOutbox(
            {
              id: arcgisOutboxId(target),
              backend: "arcgis",
              target,
              targetLabel: layer.name,
              layerId: layer.id,
              layerName: layer.name,
              ops,
              session: editSessionToken(layer.id, requestProjectGeneration),
            },
            t,
          );
        }
      }
    }

    if (isArcGISWritableLayer(layer)) {
      const result = await saveArcgis(layer.id);
      if (result.errors.length === 0 && !hasArcgisPendingEdits(layer.id)) {
        clearGeometryEdited(layer.id, requestProjectGeneration);
      }
      return {
        status: result.errors.length ? "warning" : "success",
        message: [t("layers.saveEditsArcgisSuccess", result), ...result.errors].join(" "),
      };
    }

    const geojson = await resolveGeojson(layer, map);
    const liveAfterResolve = readLatestLayer(layer.id);
    if (!liveAfterResolve || readProjectGeneration() !== requestProjectGeneration) {
      return { status: "error", message: t("layers.saveEditsError") };
    }
    if (
      !geojson ||
      (geojson.features.length === 0 && !(isMssql && (mssqlBaseline?.length ?? 0) > 0))
    ) {
      return { status: "error", message: t("layers.saveEditsNoFeatures") };
    }

    if (isMssql) {
      const connectionId = layer.metadata.mssqlConnectionId as string;
      const schema =
        typeof layer.metadata.mssqlSchema === "string" ? layer.metadata.mssqlSchema : "dbo";
      const table = layer.metadata.mssqlTable as string;
      const geometryColumn =
        typeof layer.metadata.mssqlGeometryColumn === "string"
          ? layer.metadata.mssqlGeometryColumn
          : undefined;
      const payload = mssqlWritePayload(layer.id, requestProjectGeneration, geojson);
      const outcome = await writeMssqlAndRefresh(
        {
          layerId: layer.id,
          inFlightLayerIds: inFlightMssqlIds,
          refreshRequired: readLatestLayer(layer.id)?.mssqlWritebackPending === true,
          baselineKeys: mssqlBaseline,
          isCurrent: isCurrentMssqlRequest,
        },
        () =>
          withMssqlSession(connectionId, async (sessionId) => {
            await fetchMssqlStatus();
            if (!isCurrentMssqlRequest()) {
              throw new Error("Project changed before the SQL Server write was sent.");
            }
            return runMssqlWriteRequest(() =>
              writeMssqlTable({
                session_id: sessionId,
                schema_name: schema,
                table,
                geometry_column: geometryColumn,
                geojson,
                baseline_keys: mssqlBaseline,
                unchanged_geometry_keys: payload.unchangedGeometryKeys,
                changed_columns: payload.changedColumns,
                capabilities: resolveLayerCapabilities(layer),
              }),
            );
          }),
        () =>
          withMssqlSession(connectionId, (sessionId) =>
            readMssqlTable({
              session_id: sessionId,
              schema_name: schema,
              table,
              geometry_column: geometryColumn,
              excluded_fields: layer.fieldVisibility
                ? Object.keys(layer.fieldVisibility).filter(
                    (key) => layer.fieldVisibility![key] === "excluded",
                  )
                : undefined,
            }),
          ),
      );
      if (!isCurrentMssqlRequest() || outcome.kind === "blocked" || outcome.kind === "stale") {
        return { status: "error", message: t("layers.saveEditsError"), silent: true };
      }
      if (outcome.kind === "missing-baseline") {
        return { status: "error", message: t("layers.saveEditsMssqlMissingBaseline") };
      }
      if (outcome.kind === "write-rejected") {
        if (outcome.error instanceof MssqlReconnectRequiredError) throw outcome.error;
        return {
          status: "error",
          message: t("layers.saveEditsMssqlWriteRejected", {
            error:
              outcome.error instanceof Error ? outcome.error.message : t("layers.saveEditsError"),
          }),
        };
      }
      if (outcome.kind === "write-failed") {
        markMssqlRefreshRequired(layer.id);
        return {
          status: "error",
          message: t("layers.saveEditsMssqlWriteUncertain", {
            error:
              outcome.error instanceof Error ? outcome.error.message : t("layers.saveEditsError"),
          }),
        };
      }
      if (outcome.kind === "refresh-failed") {
        markMssqlRefreshRequired(layer.id);
        return { status: "error", message: t("layers.saveEditsMssqlRefreshWarning") };
      }
      const { writeResult: result, refreshed: fresh } = outcome;
      const currentMetadata = readLatestLayer(layer.id)?.metadata ?? layer.metadata;
      const { geometryEdited: _cleared, ...reconciledMetadata } = reconcileMssqlWritebackMetadata(
        currentMetadata,
        fresh,
      );
      updateLayer(layer.id, {
        geojson: fresh.geojson,
        metadata: reconciledMetadata,
      });
      const primaryKey = layer.metadata.mssqlPrimaryKey;
      if (typeof primaryKey === "string") {
        rememberMssqlLoadedRows(layer.id, requestProjectGeneration, primaryKey, fresh.geojson);
      }
      let message = t("layers.saveEditsMssqlSuccess", {
        table: `${schema}.${table}`,
        inserted: result.inserted,
        updated: result.updated,
        deleted: result.deleted,
      });
      let status: "success" | "warning" = "success";
      if (result.skipped_fields?.length) {
        status = "warning";
        message = `${message} ${t("layers.saveEditsMssqlSkippedFields", {
          fields: result.skipped_fields.join(", "),
        })}`;
      }
      return { status, message };
    }

    if (isPostgis && layer.metadata[EDIT_SYNC_REFRESH_REQUIRED_KEY]) {
      // A sync landed but the layer was not reloaded: saving now could send
      // its new features twice. Reload it first; the user then saves again.
      const recover = deps?.recoverPostgis ?? recoverPostgisLayer;
      return (await recover(layer))
        ? { status: "warning", message: t("editOutbox.save.reloaded") }
        : { status: "error", message: t("layers.saveEditsPostgisRefreshWarning") };
    }
    if (isPostgis && hasPostgisSyncBaseline(layer)) {
      // Offline-first save (#3530): queue only the changed features, then sync
      // with per-row conflict detection. The queue survives a lost connection.
      const target = postgisOutboxTarget(layer);
      const ops = target ? buildPostgisChangeSet(layer, geojson) : null;
      if (target && ops) {
        const saveOutbox = deps?.saveOutbox ?? defaultSaveOutbox;
        return await saveOutbox(
          {
            id: postgisOutboxId(target, layer.id),
            backend: "postgis",
            target,
            targetLabel: `${target.schema}.${target.table}`,
            layerId: layer.id,
            layerName: layer.name,
            ops,
            session: editSessionToken(layer.id, requestProjectGeneration),
          },
          t,
        );
      }
    }

    if (isPostgis) {
      const connection = resolvePostgisConn(layer);
      if (!connection) {
        return { status: "error", message: t("layers.saveEditsPostgisNoConnection") };
      }
      const schema =
        typeof layer.metadata.postgisSchema === "string" ? layer.metadata.postgisSchema : "public";
      const table = layer.metadata.postgisTable as string;
      const geometryColumn =
        typeof layer.metadata.postgisGeometryColumn === "string"
          ? layer.metadata.postgisGeometryColumn
          : undefined;
      let result;
      try {
        result = await writePostgis({
          connection,
          schema_name: schema,
          table,
          geometry_column: geometryColumn,
          geojson,
          baseline_keys: databaseBaselineKeys(layer, "postgisBaselineKeys"),
          capabilities: resolveLayerCapabilities(layer),
        });
      } catch (error) {
        // Only a definite HTTP rejection guarantees the sidecar transaction
        // rolled back; a network/decode failure may follow a committed write,
        // so require a reload before retrying to prevent duplicate inserts.
        if (!(error instanceof PostgisWriteRejectedError) && isCurrentPostgisRequest()) {
          markPostgisWritebackRefreshRequired(layer, requestProjectGeneration);
        }
        throw error;
      }
      const excludedList = layer.fieldVisibility
        ? Object.keys(layer.fieldVisibility).filter((k) => layer.fieldVisibility![k] === "excluded")
        : [];
      const excludedFields = excludedList.length ? excludedList : undefined;
      let fresh;
      try {
        fresh = await readPostgis({
          connection,
          schema_name: schema,
          table,
          geometry_column: geometryColumn,
          excluded_fields: layer.fieldVisibility ? excludedList : undefined,
        });
      } catch {
        if (isCurrentPostgisRequest()) {
          markPostgisWritebackRefreshRequired(layer, requestProjectGeneration);
        }
        return { status: "error", message: t("layers.saveEditsPostgisRefreshWarning") };
      }
      if (!isCurrentPostgisRequest()) {
        return { status: "error", message: t("layers.saveEditsError") };
      }
      clearPostgisWritebackRefreshRequired(layer.id, requestProjectGeneration);
      const currentMetadata = readLatestLayer(layer.id)?.metadata ?? layer.metadata;
      const { geometryEdited: _cleared, ...restMetadata } = currentMetadata;
      updateLayer(layer.id, {
        geojson: fresh.geojson,
        metadata: {
          ...restMetadata,
          featureCount: fresh.feature_count,
          postgisBaselineKeys: databaseFeatureKeys(fresh.geojson),
          // From now on this layer saves through the offline edit outbox. Not
          // when this read dropped "excluded" columns: the outbox compares
          // full rows, so a base without them would fake conflicts.
          ...(excludedFields
            ? {}
            : {
                [EDIT_SYNC_BASELINE_KEY]: postgisSyncBaseline(
                  fresh.geojson,
                  typeof layer.metadata.postgisPrimaryKey === "string"
                    ? layer.metadata.postgisPrimaryKey
                    : undefined,
                ),
              }),
        },
      });
      let message = t("layers.saveEditsPostgisSuccess", {
        table: `${schema}.${table}`,
        inserted: result.inserted,
        updated: result.updated,
        deleted: result.deleted,
      });
      let status: "success" | "warning" = "success";
      if (result.skipped_fields?.length) {
        status = "warning";
        message = `${message} ${t("layers.saveEditsPostgisSkippedFields", {
          fields: result.skipped_fields.join(", "),
        })}`;
      }
      return { status, message };
    }

    if (isDesktop() && isGeojsonSourcePath(path)) {
      await writeLocalGeojson(path, geojson);
      clearGeometryEdited(layer.id, requestProjectGeneration, geojson);
      return {
        status: "success",
        message: t(
          isImportedDocumentCopyPath(path)
            ? "layers.saveEditsImportedCopySuccess"
            : "layers.saveEditsSuccess",
          { count: geojson.features.length },
        ),
      };
    }

    if (isDesktop()) await startSidecar();
    const sourceLayer = localFileSourceLayer(layer);
    const result = await writeVectorSource({
      path,
      geojson,
      layer: sourceLayer || undefined,
    });
    clearGeometryEdited(layer.id, requestProjectGeneration, geojson);
    return {
      status: "success",
      message: t(
        isImportedDocumentCopyPath(path)
          ? "layers.saveEditsImportedCopySuccess"
          : "layers.saveEditsSuccess",
        { count: result.feature_count },
      ),
    };
  } catch (error) {
    if (isMssql && !isCurrentMssqlRequest()) {
      return { status: "error", message: t("layers.saveEditsError"), silent: true };
    }
    const message =
      error instanceof MssqlReconnectRequiredError
        ? t("layers.saveEditsMssqlNoConnection")
        : error instanceof Error
          ? error.message
          : t("layers.saveEditsError");
    return { status: "error", message };
  }
}

/**
 * Sequentially write each selected layer's edits back to its source, aborting
 * cleanly if the user switches projects mid-run.
 */
export async function saveLayerEditsBatch(
  layers: readonly GeoLibreLayer[],
  options: {
    map: MapLibreMap | undefined;
    t: TFunction;
    projectGeneration: number;
    onLayerStart?: (layerId: string) => void;
    onLayerDone?: (result: BatchLayerSaveItemResult) => void;
    canEditLayer?: (layerId: string) => boolean;
    deps?: WriteLayerEditsDeps;
  },
): Promise<BatchLayerSaveSummary> {
  const readProjectGeneration =
    options.deps?.readProjectGeneration ?? (() => useAppStore.getState().projectGeneration);
  const readLatestLayer =
    options.deps?.readLatestLayer ??
    ((layerId: string) =>
      useAppStore.getState().layers.find((candidate) => candidate.id === layerId));
  const results: BatchLayerSaveItemResult[] = [];
  let succeeded = 0;
  let warnings = 0;
  let failed = 0;
  let aborted = false;

  for (const layer of layers) {
    if (readProjectGeneration() !== options.projectGeneration) {
      aborted = true;
      break;
    }
    const liveLayer = readLatestLayer(layer.id);
    if (!liveLayer) continue;
    options.onLayerStart?.(liveLayer.id);
    let outcome: SingleLayerWriteBackResult;
    try {
      outcome = await writeLayerEditsToSource(liveLayer, {
        map: options.map,
        t: options.t,
        canEditLayer: options.canEditLayer,
        deps: options.deps,
      });
    } catch (error) {
      outcome = {
        status: "error",
        message: error instanceof Error ? error.message : options.t("layers.saveEditsError"),
      };
    }
    if (readProjectGeneration() !== options.projectGeneration) {
      aborted = true;
      break;
    }
    const item: BatchLayerSaveItemResult = {
      layerId: liveLayer.id,
      layerName: liveLayer.name,
      ...outcome,
    };
    results.push(item);
    if (item.status === "success") succeeded += 1;
    else if (item.status === "warning") warnings += 1;
    else failed += 1;
    options.onLayerDone?.(item);
  }

  return { results, succeeded, warnings, failed, aborted };
}

/** One external `.geojson` copy written to a chosen folder. */
export interface WrittenExternalCopy {
  layerId: string;
  layerName: string;
  fileName: string;
  path: string;
  /** The layer's live `geojson` reference captured when the copy was built. */
  capturedGeojson?: FeatureCollection;
}

/** Outcome of writing external GeoJSON copies into a local folder (desktop). */
export interface SaveCopiesToDirectoryResult {
  written: WrittenExternalCopy[];
  blockedDraftLayers: string[];
  skippedLayers: string[];
  errors: Array<{ layerId: string; layerName: string; message: string }>;
  aborted: boolean;
}

function isFileExistsError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String((error as { code?: unknown }).code).toUpperCase();
    if (code === "EEXIST") return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /already exists|file exists|eexist|\(os error (17|80)\)/i.test(message);
}

/**
 * Write external `.geojson` copies of the selected layers into `directory`
 * without overwriting any existing file in that directory (desktop only).
 */
export async function saveGeojsonCopiesToDirectory(
  layers: readonly GeoLibreLayer[],
  directory: string,
  options: {
    map: MapLibreMap | undefined;
    layerIds?: ReadonlySet<string>;
    projectGeneration?: number;
    preserveHiddenFields?: boolean;
    /** Return early before writing any files if any layer had blocked attribute drafts. */
    abortOnBlockedDrafts?: boolean;
    /** Localized fallback error message when a non-Error rejection has no message. */
    fallbackErrorMessage?: string;
    deps?: CollectGeojsonExportDeps & {
      writeTextFile?: (path: string, content: string) => Promise<void>;
    };
  },
): Promise<SaveCopiesToDirectoryResult> {
  const writeTextFile = options.deps?.writeTextFile ?? writeNewTextFileToPath;
  const readProjectGeneration =
    options.deps?.readProjectGeneration ?? (() => useAppStore.getState().projectGeneration);
  const isStaleGeneration = () =>
    options.projectGeneration !== undefined &&
    readProjectGeneration() !== options.projectGeneration;
  const collected = await collectGeojsonLayersForExport(layers, options.map, {
    layerIds: options.layerIds,
    projectGeneration: options.projectGeneration,
    preserveHiddenFields: options.preserveHiddenFields,
    deps: options.deps,
  });

  const written: WrittenExternalCopy[] = [];
  const errors: Array<{ layerId: string; layerName: string; message: string }> = [];
  if (collected.aborted) {
    return {
      written,
      blockedDraftLayers: collected.blockedDraftLayers,
      skippedLayers: collected.skippedLayers,
      errors,
      aborted: true,
    };
  }
  if (options.abortOnBlockedDrafts && collected.blockedDraftLayers.length > 0) {
    return {
      written,
      blockedDraftLayers: collected.blockedDraftLayers,
      skippedLayers: collected.skippedLayers,
      errors,
      aborted: false,
    };
  }

  const usedNamesLower = new Set<string>();
  const MAX_NAME_ATTEMPTS = 1_000;

  for (const item of collected.items) {
    if (isStaleGeneration()) {
      return {
        written,
        blockedDraftLayers: collected.blockedDraftLayers,
        skippedLayers: collected.skippedLayers,
        errors,
        aborted: true,
      };
    }
    const baseName = item.fileName.replace(/\.geojson$/i, "");
    const payload = JSON.stringify(item.geojson, null, 2);
    let saved = false;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
      if (isStaleGeneration()) {
        return {
          written,
          blockedDraftLayers: collected.blockedDraftLayers,
          skippedLayers: collected.skippedLayers,
          errors,
          aborted: true,
        };
      }
      const candidateName =
        attempt === 1 ? `${baseName}.geojson` : `${baseName}-${attempt}.geojson`;
      if (usedNamesLower.has(candidateName.toLowerCase())) continue;
      const targetPath = joinLocalPath(directory, candidateName);
      try {
        await writeTextFile(targetPath, payload);
        usedNamesLower.add(candidateName.toLowerCase());
        written.push({
          layerId: item.layer.id,
          layerName: item.layer.name,
          fileName: candidateName,
          path: targetPath,
          capturedGeojson: item.sourceGeojson,
        });
        saved = true;
        if (isStaleGeneration()) {
          return {
            written,
            blockedDraftLayers: collected.blockedDraftLayers,
            skippedLayers: collected.skippedLayers,
            errors,
            aborted: true,
          };
        }
        break;
      } catch (error) {
        if (isFileExistsError(error)) {
          usedNamesLower.add(candidateName.toLowerCase());
          lastError = error;
          continue;
        }
        lastError = error;
        break;
      }
    }

    if (!saved) {
      const errorMessage =
        lastError instanceof Error && lastError.message.trim()
          ? lastError.message
          : typeof lastError === "string" && lastError.trim()
            ? lastError
            : (options.fallbackErrorMessage ?? "");
      errors.push({
        layerId: item.layer.id,
        layerName: item.layer.name,
        message: errorMessage,
      });
    }
  }

  return {
    written,
    blockedDraftLayers: collected.blockedDraftLayers,
    skippedLayers: collected.skippedLayers,
    errors,
    aborted: false,
  };
}

/**
 * Whether a plain GeoJSON layer can be restored from a local `sourcePath` on
 * desktop (matches `restore-local-layers.ts`).
 */
function isPlainLocalReloadableLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "geojson" &&
    layer.metadata.externalNativeLayer !== true &&
    layer.metadata.sourceKind == null
  );
}

/** Reference to a written external copy, optionally pinned to the captured revision. */
export type ExternalCopyTarget = string | { path: string; capturedGeojson?: FeatureCollection };

/**
 * Build the layer list for a project save after external GeoJSON copies were
 * written to disk:
 * - Plain GeoJSON layers whose copy was written — and whose live `geojson`
 *   still matches the revision captured for the copy — get `sourcePath` pointed
 *   at their new copy, `localFileReloadable: true`, and transient
 *   `geometryEdited` / `sourceLayer` stripped so reopening loads the new copy.
 * - Any remaining edited layer that cannot reload from a plain GeoJSON path
 *   (or whose geometry changed while the copy was being written) keeps its
 *   edited data embedded so no edits are silently lost.
 */
export function applyExternalCopyReferences(
  layers: readonly GeoLibreLayer[],
  writtenByLayerId: ReadonlyMap<string, ExternalCopyTarget>,
): GeoLibreLayer[] {
  return layers.map((layer) => {
    const target = writtenByLayerId.get(layer.id);
    if (target && isPlainLocalReloadableLayer(layer)) {
      const copyPath = typeof target === "string" ? target : target.path;
      const capturedGeojson = typeof target === "string" ? undefined : target.capturedGeojson;
      const revisionMatches = capturedGeojson === undefined || layer.geojson === capturedGeojson;
      if (revisionMatches) {
        const { geometryEdited: _edited, sourceLayer: _table, ...restMetadata } = layer.metadata;
        return {
          ...layer,
          sourcePath: copyPath,
          metadata: { ...restMetadata, localFileReloadable: true },
        };
      }
    }
    if (hasEditedGeometry(layer)) {
      return embedEditedGeometry(layer);
    }
    return layer;
  });
}
