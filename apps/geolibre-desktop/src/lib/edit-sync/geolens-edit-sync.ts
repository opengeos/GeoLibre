/**
 * GeoLens backend of the offline edit outbox (#3530).
 *
 * The GeoLens plugin keeps a baseline of every editable layer (the features as
 * loaded). Saving through the outbox diffs the layer against it by `gid` and
 * queues the change set. Syncing reads each touched feature's current version
 * from the OGC API Features item endpoint, holds features changed on both
 * sides as conflicts, and writes the rest one request per feature (GeoLens has
 * no bulk or transactional endpoint), so a feature the server refuses stays
 * queued with its message while the others land.
 *
 * GeoLens offers no optimistic-concurrency token, so the check is "read, then
 * write" per feature: a change made in the instant between the two is not
 * caught. The API key stays with the plugin's live connection; an entry syncs
 * while the GeoLens panel is connected to its server and waits otherwise.
 */

import type { GeoLibreLayer } from "@geolibre/core";
import {
  createFeature,
  deleteFeature,
  featureGid,
  fetchDatasetFeature,
  fetchDatasetFeatures,
  GeoLensHttpError,
  updateFeature,
  type GeoLensClientOptions,
  type GeoLensFeatureBaseline,
  type GeoLensFetch,
} from "@geolibre/plugins/geolens-api";
import type { Feature, FeatureCollection } from "geojson";
import {
  buildChangeSet,
  EditSyncOfflineError,
  EditSyncRejectedError,
  EditSyncUncertainError,
  EditSyncWaitingError,
  type ApplyResult,
  type EditSyncAdapter,
  type OutboxEntry,
  type OutboxOp,
  type RemoteState,
  type SyncOutcome,
} from "./edit-outbox";
import { featureFingerprint } from "./feature-fingerprint";

/**
 * Decimals GeoLens serves coordinates with: its items pages carry 6, so every
 * GeoLens comparison rounds to that and a landed edit with more precise
 * vertices still matches the stored row.
 */
const GEOLENS_COORDINATE_DECIMALS = 6;

/** Fingerprint a feature the way every GeoLens comparison does. */
export function geolensFingerprint(feature: Pick<Feature, "geometry" | "properties">): string {
  return featureFingerprint(feature, { coordinateDecimals: GEOLENS_COORDINATE_DECIMALS });
}

/** What the outbox stores to find a GeoLens dataset again (no API key). */
export interface GeoLensOutboxTarget {
  [key: string]: unknown;
  baseUrl: string;
  datasetId: string;
  /** The feature limit the layer was loaded with, for finding unseen inserts. */
  featureLimit: number;
  /** The largest gid in the base: rows above it were created after the load. */
  maxGid: number;
}

/** Outbox entry id for a GeoLens layer: one entry per dataset and store layer. */
export function geolensOutboxId(target: GeoLensOutboxTarget, layerId: string): string {
  return `geolens:${JSON.stringify([target.baseUrl, target.datasetId, layerId])}`;
}

function gidKey(feature: Feature): string | null {
  const gid = featureGid(feature);
  return gid === null ? null : String(gid);
}

/**
 * Give features without a gid a stable local id, so the gid GeoLens assigns
 * on insert can be stamped onto the right feature.
 *
 * @param collection The layer's features.
 * @returns The same collection when nothing changed, else a copy.
 */
export function withGeoLensLocalIds(collection: FeatureCollection): FeatureCollection {
  let changed = false;
  const seen = new Set<number>();
  const features = collection.features.map((feature) => {
    const gid = featureGid(feature);
    // A second feature claiming a gid (a copy) is new, and needs its own id.
    if (gid !== null && !seen.has(gid)) {
      seen.add(gid);
      return feature;
    }
    if (typeof feature.id === "string" && feature.id.startsWith("geolens-new-")) return feature;
    changed = true;
    return { ...feature, id: `geolens-new-${crypto.randomUUID()}` };
  });
  return changed ? { ...collection, features } : collection;
}

