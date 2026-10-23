import { useAppStore } from "@geolibre/core";
import { MssqlSessionExpiredError, MssqlWriteRejectedError } from "@geolibre/processing";
import type { Feature, FeatureCollection } from "geojson";
import { databaseFeatureKeys } from "./database-tables";

export class MssqlWriteUncertainError extends Error {
  override readonly name = "MssqlWriteUncertainError";
}

/** Preserve definitive sidecar errors; a lost response can follow a committed write. */
export async function runMssqlWriteRequest<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof MssqlWriteRejectedError || error instanceof MssqlSessionExpiredError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new MssqlWriteUncertainError(message, { cause: error });
  }
}

interface MssqlLoadedRows {
  generation: number;
  primaryKey: string;
  rows: Map<string, { geometry: string; properties: Record<string, unknown> }>;
}

const loadedMssqlRows = new Map<string, MssqlLoadedRows>();

function mssqlRowKey(key: string | number): string {
  return `${typeof key}:${key}`;
}

/** Resolve an SQL Server row identity using the same property/id precedence as the sidecar. */
export function mssqlFeatureKey(feature: Feature, primaryKey: string): string | number | undefined {
  const key = feature.properties?.[primaryKey] ?? feature.id;
  return typeof key === "string" || typeof key === "number" ? key : undefined;
}

/**
 * Keep an immutable in-memory baseline for identifying user-edited values.
 * Recording one also drops baselines no save can use any more: those of
 * removed layers and those from an earlier project.
 */
export function rememberMssqlLoadedRows(
  layerId: string,
  generation: number,
  primaryKey: string,
  geojson: FeatureCollection,
): void {
  const liveLayerIds = new Set(useAppStore.getState().layers.map((layer) => layer.id));
  for (const [id, entry] of loadedMssqlRows) {
    if (id !== layerId && (entry.generation !== generation || !liveLayerIds.has(id))) {
      loadedMssqlRows.delete(id);
    }
  }
  const rows = new Map<string, { geometry: string; properties: Record<string, unknown> }>();
  for (const feature of geojson.features) {
    const key = mssqlFeatureKey(feature, primaryKey);
    if (key === undefined) continue;
    rows.set(mssqlRowKey(key), {
      geometry: JSON.stringify(feature.geometry ?? null),
      properties: structuredClone(feature.properties ?? {}),
    });
  }
  loadedMssqlRows.set(layerId, { generation, primaryKey, rows });
}

/**
 * Describe which loaded rows the user edited. Features keep their full
 * properties so a row deleted outside the app is reinserted intact rather than
 * with only the edited columns; the sidecar limits each update to
 * `changedColumns`, so stale loaded values cannot overwrite newer stored ones.
 */
export function mssqlWritePayload(
  layerId: string,
  generation: number,
  geojson: FeatureCollection,
): {
  unchangedGeometryKeys?: Array<string | number>;
  changedColumns?: Array<{ key: string | number; columns: string[] }>;
} {
  const baseline = loadedMssqlRows.get(layerId);
  if (!baseline || baseline.generation !== generation) return {};

  const unchangedGeometryKeys: Array<string | number> = [];
  const changedColumns: Array<{ key: string | number; columns: string[] }> = [];
  for (const feature of geojson.features) {
    const key = mssqlFeatureKey(feature, baseline.primaryKey);
    if (key === undefined) continue;
    const row = baseline.rows.get(mssqlRowKey(key));
    if (!row) continue;

    const columns = Object.entries(feature.properties ?? {})
      .filter(
        ([name, value]) =>
          name !== baseline.primaryKey &&
          (!Object.prototype.hasOwnProperty.call(row.properties, name) ||
            JSON.stringify(value) !== JSON.stringify(row.properties[name])),
      )
      .map(([name]) => name);
    changedColumns.push({ key, columns });
    if (JSON.stringify(feature.geometry ?? null) === row.geometry) {
      unchangedGeometryKeys.push(key);
    }
  }

  if (!changedColumns.length) return {};
  return {
    changedColumns,
    ...(unchangedGeometryKeys.length ? { unchangedGeometryKeys } : {}),
  };
}

/** Clear module-local baselines between isolated tests. */
export function resetMssqlLoadedRows(): void {
  loadedMssqlRows.clear();
}

export interface RefreshedMssqlTable {
  geojson: FeatureCollection;
  feature_count: number;
}

export type MssqlWritebackOutcome<TWrite> =
  | { kind: "blocked" }
  | { kind: "stale" }
  | { kind: "missing-baseline" }
  | { kind: "write-failed"; error: unknown }
  | { kind: "write-rejected"; error: unknown }
  | { kind: "refresh-failed"; writeResult: TWrite }
  | { kind: "reconciled"; writeResult: TWrite; refreshed: RefreshedMssqlTable };

/** Reconcile a successful table read into the layer's current metadata. */
export function reconcileMssqlWritebackMetadata(
  metadata: Record<string, unknown>,
  refreshed: RefreshedMssqlTable,
): Record<string, unknown> {
  return {
    ...metadata,
    featureCount: refreshed.feature_count,
    mssqlBaselineKeys: databaseFeatureKeys(refreshed.geojson),
  };
}

/** Write once per layer, then reconcile database keys only for the originating project. */
export async function writeMssqlAndRefresh<TWrite>(
  request: {
    layerId: string;
    inFlightLayerIds: Set<string>;
    refreshRequired: boolean;
    baselineKeys: ReadonlyArray<string | number> | undefined;
    isCurrent: () => boolean;
  },
  write: () => Promise<TWrite>,
  refresh: () => Promise<RefreshedMssqlTable>,
): Promise<MssqlWritebackOutcome<TWrite>> {
  if (request.refreshRequired || request.inFlightLayerIds.has(request.layerId)) {
    return { kind: "blocked" };
  }
  if (!request.isCurrent()) return { kind: "stale" };
  if (request.baselineKeys === undefined) return { kind: "missing-baseline" };

  request.inFlightLayerIds.add(request.layerId);
  try {
    let writeResult: TWrite;
    try {
      writeResult = await write();
    } catch (error) {
      if (!request.isCurrent()) return { kind: "stale" };
      if (error instanceof MssqlWriteUncertainError) return { kind: "write-failed", error };
      return { kind: "write-rejected", error };
    }
    if (!request.isCurrent()) return { kind: "stale" };
    try {
      const refreshed = await refresh();
      if (!request.isCurrent()) return { kind: "stale" };
      return { kind: "reconciled", writeResult, refreshed };
    } catch {
      if (!request.isCurrent()) return { kind: "stale" };
      return { kind: "refresh-failed", writeResult };
    }
  } finally {
    request.inFlightLayerIds.delete(request.layerId);
  }
}
