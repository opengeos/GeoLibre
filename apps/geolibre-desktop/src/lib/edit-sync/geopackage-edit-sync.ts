/**
 * GeoPackage backend of the offline edit outbox (#3530), desktop only.
 *
 * A GeoPackage on a removable drive, a network share, or a synced folder can
 * become unreachable, and another program (QGIS, a sync client) can change it
 * while GeoLibre holds edits. Each feature carries its row id (the table's
 * FID) as its GeoJSON `id`, and the layer's base is the fingerprint of every
 * row as it was loaded, captured when the layer appears unedited.
 *
 * Syncing re-reads the file with the same reader the layer was loaded with,
 * compares every touched row three ways (base, mine, the file's), holds rows
 * changed on both sides as conflicts, and writes the file's current rows with
 * the settled edits applied. The write keeps row ids (`preserve_fids`) and
 * carries the SHA-256 of the bytes it read, so a file saved by another
 * program between the read and the write is refused (409) and re-read rather
 * than overwritten.
 */

import type { GeoLibreLayer } from "@geolibre/core";
import { VectorWriteRejectedError, type WriteVectorToSourceRequest } from "@geolibre/processing";
import type { Feature, FeatureCollection } from "geojson";
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
import { captureFingerprintBaseline, featureFingerprint } from "./feature-fingerprint";

/**
 * Decimals GeoPackage comparisons round coordinates to (about 1 cm in
 * degrees): a layer in a projected CRS is reprojected on every read and
 * back on every write, so a landed edit returns with slightly different
 * trailing digits.
 */
const GEOPACKAGE_COORDINATE_DECIMALS = 7;

/** Fingerprint a feature the way every GeoPackage comparison does. */
export function geopackageFingerprint(feature: Pick<Feature, "geometry" | "properties">): string {
  return featureFingerprint(feature, { coordinateDecimals: GEOPACKAGE_COORDINATE_DECIMALS });
}

/** What the outbox stores to find a GeoPackage layer again. */
export interface GeoPackageOutboxTarget {
  [key: string]: unknown;
  path: string;
  /** Table within the GeoPackage, when the layer names one. */
  layer?: string;
  /** The largest row id in the base, for finding inserts that landed unseen. */
  maxFid: number;
}

/** Base fingerprints of GeoPackage layers, keyed by layer id. Session memory only. */
const baselines = new Map<string, { path: string; fingerprints: Map<string, string> }>();

/** Whether a path names a GeoPackage. */
export function isGeoPackagePath(path: unknown): path is string {
  return typeof path === "string" && /\.gpkg$/i.test(path.trim());
}

function rowIdKey(feature: Feature): string | null {
  const id = feature.id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? String(id) : null;
}

/**
 * Record a GeoPackage layer's base: the fingerprint of every row as loaded.
 * Only an unedited layer whose features carry row ids qualifies, so edits
 * restored from a project are never mistaken for the file's content.
 *
 * @param layer The layer.
 * @returns True when a base was recorded (or already present).
 */
export function captureGeoPackageBaseline(layer: GeoLibreLayer): boolean {
  if (!isGeoPackagePath(layer.sourcePath) || !layer.geojson) return false;
  const existing = baselines.get(layer.id);
  if (existing && existing.path === layer.sourcePath) return true;
  if (layer.metadata.geometryEdited === true) return false;
  const features = layer.geojson.features;
  if (!features.length || !features.every((feature) => rowIdKey(feature) !== null)) return false;
  baselines.set(layer.id, {
    path: layer.sourcePath,
    fingerprints: new Map(
      Object.entries(
        captureFingerprintBaseline(features, rowIdKey, {
          coordinateDecimals: GEOPACKAGE_COORDINATE_DECIMALS,
        }),
      ),
    ),
  });
  return true;
}

/** The recorded base of a layer, if any (and still for the same file). */
export function geoPackageBaseline(layer: GeoLibreLayer): Map<string, string> | undefined {
  const entry = baselines.get(layer.id);
  return entry && entry.path === layer.sourcePath ? entry.fingerprints : undefined;
}

