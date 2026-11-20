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
import { isArcGISWritableLayer, saveArcGISLayerEdits } from "@geolibre/plugins";
import {
  fetchMssqlStatus,
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
import { isGeojsonSourcePath, joinLocalPath } from "./file-io/paths";
import { collectGeojsonLayersForExport, type CollectGeojsonExportDeps } from "./geojson-zip-export";
import { isTauri } from "./is-tauri";
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
import { writeLocalGeojsonFile, writeTextFileToPath } from "./tauri-io";
import { resolveLayerGeojson } from "./vector-export";

export type WritableLayerSourceKind = "geojson" | "geopackage" | "postgis" | "mssql" | "arcgis";

export type LayerWriteBackDisabledReason =
  | "geometryEditActive"
  | "mssqlRefreshRequired"
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

/** Shared in-flight set for SQL Server write-backs so concurrent clicks never race. */
const sharedSavingMssqlEditsIds = new Set<string>();

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
    /** Override for unit tests (defaults to {@link canWriteEditsToSource}). */
    canWriteSource?: (layer: GeoLibreLayer) => boolean;
  },
): WritableLayerCandidate[] {
  const canWriteSource = options?.canWriteSource ?? canWriteEditsToSource;
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
 * an undo entry or dirty the project.
 */
export function clearLayerGeometryEditedFlag(
  layerId: string,
  expectedProjectGeneration?: number,
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
  const { geometryEdited: _cleared, ...metadata } = existing.metadata;
  useAppStore.setState((current) => ({
    layers: current.layers.map((candidate) =>
      candidate.id === layerId ? { ...candidate, metadata } : candidate,
    ),
  }));
}

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
  saveArcgis?: typeof saveArcGISLayerEdits;
  clearGeometryEdited?: (layerId: string, expectedProjectGeneration?: number) => void;
  updateLayer?: (layerId: string, patch: Partial<GeoLibreLayer>) => void;
  markMssqlRefreshRequired?: (layerId: string) => void;
  inFlightMssqlIds?: Set<string>;
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
  const saveArcgis = deps?.saveArcgis ?? saveArcGISLayerEdits;
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
    return { status: "error", message: t("layers.saveEditsError") };
  }

  const requestProjectGeneration = readProjectGeneration();
  const currentBeforeCommit = readLatestLayer(clickedLayer.id);
  if (
    currentBeforeCommit &&
    isMssqlEditableLayer(currentBeforeCommit) &&
    currentBeforeCommit.mssqlWritebackPending === true
  ) {
    return { status: "error", message: t("layers.saveEditsMssqlRefreshRequired") };
  }

  if (commitDrafts(clickedLayer.id) === "blocked") {
    return { status: "error", message: t("layers.pendingTableDraftsBlocked") };
  }

  const layer = readLatestLayer(clickedLayer.id) ?? clickedLayer;
  const isMssql = isMssqlEditableLayer(layer);
  const mssqlBaseline = isMssql ? databaseBaselineKeys(layer, "mssqlBaselineKeys") : undefined;
  const isCurrentMssqlRequest = () => {
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
  const path = typeof layer.sourcePath === "string" ? layer.sourcePath.trim() : "";
  if (!isMssql && !isPostgis && !isArcGISWritableLayer(layer) && !path) {
    return { status: "error", message: t("layers.saveEditsError") };
  }

  try {
    if (isArcGISWritableLayer(layer)) {
      const result = await saveArcgis(layer.id);
      if (result.errors.length === 0) {
        clearGeometryEdited(layer.id, requestProjectGeneration);
      }
      return {
        status: result.errors.length ? "warning" : "success",
        message: [t("layers.saveEditsArcgisSuccess", result), ...result.errors].join(" "),
      };
    }

    const geojson = await resolveGeojson(layer, map);
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
        return { status: "error", message: t("layers.saveEditsError") };
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

    if (isPostgis) {
      const connection = resolvePostgisConnection(layer);
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
      const result = await writePostgisTable({
        connection,
        schema_name: schema,
        table,
        geometry_column: geometryColumn,
        geojson,
        baseline_keys: databaseBaselineKeys(layer, "postgisBaselineKeys"),
        capabilities: resolveLayerCapabilities(layer),
      });
      let fresh;
      try {
        fresh = await readPostgisTable({
          connection,
          schema_name: schema,
          table,
          geometry_column: geometryColumn,
          excluded_fields: layer.fieldVisibility
            ? Object.keys(layer.fieldVisibility).filter(
                (k) => layer.fieldVisibility![k] === "excluded",
              )
            : undefined,
        });
      } catch {
        return { status: "error", message: t("layers.saveEditsPostgisRefreshWarning") };
      }
      const currentMetadata = readLatestLayer(layer.id)?.metadata ?? layer.metadata;
      const { geometryEdited: _cleared, ...restMetadata } = currentMetadata;
      updateLayer(layer.id, {
        geojson: fresh.geojson,
        metadata: {
          ...restMetadata,
          featureCount: fresh.feature_count,
          postgisBaselineKeys: databaseFeatureKeys(fresh.geojson),
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
      clearGeometryEdited(layer.id, requestProjectGeneration);
      return {
        status: "success",
        message: t("layers.saveEditsSuccess", { count: geojson.features.length }),
      };
    }

    if (isDesktop()) await startSidecar();
    const result = await writeVectorSource({ path, geojson });
    clearGeometryEdited(layer.id, requestProjectGeneration);
    return {
      status: "success",
      message: t("layers.saveEditsSuccess", { count: result.feature_count }),
    };
  } catch (error) {
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
    options.onLayerStart?.(layer.id);
    const outcome = await writeLayerEditsToSource(layer, {
      map: options.map,
      t: options.t,
      canEditLayer: options.canEditLayer,
      deps: options.deps,
    });
    const item: BatchLayerSaveItemResult = {
      layerId: layer.id,
      layerName: layer.name,
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
}

/** Outcome of writing external GeoJSON copies into a local folder (desktop). */
export interface SaveCopiesToDirectoryResult {
  written: WrittenExternalCopy[];
  blockedDraftLayers: string[];
  skippedLayers: string[];
  errors: Array<{ layerId: string; layerName: string; message: string }>;
}

/**
 * Write external `.geojson` copies of the selected layers into `directory`
 * without touching their original source files (desktop only).
 */
export async function saveGeojsonCopiesToDirectory(
  layers: readonly GeoLibreLayer[],
  directory: string,
  options: {
    map: MapLibreMap | undefined;
    layerIds?: ReadonlySet<string>;
    deps?: CollectGeojsonExportDeps & {
      writeTextFile?: (path: string, content: string) => Promise<void>;
    };
  },
): Promise<SaveCopiesToDirectoryResult> {
  const writeTextFile = options.deps?.writeTextFile ?? writeTextFileToPath;
  const collected = await collectGeojsonLayersForExport(layers, options.map, {
    layerIds: options.layerIds,
    deps: options.deps,
  });

  const written: WrittenExternalCopy[] = [];
  const errors: Array<{ layerId: string; layerName: string; message: string }> = [];

  for (const item of collected.items) {
    const targetPath = joinLocalPath(directory, item.fileName);
    try {
      await writeTextFile(targetPath, JSON.stringify(item.geojson, null, 2));
      written.push({
        layerId: item.layer.id,
        layerName: item.layer.name,
        fileName: item.fileName,
        path: targetPath,
      });
    } catch (error) {
      errors.push({
        layerId: item.layer.id,
        layerName: item.layer.name,
        message: error instanceof Error ? error.message : "Could not write GeoJSON file.",
      });
    }
  }

  return {
    written,
    blockedDraftLayers: collected.blockedDraftLayers,
    skippedLayers: collected.skippedLayers,
    errors,
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

/**
 * Build the layer list for a project save after external GeoJSON copies were
 * written to disk:
 * - Plain GeoJSON layers whose copy was written get `sourcePath` pointed at
 *   their new copy, `localFileReloadable: true`, and transient `geometryEdited`
 *   / `sourceLayer` stripped so reopening loads the new external copy.
 * - Any remaining edited layer that cannot reload from a plain GeoJSON path
 *   (e.g., WFS or an Add Vector Layer control layer) keeps its edited data
 *   embedded so no edits are silently lost.
 */
export function applyExternalCopyReferences(
  layers: readonly GeoLibreLayer[],
  writtenByLayerId: ReadonlyMap<string, string>,
): GeoLibreLayer[] {
  return layers.map((layer) => {
    const copyPath = writtenByLayerId.get(layer.id);
    if (copyPath && isPlainLocalReloadableLayer(layer)) {
      const { geometryEdited: _edited, sourceLayer: _table, ...restMetadata } = layer.metadata;
      return {
        ...layer,
        sourcePath: copyPath,
        metadata: { ...restMetadata, localFileReloadable: true },
      };
    }
    if (hasEditedGeometry(layer)) {
      return embedEditedGeometry(layer);
    }
    return layer;
  });
}