/**
 * Diff a GeoLens layer against its baseline into queued operations.
 *
 * @param collection The layer's features (with local ids on new ones).
 * @param baseline The plugin's baseline for the layer.
 * @returns The operations.
 */
export function buildGeoLensChangeSet(
  collection: FeatureCollection,
  baseline: GeoLensFeatureBaseline,
): OutboxOp[] {
  const base = new Map<string, string>();
  for (const [key, entry] of baseline) {
    base.set(key, geolensFingerprint({ geometry: entry.geometry!, properties: entry.properties }));
  }
  return buildChangeSet({
    baseline: base,
    // GeoLens cannot store a feature without geometry; like the plugin's own
    // diff, such a drawing is not sent.
    features: collection.features.filter(
      (feature) => feature.geometry || featureGid(feature) !== null,
    ),
    keyOf: gidKey,
    rawKeyOf: (feature) => featureGid(feature) ?? undefined,
    rawKeyOfBase: (key) => Number(key),
    stripKey: (feature) => ({ ...feature, id: `geolens-new-${crypto.randomUUID()}` }),
    fingerprint: geolensFingerprint,
    newId: () => crypto.randomUUID(),
  });
}

/**
 * Describe a GeoLens save as an outbox target.
 *
 * @param baseUrl The server.
 * @param datasetId The dataset.
 * @param baseline The layer's baseline.
 * @param featureLimit The limit the layer was loaded with.
 * @returns The target.
 */
export function geolensOutboxTarget(
  baseUrl: string,
  datasetId: string,
  baseline: GeoLensFeatureBaseline,
  featureLimit: number,
): GeoLensOutboxTarget {
  let maxGid = -1;
  for (const key of baseline.keys()) maxGid = Math.max(maxGid, Number(key));
  return { baseUrl, datasetId, featureLimit, maxGid };
}

/** How many rows past the download limit the lost-insert search reads. */
const RECOVERY_EXTRA_FEATURES = 10_000;

/** A live GeoLens connection for syncing. */
export interface GeoLensConnection {
  client: GeoLensClientOptions;
  fetchImpl: GeoLensFetch;
}

function readFailure(error: unknown): Error {
  if (error instanceof GeoLensHttpError) {
    return error.status >= 500
      ? new EditSyncOfflineError(error.message)
      : new EditSyncRejectedError(error.message);
  }
  return new EditSyncOfflineError(error instanceof Error ? error.message : String(error));
}

/**
 * Build the sync adapter for a queued GeoLens change set.
 *
 * @param entry The outbox entry.
 * @param connection The panel's live connection, if it is signed in to the server.
 * @returns The adapter.
 * @throws EditSyncWaitingError when the panel is not connected with an API key.
 */
