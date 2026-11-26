/**
 * PostGIS backend of the offline edit outbox (#3530).
 *
 * An editable PostGIS layer records the fingerprint of every row as it was
 * read (`metadata.editSyncBaseline`). Saving diffs the layer against that base
 * into a change set, queues it, and syncs it through the sidecar:
 *
 * - the server's current rows come from `/postgis/read`, whose `row_hashes`
 *   are then sent back as `expected_row_hashes`, so a row someone changes
 *   between the read and the write rolls the whole write back (HTTP 409) and
 *   the outbox re-reads instead of overwriting it;
 * - only the changed features are sent, with `baseline_keys` limited to the
 *   deleted keys, so rows the user never touched are never rewritten;
 * - the sidecar answers 503 when the database cannot be reached, which keeps
 *   the change set queued for a retry instead of failing it.
 *
 * Reads here never pass `excluded_fields`: an "excluded" field is still in
 * the layer's data (it is dropped only on export and sharing), and the base
 * was fingerprinted with every column, so leaving it out of the server's
 * version would make every row look changed by someone else.
 *
 * Credentials never enter the outbox: the connection is resolved at sync time
 * from the layer's in-session registry or the saved connection that matches
 * its masked label, exactly like a direct save.
 */

import { resolveLayerCapabilities, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import {
  PostgisRequestError,
  PostgisWriteRejectedError,
  readPostgisTable,
  writePostgisTable,
  type ReadPostgisTableResult,
} from "@geolibre/processing";
import type { Feature, FeatureCollection } from "geojson";
import { databaseBaselineKeys, databaseFeatureKeys } from "../database-tables";
import { resolvePostgisConnection } from "../postgis-connections";
import {
  buildChangeSet,
  EditSyncConflictRaceError,
  EditSyncOfflineError,
  EditSyncRejectedError,
  EditSyncUncertainError,
  type ApplyResult,
  type EditSyncAdapter,
  type OutboxEntry,
  type OutboxOp,
  type RemoteState,
  type SyncOutcome,
} from "./edit-outbox";
import type { EditSyncBackendHandler } from "./edit-outbox-runner";
import {
  captureFingerprintBaseline,
  featureFingerprint,
  featureIdKey,
  readFingerprintBaseline,
} from "./feature-fingerprint";

/** Layer metadata key holding the base fingerprints of a synced source. */
export const EDIT_SYNC_BASELINE_KEY = "editSyncBaseline";

/** What the outbox stores to find a PostGIS table again (no credentials). */
export interface PostgisOutboxTarget {
  [key: string]: unknown;
  schema: string;
  table: string;
  geometryColumn?: string;
  primaryKey: string;
  /** Password-masked label of the connection the layer was read with. */
  connectionLabel: string;
  capabilities?: { create: boolean; update: boolean; delete: boolean };
}

/**
 * Decimals PostGIS serves coordinates with (`ST_AsGeoJSON`'s default). Every
 * fingerprint on this path rounds to it, so a drawn vertex with more digits
 * still matches the row the table stores once my edit landed.
 */
const POSTGIS_COORDINATE_DECIMALS = 9;

/** Fingerprint a feature the way every PostGIS comparison does. */
export function postgisFingerprint(feature: Feature, omitProperties?: readonly string[]): string {
  return featureFingerprint(feature, {
    coordinateDecimals: POSTGIS_COORDINATE_DECIMALS,
    ...(omitProperties ? { omitProperties } : {}),
  });
}

/** Base fingerprints of a PostGIS read, for `metadata.editSyncBaseline`. */
export function postgisSyncBaseline(geojson: FeatureCollection): Record<string, string> {
  return captureFingerprintBaseline(geojson.features, featureIdKey, {
    coordinateDecimals: POSTGIS_COORDINATE_DECIMALS,
  });
}

/**
 * Describe a PostGIS layer's table as an outbox target, or null when the
 * layer lacks what a queued sync needs.
 *
 * @param layer An editable PostGIS layer.
 * @returns The target.
 */
export function postgisOutboxTarget(layer: GeoLibreLayer): PostgisOutboxTarget | null {
  const metadata = layer.metadata;
  if (typeof metadata.postgisTable !== "string" || typeof metadata.postgisPrimaryKey !== "string") {
    return null;
  }
  const caps = resolveLayerCapabilities(layer);
  return {
    schema: typeof metadata.postgisSchema === "string" ? metadata.postgisSchema : "public",
    table: metadata.postgisTable,
    ...(typeof metadata.postgisGeometryColumn === "string"
      ? { geometryColumn: metadata.postgisGeometryColumn }
      : {}),
    primaryKey: metadata.postgisPrimaryKey,
    connectionLabel:
      typeof metadata.postgisConnectionLabel === "string" ? metadata.postgisConnectionLabel : "",
    capabilities: { create: caps.create, update: caps.update, delete: caps.delete },
  };
}

/** Outbox entry id for a PostGIS table; one entry per table and connection. */
export function postgisOutboxId(target: PostgisOutboxTarget): string {
  return `postgis:${JSON.stringify([
    target.connectionLabel,
    target.schema,
    target.table,
    target.geometryColumn ?? "",
  ])}`;
}

/**
 * Whether a layer carries the base fingerprints the outbox needs. Layers
 * loaded before the outbox existed lack them and keep the direct save.
 */
export function hasPostgisSyncBaseline(layer: GeoLibreLayer): boolean {
  return readFingerprintBaseline(layer.metadata[EDIT_SYNC_BASELINE_KEY]) !== undefined;
}

/** A feature's primary key, preferring the key column over `feature.id`. */
function postgisKeyOf(primaryKey: string) {
  return (feature: Feature): string | null => {
    // Only the key column identifies a row: every row read from the table
    // carries it, while a drawn feature's editor id could collide with a key.
    const value = feature.properties?.[primaryKey];
    if (typeof value === "number" || (typeof value === "string" && value !== "")) {
      return String(value);
    }
    return null;
  };
}

function postgisRawKeyOf(primaryKey: string) {
  return (feature: Feature): string | number | undefined => {
    const value = feature.properties?.[primaryKey];
    if (typeof value === "number" || (typeof value === "string" && value !== "")) return value;
    return undefined;
  };
}

/**
 * Diff a PostGIS layer's features against its base into queued operations.
 *
 * @param layer The layer (for its base and key column).
 * @param geojson The features to save (the layer's resolved collection).
 * @returns The operations, or null when the layer has no base.
 */
export function buildPostgisChangeSet(
  layer: GeoLibreLayer,
  geojson: FeatureCollection,
): OutboxOp[] | null {
  const baseline = readFingerprintBaseline(layer.metadata[EDIT_SYNC_BASELINE_KEY]);
  const primaryKey = layer.metadata.postgisPrimaryKey;
  if (!baseline || typeof primaryKey !== "string") return null;
  // The sidecar matches deletes against typed keys (an integer key 4 is not
  // "4"), so recover each base key's type from the persisted key list.
  const typedKeys = new Map(
    (databaseBaselineKeys(layer, "postgisBaselineKeys") ?? []).map((key) => [String(key), key]),
  );
  return buildChangeSet({
    baseline,
    features: geojson.features,
    keyOf: postgisKeyOf(primaryKey),
    rawKeyOf: postgisRawKeyOf(primaryKey),
    rawKeyOfBase: (key) => typedKeys.get(key) ?? key,
    fingerprint: (feature) => postgisFingerprint(feature),
    stripKey: (feature) => {
      const { id: _id, ...rest } = feature;
      const properties = { ...(feature.properties ?? {}) };
      delete properties[primaryKey];
      return { ...rest, properties } as Feature;
    },
    newId: () => crypto.randomUUID(),
  }).map((op) => {
    // A new row takes its key from the table (identity/default), never from
    // an editor-assigned feature id the sidecar would try to insert as one.
    if (op.kind !== "insert" || op.key !== null || op.feature?.id === undefined) return op;
    const { id: _id, ...feature } = op.feature;
    return { ...op, feature: feature as Feature };
  });
}

/** Injectable I/O for {@link createPostgisSyncAdapter}. */
export interface PostgisSyncDeps {
  read?: typeof readPostgisTable;
  write?: typeof writePostgisTable;
  resolveConnection?: (entry: OutboxEntry) => string | null;
}

/** Resolve the connection string for an entry from the app's credential stores. */
export function resolveEntryConnection(entry: OutboxEntry): string | null {
  const target = entry.target as PostgisOutboxTarget;
  // A minimal layer: the registry is keyed by layer id, the fallback by label.
  return resolvePostgisConnection({
    id: entry.layerId,
    metadata: { postgisConnectionLabel: target.connectionLabel },
  } as unknown as GeoLibreLayer);
}

/** Statuses a proxy in front of the sidecar (nginx in the web build) answers with when it is down. */
const GATEWAY_STATUSES = new Set([502, 503, 504]);

function readFailure(error: unknown): Error {
  if (error instanceof PostgisRequestError && !GATEWAY_STATUSES.has(error.status ?? 0)) {
    return new EditSyncRejectedError(error.message);
  }
  // Database or sidecar unreachable, or no answer at all: a read is safe to retry.
  return new EditSyncOfflineError(error instanceof Error ? error.message : String(error));
}

function writeFailure(error: unknown): Error {
  if (error instanceof PostgisWriteRejectedError) {
    if (error.status === 409) return new EditSyncConflictRaceError(error.message);
    // The sidecar's own 503 means it never reached the database.
    if (error.status === 503) return new EditSyncOfflineError(error.message);
    // A gateway timeout or bad gateway may follow a committed write.
    if (GATEWAY_STATUSES.has(error.status ?? 0)) {
      return new EditSyncUncertainError(error.message);
    }
    return new EditSyncRejectedError(error.message);
  }
  // The request may have reached the database before the answer was lost.
  return new EditSyncUncertainError(error instanceof Error ? error.message : String(error));
}

/**
 * Build the sync adapter for a queued PostGIS change set.
 *
 * @param entry The outbox entry.
 * @param deps Injectable I/O (tests).
 * @returns The adapter.
 * @throws EditSyncRejectedError when no connection matches the entry.
 */
export function createPostgisSyncAdapter(
  entry: OutboxEntry,
  deps: PostgisSyncDeps = {},
): EditSyncAdapter {
  const read = deps.read ?? readPostgisTable;
  const write = deps.write ?? writePostgisTable;
  const target = entry.target as PostgisOutboxTarget;
  const connection = (deps.resolveConnection ?? resolveEntryConnection)(entry);
  if (!connection) {
    throw new EditSyncRejectedError(
      "No PostgreSQL connection is available for this table.",
      "postgisNoConnection",
    );
  }
  const keyOf = postgisKeyOf(target.primaryKey);
  const contentFingerprint = (feature: Feature) => postgisFingerprint(feature, [target.primaryKey]);
  let rowHashes: Record<string, string> = {};

  return {
    fingerprint: (feature) => postgisFingerprint(feature),
    async fetchRemote(_entry, keys, maybeApplied): Promise<RemoteState> {
      let result: ReadPostgisTableResult;
      try {
        result = await read({
          connection,
          schema_name: target.schema,
          table: target.table,
          geometry_column: target.geometryColumn,
        });
      } catch (error) {
        throw readFailure(error);
      }
      rowHashes = result.row_hashes ?? {};
      const rows = new Map<string, Feature>();
      for (const feature of result.geojson.features) {
        const key = keyOf(feature);
        if (key !== null && !rows.has(key)) rows.set(key, feature);
      }
      const byKey = new Map<string, Feature | null>();
      for (const key of keys) byKey.set(key, rows.get(key) ?? null);
      // An insert whose answer was lost: find the row it created, matching on
      // content without the generated key, each row claimed at most once.
      const insertMatches = new Map<string, string>();
      if (maybeApplied.length) {
        const referenced = new Set(entry.ops.map((op) => op.key).filter(Boolean));
        const candidates = new Map<string, string>();
        for (const [key, feature] of rows) {
          if (!referenced.has(key)) candidates.set(key, contentFingerprint(feature));
        }
        for (const op of maybeApplied) {
          if (!op.feature) continue;
          const wanted = contentFingerprint(op.feature);
          for (const [key, fingerprint] of candidates) {
            if (fingerprint !== wanted) continue;
            insertMatches.set(op.id, key);
            candidates.delete(key);
            break;
          }
        }
      }
      return { byKey, insertMatches };
    },

    async apply(_entry, plan): Promise<ApplyResult> {
      const touched = [...plan.updates, ...plan.deletes];
      const expected: Record<string, string> = {};
      for (const op of touched) {
        const hash = op.key !== null ? rowHashes[op.key] : undefined;
        if (hash) expected[op.key!] = hash;
      }
      const features = [...plan.inserts, ...plan.updates].map((op) => op.feature as Feature);
      try {
        await write({
          connection,
          schema_name: target.schema,
          table: target.table,
          geometry_column: target.geometryColumn,
          geojson: { type: "FeatureCollection", features },
          // Always a list: omitting it would make the sidecar delete every row
          // missing from this (partial) payload.
          baseline_keys: plan.deletes.map((op) => op.rawKey ?? (op.key as string)),
          capabilities: target.capabilities,
          ...(Object.keys(expected).length ? { expected_row_hashes: expected } : {}),
        });
      } catch (error) {
        throw writeFailure(error);
      }
      // One transaction: everything applied.
      return {
        applied: [...plan.inserts, ...plan.updates, ...plan.deletes].map((op) => op.id),
        failed: [],
      };
    },
  };
}

/** Injectable store access for {@link refreshPostgisLayerAfterSync}. */
export interface PostgisRefreshDeps {
  read?: typeof readPostgisTable;
  getLayer?: (layerId: string) => GeoLibreLayer | undefined;
  updateLayer?: (layerId: string, patch: Partial<GeoLibreLayer>) => void;
  resolveConnection?: (entry: OutboxEntry) => string | null;
}

/**
 * After a sync, reload the open layer from the table so it shows the stored
 * result (generated keys, other users' rows, conflicts kept as theirs) and
 * re-bases its fingerprints. Skipped when the layer is gone or now points at
 * a different table.
 *
 * @param entry The entry as it was before the sync.
 * @param outcome The sync outcome.
 * @param deps Injectable store access (tests).
 * @returns True when the layer was refreshed.
 */
export async function refreshPostgisLayerAfterSync(
  entry: OutboxEntry,
  outcome: SyncOutcome,
  deps: PostgisRefreshDeps = {},
): Promise<boolean> {
  const getLayer =
    deps.getLayer ?? ((id: string) => useAppStore.getState().layers.find((l) => l.id === id));
  const updateLayer = deps.updateLayer ?? useAppStore.getState().updateLayer;
  const read = deps.read ?? readPostgisTable;
  const layer = getLayer(entry.layerId);
  if (!layer) return false;
  const current = postgisOutboxTarget(layer);
  if (!current || postgisOutboxId(current) !== entry.id) return false;
  const connection = (deps.resolveConnection ?? resolveEntryConnection)(entry);
  if (!connection) return false;
  const fresh = await read({
    connection,
    schema_name: current.schema,
    table: current.table,
    geometry_column: current.geometryColumn,
  });
  const live = getLayer(entry.layerId);
  if (!live?.geojson) return false;
  // Everything the layer holds that its old base does not: the edits this
  // sync sent, edits still queued, and edits made since the save (possibly
  // while this sync ran in the background). Only the ones this sync settled
  // are replaced by the table's version; the rest are laid back on top.
  const localOps = buildPostgisChangeSet(live, live.geojson) ?? [];
  const remaining = new Set((outcome.entry?.ops ?? []).map((op) => op.id));
  const settled = entry.ops.filter((op) => !remaining.has(op.id));
  const unsynced = unsyncedLocalOps(localOps, settled);
  const { geometryEdited: _cleared, ...metadata } = live.metadata;
  updateLayer(entry.layerId, {
    geojson: overlayLocalOps(fresh.geojson, unsynced, keyOfTarget(current)),
    metadata: {
      ...metadata,
      ...(unsynced.length ? { geometryEdited: true } : {}),
      featureCount: fresh.feature_count,
      postgisBaselineKeys: databaseFeatureKeys(fresh.geojson),
      [EDIT_SYNC_BASELINE_KEY]: postgisSyncBaseline(fresh.geojson),
    },
  });
  return true;
}

function keyOfTarget(target: PostgisOutboxTarget) {
  return postgisKeyOf(target.primaryKey);
}

/**
 * The layer's local edits that a sync did not settle: everything except an
 * edit identical to one the sync applied (or resolved as keep theirs).
 *
 * @param localOps The layer's current edits against its old base.
 * @param settled The entry's operations this sync finished.
 * @returns The edits to keep on top of the refreshed table.
 */
export function unsyncedLocalOps(
  localOps: readonly OutboxOp[],
  settled: readonly OutboxOp[],
): OutboxOp[] {
  const settledByKey = new Map<string, OutboxOp>();
  const settledInserts: OutboxOp[] = [];
  for (const op of settled) {
    if (op.kind === "insert" && op.key === null) settledInserts.push(op);
    else if (op.key !== null) settledByKey.set(op.key, op);
  }
  return localOps.filter((op) => {
    if (op.kind === "insert" && op.key === null) {
      const twin = settledInserts.findIndex((s) => s.mineFingerprint === op.mineFingerprint);
      if (twin < 0) return true;
      settledInserts.splice(twin, 1);
      return false;
    }
    const done = op.key !== null ? settledByKey.get(op.key) : undefined;
    return !(done && done.kind === op.kind && done.mineFingerprint === op.mineFingerprint);
  });
}

/**
 * Lay local edits on top of freshly read features.
 *
 * @param geojson The table as read.
 * @param ops The edits to keep.
 * @param keyOf How to key a feature.
 * @returns The collection to show.
 */
export function overlayLocalOps(
  geojson: FeatureCollection,
  ops: readonly OutboxOp[],
  keyOf: (feature: Feature) => string | null,
): FeatureCollection {
  if (!ops.length) return geojson;
  const replaced = new Map<string, Feature>();
  const deleted = new Set<string>();
  const inserts: Feature[] = [];
  for (const op of ops) {
    if (op.kind === "update" && op.key !== null && op.feature) replaced.set(op.key, op.feature);
    else if (op.kind === "delete" && op.key !== null) deleted.add(op.key);
    else if (op.kind === "insert" && op.feature) inserts.push(op.feature);
  }
  const features: Feature[] = [];
  for (const feature of geojson.features) {
    const key = keyOf(feature);
    if (key !== null && deleted.has(key)) continue;
    features.push(key !== null && replaced.has(key) ? replaced.get(key)! : feature);
  }
  return { ...geojson, features: [...features, ...inserts] };
}

/** The outbox handler for PostGIS. */
export const postgisEditSyncHandler: EditSyncBackendHandler = {
  createAdapter: (entry) => createPostgisSyncAdapter(entry),
  afterSync: async (entry, outcome) => {
    await refreshPostgisLayerAfterSync(entry, outcome);
  },
};