/** Replace a layer's base after a sync. */
export function setGeoPackageBaseline(
  layerId: string,
  path: string,
  fingerprints: Map<string, string>,
): void {
  baselines.set(layerId, { path, fingerprints });
}

/** Drop bases of layers that are gone. */
export function pruneGeoPackageBaselines(liveLayerIds: Iterable<string>): void {
  const live = new Set(liveLayerIds);
  for (const id of baselines.keys()) if (!live.has(id)) baselines.delete(id);
}

/** Forget every base (tests). */
export function resetGeoPackageBaselines(): void {
  baselines.clear();
}

/**
 * Describe a GeoPackage layer as an outbox target.
 *
 * @param layer The layer.
 * @param tableName The table, when the layer names one.
 * @returns The target, or null without a base.
 */
export function geopackageOutboxTarget(
  layer: GeoLibreLayer,
  tableName?: string,
): GeoPackageOutboxTarget | null {
  const base = geoPackageBaseline(layer);
  if (!base || !isGeoPackagePath(layer.sourcePath)) return null;
  let maxFid = 0;
  for (const key of base.keys()) maxFid = Math.max(maxFid, Number(key));
  return {
    path: layer.sourcePath.trim(),
    ...(tableName ? { layer: tableName } : {}),
    maxFid,
  };
}

/** Outbox entry id for a GeoPackage layer: one entry per file, table and store layer. */
export function geopackageOutboxId(target: GeoPackageOutboxTarget, layerId: string): string {
  return `geopackage:${JSON.stringify([target.path, target.layer ?? "", layerId])}`;
}

/**
 * Give features without a row id a stable local id, so the row id assigned on
 * save can be stamped onto the right feature.
 *
 * @param collection The layer's features.
 * @returns The same collection when nothing changed, else a copy.
 */
export function withGeoPackageLocalIds(collection: FeatureCollection): FeatureCollection {
  let changed = false;
  const seen = new Set<string | number>();
  const features = collection.features.map((feature) => {
    // A copy keeps its source's id: only the first occurrence keeps it.
    const repeated = feature.id !== undefined && seen.has(feature.id);
    if (feature.id !== undefined) seen.add(feature.id);
    if (!repeated && rowIdKey(feature) !== null) return feature;
    if (!repeated && typeof feature.id === "string" && feature.id.startsWith("gpkg-new-")) {
      return feature;
    }
    changed = true;
    return { ...feature, id: `gpkg-new-${crypto.randomUUID()}` };
  });
  return changed ? { ...collection, features } : collection;
}

/**
 * Diff a GeoPackage layer against its base into queued operations.
 *
 * @param layer The layer (with local ids on new features).
 * @returns The operations, or null without a base.
 */
export function buildGeoPackageChangeSet(layer: GeoLibreLayer): OutboxOp[] | null {
  const base = geoPackageBaseline(layer);
  if (!base || !layer.geojson) return null;
  return buildChangeSet({
    baseline: base,
    features: layer.geojson.features,
    keyOf: rowIdKey,
    rawKeyOf: (feature) => (rowIdKey(feature) === null ? undefined : (feature.id as number)),
    rawKeyOfBase: (key) => Number(key),
    stripKey: (feature) => ({ ...feature, id: `gpkg-new-${crypto.randomUUID()}` }),
    fingerprint: geopackageFingerprint,
    newId: () => crypto.randomUUID(),
  });
}

/** File access for {@link createGeoPackageSyncAdapter}. */
export interface GeoPackageSyncDeps {
  /** Read the file's bytes; throws when it cannot be reached. */
  readFile: (path: string) => Promise<Uint8Array<ArrayBuffer>>;
  /** Parse a GeoPackage table to WGS84 features, the way the layer was loaded. */
  parse: (
    bytes: Uint8Array<ArrayBuffer>,
    path: string,
    layer?: string,
  ) => Promise<FeatureCollection>;
  /** Write the table through the sidecar. */
  write: (request: WriteVectorToSourceRequest) => Promise<unknown>;
  /** Hex SHA-256 of bytes. */
  sha256: (bytes: Uint8Array<ArrayBuffer>) => Promise<string>;
}