export function createGeoLensSyncAdapter(
  entry: OutboxEntry,
  connection: GeoLensConnection | undefined,
): EditSyncAdapter {
  if (!connection?.client.apiKey) {
    throw new EditSyncWaitingError(
      "Connect to this GeoLens server with an API key in the GeoLens panel to sync its queued edits.",
      "geolensNotConnected",
    );
  }
  const { client, fetchImpl } = connection;
  const target = entry.target as GeoLensOutboxTarget;

  return {
    fingerprint: geolensFingerprint,
    async fetchRemote(_entry, keys, maybeApplied): Promise<RemoteState> {
      const byKey = new Map<string, Feature | null>();
      const insertMatches = new Map<string, string>();
      try {
        for (const key of keys) {
          byKey.set(
            key,
            await fetchDatasetFeature(client, target.datasetId, Number(key), fetchImpl),
          );
        }
        if (maybeApplied.length) {
          // Room for rows added since the download, which follow the old ones.
          const all = await fetchDatasetFeatures(
            client,
            target.datasetId,
            target.featureLimit + RECOVERY_EXTRA_FEATURES,
            fetchImpl,
          );
          const candidates = new Map<string, Feature>();
          for (const feature of all.features) {
            const gid = featureGid(feature);
            if (gid !== null && gid > target.maxGid) candidates.set(String(gid), feature);
          }
          for (const op of maybeApplied) {
            // Compare only what the insert set: the server may fill other columns.
            const sent = new Set(
              Object.entries(op.feature?.properties ?? {})
                .filter(([, value]) => value !== null && value !== undefined)
                .map(([name]) => name),
            );
            for (const [key, feature] of candidates) {
              const narrowed = {
                ...feature,
                properties: Object.fromEntries(
                  Object.entries(feature.properties ?? {}).filter(([name]) => sent.has(name)),
                ),
              };
              if (geolensFingerprint(narrowed) !== op.mineFingerprint) continue;
              insertMatches.set(op.id, key);
              candidates.delete(key);
              break;
            }
          }
        }
      } catch (error) {
        throw readFailure(error);
      }
      return { byKey, insertMatches };
    },

    async apply(_entry, plan): Promise<ApplyResult> {
      const applied: string[] = [];
      const failed: Array<{ opId: string; message: string }> = [];
      const insertedKeys = new Map<string, string>();
      // One request per feature, in order; an HTTP refusal fails that feature
      // only, while no answer at all stops the run with an unknown outcome.
      const run = async (op: OutboxOp, write: () => Promise<void>) => {
        try {
          await write();
          applied.push(op.id);
        } catch (error) {
          // A revoked key or a rate limit stops the whole run, not one feature.
          if (error instanceof GeoLensHttpError && (error.status === 401 || error.status === 403)) {
            throw new EditSyncRejectedError(error.message);
          }
          if (error instanceof GeoLensHttpError && error.status === 429) {
            throw new EditSyncOfflineError(error.message);
          }
          if (error instanceof GeoLensHttpError && error.status < 500) {
            failed.push({ opId: op.id, message: error.message });
            return;
          }
          throw new EditSyncUncertainError(error instanceof Error ? error.message : String(error));
        }
      };
      for (const op of plan.updates) {
        const feature = op.feature as Feature;
        await run(op, () =>
          updateFeature(
            client,
            target.datasetId,
            {
              gid: Number(op.key),
              mode: feature.geometry ? "replace" : "patch",
              geometry: feature.geometry ?? null,
              properties: cleanProperties(feature.properties),
            },
            fetchImpl,
          ),
        );
      }
      for (const op of plan.inserts) {
        const feature = op.feature as Feature;
        if (!feature.geometry) continue;
        await run(op, async () => {
          const gid = await createFeature(
            client,
            target.datasetId,
            { geometry: feature.geometry, properties: cleanProperties(feature.properties) },
            fetchImpl,
          );
          // Without its gid the feature cannot be linked to its row, and a
          // later save would add it again: settle it through the dedupe.
          if (gid === null) throw new Error("GeoLens did not return the new feature's id.");
          insertedKeys.set(op.id, String(gid));
        });
      }
      for (const op of plan.deletes) {
        await run(op, () => deleteFeature(client, target.datasetId, Number(op.key), fetchImpl));
      }
      return { applied, failed, insertedKeys };
    },
  };
}

function cleanProperties(properties: Record<string, unknown> | null | undefined) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties ?? {})) {
    if (key.startsWith("__gm_") || key === "__geolibre_fid") continue;
    out[key] = value;
  }
  return out;
}

/** Store and plugin access for {@link reconcileGeoLensLayerAfterSync}. */
export interface GeoLensReconcileDeps {
  getLayer: (layerId: string) => GeoLibreLayer | undefined;
  updateLayer: (layerId: string, patch: Partial<GeoLibreLayer>) => void;
  getBaseline: (layerId: string) => GeoLensFeatureBaseline | undefined;
  setBaseline: (layerId: string, baseline: GeoLensFeatureBaseline) => void;
  connection: GeoLensConnection | undefined;
}

/**
 * After a sync, stamp assigned gids onto new features, take the server's
 * version of features kept as theirs, and re-base every settled feature in
 * the plugin's baseline. Features still queued keep their old base.
 *
 * @param entry The entry before the sync.
 * @param outcome The sync outcome.
 * @param deps Store and plugin access.
 * @returns True when the layer was updated.
 */
export async function reconcileGeoLensLayerAfterSync(
  entry: OutboxEntry,
  outcome: SyncOutcome,
  deps: GeoLensReconcileDeps,
): Promise<boolean> {
  const layer = deps.getLayer(entry.layerId);
  const baseline = deps.getBaseline(entry.layerId);
  if (!layer?.geojson || !baseline) return false;
  const target = entry.target as GeoLensOutboxTarget;
  const remaining = new Set((outcome.entry?.ops ?? []).map((op) => op.id));
  const settled = entry.ops.filter((op) => !remaining.has(op.id));
  const assigned = new Map<string | number, number>();
  for (const op of settled) {
    const key = outcome.insertedKeys.get(op.id);
    if (key !== undefined && op.feature?.id !== undefined) assigned.set(op.feature.id, Number(key));
  }
  const theirsKeys = new Set(outcome.theirsKeys);
  const theirs = new Map<string, Feature | null>();
  // Keep-theirs features whose read failed keep their old base, so the next
  // save still sees them as differing and they come back for review.
  const unread = new Set<string>(theirsKeys);
  if (deps.connection && theirsKeys.size) {
    for (const key of theirsKeys) {
      try {
        theirs.set(
          key,
          await fetchDatasetFeature(
            deps.connection.client,
            target.datasetId,
            Number(key),
            deps.connection.fetchImpl,
          ),
        );
        unread.delete(key);
      } catch {
        // Leave that feature and its base as they are.
      }
    }
  }
  const next: GeoLensFeatureBaseline = new Map(baseline);
  const live = deps.getLayer(entry.layerId) ?? layer;
  const features: Feature[] = [];
  const present = new Set<string>();
  for (const feature of live.geojson!.features) {
    const gid = feature.id !== undefined ? assigned.get(feature.id) : undefined;
    const current = gid === undefined ? feature : { ...feature, id: gid };
    const key = gidKey(current);
    if (key !== null) present.add(key);
    if (key !== null && theirs.has(key)) {
      const server = theirs.get(key);
      if (server) features.push(server);
      continue;
    }
    features.push(current);
  }
  // Keep theirs on a feature deleted locally: bring the server's version back.
  for (const [key, server] of theirs) if (server && !present.has(key)) features.push(server);
  for (const op of settled) {
    // An insert is based under the gid the server assigned, not a local id.
    const inserted = outcome.insertedKeys.get(op.id);
    // An update re-created under a new gid leaves its old one behind.
    if (inserted !== undefined && op.key !== null && op.key !== inserted) next.delete(op.key);
    const key = inserted ?? op.key ?? null;
    if (key === null) continue;
    if (theirs.has(key) || unread.has(key)) continue;
    if (op.kind === "delete") {
      next.delete(key);
      continue;
    }
    if (op.feature) {
      next.set(key, {
        geometry: op.feature.geometry ? structuredClone(op.feature.geometry) : null,
        properties: cleanProperties(op.feature.properties),
      });
    }
  }
  for (const [key, server] of theirs) {
    if (server) {
      next.set(key, {
        geometry: server.geometry ? structuredClone(server.geometry) : null,
        properties: cleanProperties(server.properties),
      });
    } else next.delete(key);
  }
  deps.setBaseline(entry.layerId, next);
  deps.updateLayer(entry.layerId, { geojson: { ...live.geojson!, features } });
  return true;
}