/** Hex SHA-256 with WebCrypto. */
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build the sync adapter for a queued GeoPackage change set.
 *
 * @param entry The outbox entry.
 * @param deps File access.
 * @returns The adapter.
 */
export function createGeoPackageSyncAdapter(
  entry: OutboxEntry,
  deps: GeoPackageSyncDeps,
): EditSyncAdapter {
  const target = entry.target as GeoPackageOutboxTarget;
  let lastRead: { hash: string; features: Feature[] } | null = null;

  return {
    fingerprint: geopackageFingerprint,
    async fetchRemote(_entry, keys, maybeApplied): Promise<RemoteState> {
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        bytes = await deps.readFile(target.path);
      } catch (error) {
        // The drive or share is not there right now: wait for it.
        throw new EditSyncOfflineError(
          error instanceof Error ? error.message : String(error),
          "geopackageUnreachable",
        );
      }
      let collection: FeatureCollection;
      try {
        collection = await deps.parse(bytes, target.path, target.layer);
      } catch (error) {
        throw new EditSyncRejectedError(error instanceof Error ? error.message : String(error));
      }
      if (!collection.features.every((feature) => rowIdKey(feature) !== null)) {
        throw new EditSyncRejectedError(
          "The GeoPackage's row ids could not be read.",
          "geopackageNoRowIds",
        );
      }
      lastRead = { hash: await deps.sha256(bytes), features: collection.features };
      const rows = new Map(collection.features.map((feature) => [rowIdKey(feature)!, feature]));
      const byKey = new Map<string, Feature | null>(
        keys.map((key) => [key, rows.get(key) ?? null]),
      );
      const insertMatches = new Map<string, string>();
      const candidates = new Map<string, string>();
      for (const [key, feature] of rows) {
        if (Number(key) > target.maxFid) candidates.set(key, geopackageFingerprint(feature));
      }
      for (const op of maybeApplied) {
        for (const [key, fingerprint] of candidates) {
          if (fingerprint !== op.mineFingerprint) continue;
          insertMatches.set(op.id, key);
          candidates.delete(key);
          break;
        }
      }
      return { byKey, insertMatches };
    },

    async apply(_entry, plan): Promise<ApplyResult> {
      if (!lastRead) throw new EditSyncConflictRaceError("The GeoPackage was not read first.");
      const updates = new Map(plan.updates.map((op) => [op.key as string, op]));
      const deletes = new Set(plan.deletes.map((op) => op.key as string));
      const features: Feature[] = [];
      let maxFid = target.maxFid;
      for (const feature of lastRead.features) {
        const key = rowIdKey(feature)!;
        maxFid = Math.max(maxFid, Number(key));
        if (deletes.has(key)) continue;
        const update = updates.get(key);
        features.push(update ? { ...(update.feature as Feature), id: Number(key) } : feature);
      }
      const insertedKeys = new Map<string, string>();
      const taken = new Set(features.map((f) => String(f.id)));
      for (const op of plan.inserts) {
        // A re-created row (keep mine on a deleted row) keeps its id when free.
        const wanted = op.key !== null && !taken.has(op.key);
        const fid = wanted ? Number(op.key) : ++maxFid;
        maxFid = Math.max(maxFid, fid);
        taken.add(String(fid));
        features.push({ ...(op.feature as Feature), id: fid });
        insertedKeys.set(op.id, String(fid));
      }
      if (!features.length) {
        throw new EditSyncRejectedError(
          "Saving would leave the GeoPackage layer empty.",
          "geopackageEmpty",
        );
      }
      try {
        await deps.write({
          path: target.path,
          geojson: { type: "FeatureCollection", features },
          ...(target.layer ? { layer: target.layer } : {}),
          expected_sha256: lastRead.hash,
          preserve_fids: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof VectorWriteRejectedError) {
          if (error.status === 409) throw new EditSyncConflictRaceError(message);
          if (error.status === 503) throw new EditSyncOfflineError(message);
          throw new EditSyncRejectedError(message);
        }
        // No answer from the sidecar: the file may or may not have been replaced.
        throw new EditSyncUncertainError(message);
      }
      return {
        applied: [...plan.inserts, ...plan.updates, ...plan.deletes].map((op) => op.id),
        failed: [],
        insertedKeys,
      };
    },
  };
}

/** Store access for {@link reconcileGeoPackageLayerAfterSync}. */
export interface GeoPackageReconcileDeps {
  getLayer: (layerId: string) => GeoLibreLayer | undefined;
  updateLayer: (layerId: string, patch: Partial<GeoLibreLayer>) => void;
}

/**
 * After a sync, stamp assigned row ids on new features, take the file's
 * version of features kept as theirs, and re-base every settled row.
 *
 * @param entry The entry before the sync.
 * @param outcome The sync outcome.
 * @param deps Store access.
 * @returns True when the layer was updated.
 */
export function reconcileGeoPackageLayerAfterSync(
  entry: OutboxEntry,
  outcome: SyncOutcome,
  deps: GeoPackageReconcileDeps,
): boolean {
  const layer = deps.getLayer(entry.layerId);
  const target = entry.target as GeoPackageOutboxTarget;
  if (!layer?.geojson || layer.sourcePath?.trim() !== target.path) return false;
  const base = new Map(geoPackageBaseline(layer) ?? []);
  const remaining = new Set((outcome.entry?.ops ?? []).map((op) => op.id));
  const settled = entry.ops.filter((op) => !remaining.has(op.id));
  const assigned = new Map<string | number, number>();
  for (const op of settled) {
    const key = outcome.insertedKeys.get(op.id);
    if (key !== undefined && op.feature?.id !== undefined) assigned.set(op.feature.id, Number(key));
  }
  const theirs = new Map<string, Feature | null>();
  for (const op of settled) {
    if (op.key === null || !outcome.theirsKeys.includes(op.key)) continue;
    const conflict = entry.conflicts.find((c) => c.opId === op.id);
    theirs.set(op.key, conflict?.theirs ?? null);
  }
  const features: Feature[] = [];
  const present = new Set<string>();
  for (const feature of layer.geojson.features) {
    const fid = feature.id !== undefined ? assigned.get(feature.id) : undefined;
    const current = fid === undefined ? feature : { ...feature, id: fid };
    const key = rowIdKey(current);
    if (key !== null) present.add(key);
    if (key !== null && theirs.has(key)) {
      const server = theirs.get(key);
      if (server) features.push(server);
      continue;
    }
    features.push(current);
  }
  // Keep theirs on a row deleted locally: bring the file's version back.
  for (const [key, server] of theirs) if (server && !present.has(key)) features.push(server);
  for (const op of settled) {
    const inserted = outcome.insertedKeys.get(op.id);
    // A row re-created under a new id leaves its old one behind.
    if (inserted !== undefined && op.key !== null && op.key !== inserted) base.delete(op.key);
    // An insert is based under the row id the save assigned.
    const key = inserted ?? op.key ?? null;
    if (key === null) continue;
    if (theirs.has(key)) {
      const server = theirs.get(key);
      if (server) base.set(key, geopackageFingerprint(server));
      else base.delete(key);
    } else if (op.kind === "delete") {
      base.delete(key);
    } else if (op.mineFingerprint) {
      base.set(key, op.mineFingerprint);
    }
  }
  setGeoPackageBaseline(layer.id, target.path, base);
  const { geometryEdited: _cleared, ...metadata } = layer.metadata;
  // Still "edited" while anything differs from the new base: queued ops, or
  // edits made while the write was in flight.
  const stillEdited =
    outcome.entry !== null ||
    (buildGeoPackageChangeSet({ ...layer, geojson: { ...layer.geojson, features } }) ?? []).length >
      0;
  deps.updateLayer(layer.id, {
    geojson: { ...layer.geojson, features },
    metadata: stillEdited ? { ...metadata, geometryEdited: true } : metadata,
  });
  return true;
}
