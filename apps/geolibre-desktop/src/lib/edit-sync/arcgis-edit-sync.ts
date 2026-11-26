/**
 * ArcGIS feature service backend of the offline edit outbox (#3530).
 *
 * The layer's `arcgisEditBaseline` (the features as last downloaded) is the
 * base. Saving diffs the layer against it into a change set keyed by object
 * ID; syncing queries the service for the current version of every touched
 * feature on the same GeoJSON path the layer was loaded with, holds features
 * edited on both sides as conflicts, and sends the rest in one `applyEdits`
 * call with `rollbackOnFailure=false`, so a feature the service rejects stays
 * queued with its message while the others land.
 *
 * Versions compare the geometry and the **editable** attributes only. Fields
 * the service maintains (object and global IDs, editor tracking, shape
 * area/length) are left out: they change on every save, so including them
 * would turn a retried save that already landed into a false conflict. For a
 * layer loaded generalized (simplified shapes at a zoomed-out view) geometry
 * is left out too, since the downloaded shapes are not the stored ones.
 *
 * Credentials stay with the layer's live connection: an entry syncs while its
 * layer is open in the project, and waits (without failing) otherwise.
 *
 * Only `import type` from the ArcGIS plugin here, so unit tests load no
 * MapLibre code; the live session is injected by the registration module.
 */

import type { GeoLibreLayer } from "@geolibre/core";
import {
  arcGISObjectId,
  describeArcGISEditError,
  planArcGISEdits,
  type ArcGISEditInfo,
} from "@geolibre/plugins/arcgis-edits";
import type { ArcGISEditResultEntry, ArcGISOutboxSession } from "@geolibre/plugins/arcgis-layer";
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

/** What the outbox stores to find an ArcGIS layer again (no credentials). */
export interface ArcGISOutboxTarget {
  [key: string]: unknown;
  /** The layer's REST URL, without `/query`. */
  layerUrl: string;
  objectIdField: string;
  /** Attributes a user can edit; the only ones versions compare. */
  editableFields: string[];
  /** Leave geometry out of versions (the layer holds simplified shapes). */
  ignoreGeometry: boolean;
  /** The largest object ID in the base, for finding inserts that landed unseen. */
  maxObjectId: number;
}

function layerUrlOf(layer: GeoLibreLayer): string | null {
  const queryUrl = layer.source.arcgisQueryUrl;
  if (typeof queryUrl !== "string") return null;
  return queryUrl.replace(/\/+$/, "").replace(/\/query$/i, "");
}

function baselineOf(layer: GeoLibreLayer): FeatureCollection | undefined {
  const value = layer.metadata.arcgisEditBaseline as FeatureCollection | undefined;
  return value?.type === "FeatureCollection" && Array.isArray(value.features) ? value : undefined;
}

/**
 * Describe an ArcGIS layer as an outbox target, or null when it lacks an
 * object ID field, a base, or a service URL.
 *
 * @param layer A writable ArcGIS feature layer.
 * @returns The target.
 */
export function arcgisOutboxTarget(layer: GeoLibreLayer): ArcGISOutboxTarget | null {
  const info = layer.metadata.arcgisEditInfo as ArcGISEditInfo | undefined;
  const field = info?.objectIdField;
  const layerUrl = layerUrlOf(layer);
  const baseline = baselineOf(layer);
  if (!field || !layerUrl || !baseline) return null;
  let maxObjectId = -1;
  for (const feature of baseline.features) {
    const id = feature.properties?.[field];
    if (typeof id === "number" && id > maxObjectId) maxObjectId = id;
  }
  return {
    layerUrl,
    objectIdField: field,
    editableFields: (info.fields ?? [])
      .filter((f) => f.editable !== false && f.name !== field && f.name !== info.globalIdField)
      .map((f) => f.name),
    ignoreGeometry: info.geometryGeneralized === true,
    maxObjectId,
  };
}

/** Outbox entry id for an ArcGIS layer: one entry per service layer. */
export function arcgisOutboxId(target: ArcGISOutboxTarget): string {
  return `arcgis:${JSON.stringify([target.layerUrl])}`;
}

/**
 * The version fingerprint of a feature for a target: geometry (unless the
 * layer is generalized) and editable attributes.
 *
 * @param target The target.
 * @returns The fingerprint function.
 */
export function arcgisFingerprint(target: ArcGISOutboxTarget): (feature: Feature) => string {
  const editable = new Set(target.editableFields);
  return (feature) => {
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(feature.properties ?? {})) {
      if (editable.has(key)) properties[key] = value;
    }
    // Rounded to ~1 cm: the service stores coordinates at its own resolution,
    // so the copy of my edit it returns rarely has every digit I sent.
    return featureFingerprint(
      {
        geometry: (target.ignoreGeometry ? null : feature.geometry) as Feature["geometry"],
        properties,
      },
      { coordinateDecimals: ARCGIS_COORDINATE_DECIMALS },
    );
  };
}

/** Decimals ArcGIS versions compare coordinates at (about 1 cm in degrees). */
const ARCGIS_COORDINATE_DECIMALS = 7;

function objectIdKey(field: string) {
  return (feature: Feature): string | null => {
    const value = feature.properties?.[field];
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? String(value)
      : null;
  };
}

/**
 * Diff an ArcGIS layer against its downloaded base into queued operations.
 * New features must carry a stable `id` (see {@link withLocalFeatureIds}) so
 * the object ID the service assigns can be written back to the right one.
 *
 * @param layer The layer.
 * @param target Its target.
 * @returns The operations, or null without a base or when a downloaded
 *   feature lost its object ID (the direct save then reports it).
 */
export function buildArcGISChangeSet(
  layer: GeoLibreLayer,
  target: ArcGISOutboxTarget,
): OutboxOp[] | null {
  const baseline = baselineOf(layer);
  if (!baseline || !layer.geojson) return null;
  const keyOf = objectIdKey(target.objectIdField);
  const fingerprint = arcgisFingerprint(target);
  const base = new Map<string, string>();
  const baseIds = new Set<string | number>();
  for (const feature of baseline.features) {
    const key = keyOf(feature);
    if (key !== null && !base.has(key)) base.set(key, fingerprint(feature));
    if (feature.id !== undefined) baseIds.add(feature.id);
  }
  // A downloaded feature that lost its object ID would become a delete plus a
  // new insert; ArcGIS object IDs cannot be cleared, so leave it to the direct
  // save, which refuses it with an explanation.
  if (
    layer.geojson.features.some(
      (feature) => keyOf(feature) === null && feature.id !== undefined && baseIds.has(feature.id),
    )
  ) {
    return null;
  }
  return buildChangeSet({
    baseline: base,
    features: layer.geojson.features,
    keyOf,
    rawKeyOf: (feature) => {
      const key = keyOf(feature);
      return key === null ? undefined : Number(key);
    },
    rawKeyOfBase: (key) => Number(key),
    fingerprint,
    stripKey: (feature) => stripObjectId(feature, target.objectIdField),
    newId: () => crypto.randomUUID(),
  });
}

function stripObjectId(feature: Feature, field: string): Feature {
  const properties = { ...(feature.properties ?? {}) };
  delete properties[field];
  return { ...feature, properties };
}

/**
 * Give every feature without an object ID a stable local id, so an insert can
 * be matched back to its feature after the service assigns the object ID.
 *
 * @param collection The layer's features.
 * @param field The object ID field.
 * @returns The same collection when nothing needed an id, else a copy.
 */
export function withLocalFeatureIds(
  collection: FeatureCollection,
  field: string,
): FeatureCollection {
  let changed = false;
  const features = collection.features.map((feature) => {
    if (feature.id !== undefined || feature.properties?.[field] != null) return feature;
    changed = true;
    return { ...feature, id: `arcgis-new-${crypto.randomUUID()}` };
  });
  return changed ? { ...collection, features } : collection;
}

/**
 * Classify a failure of a read against the service: no answer or a 5xx is
 * offline (retry), anything else a refusal.
 *
 * @param error The thrown value.
 * @returns The outbox error to rethrow.
 */
export function readFailure(error: unknown): Error {
  if (error instanceof EditSyncRejectedError || error instanceof EditSyncWaitingError) return error;
  const message = error instanceof Error ? error.message : String(error);
  // No answer (a fetch TypeError) or a 5xx gateway answer: try again later.
  if (error instanceof TypeError || /HTTP 5\d\d/.test(message)) {
    return new EditSyncOfflineError(message);
  }
  return new EditSyncRejectedError(message);
}

const QUERY_CHUNK = 200;

/**
 * Build the sync adapter for a queued ArcGIS change set.
 *
 * @param entry The outbox entry.
 * @param session The layer's live session (null when the layer is not open).
 * @returns The adapter.
 * @throws EditSyncWaitingError when the layer is not open in the project.
 */
export function createArcGISSyncAdapter(
  entry: OutboxEntry,
  session: ArcGISOutboxSession | null | undefined,
): EditSyncAdapter {
  if (!session) {
    throw new EditSyncWaitingError(
      "Open the project that holds this ArcGIS layer to sync its queued edits.",
      "arcgisLayerClosed",
    );
  }
  const target = entry.target as ArcGISOutboxTarget;
  // The session is opened by layer id: never send edits queued for one
  // service to another the layer now points at.
  const normalize = (url: string) =>
    url
      .replace(/\/+$/, "")
      .replace(/\/query$/i, "")
      .toLowerCase();
  if (normalize(session.layerUrl) !== normalize(target.layerUrl)) {
    throw new EditSyncRejectedError(
      "This layer now points at a different ArcGIS service than the queued edits.",
      "arcgisTargetMismatch",
    );
  }
  const field = target.objectIdField;
  const keyOf = objectIdKey(field);
  const fingerprint = arcgisFingerprint(target);
  // An insert is compared on the attributes it set: the service may fill
  // others with defaults.
  const sentFingerprint = (stored: Feature, sent: Feature | undefined) => {
    const names = new Set(
      Object.entries(sent?.properties ?? {})
        .filter(([, value]) => value !== null && value !== undefined)
        .map(([name]) => name),
    );
    return fingerprint({
      ...stored,
      properties: Object.fromEntries(
        Object.entries(stored.properties ?? {}).filter(([name]) => names.has(name)),
      ),
    });
  };

  return {
    fingerprint,
    insertFingerprint: (stored, op) => sentFingerprint(stored, op.feature),
    async fetchRemote(_entry, keys, maybeApplied): Promise<RemoteState> {
      const byKey = new Map<string, Feature | null>(keys.map((key) => [key, null]));
      const insertMatches = new Map<string, string>();
      try {
        for (let i = 0; i < keys.length; i += QUERY_CHUNK) {
          const chunk = keys.slice(i, i + QUERY_CHUNK);
          const features = await session.query({ objectIds: chunk.join(",") });
          for (const feature of features) {
            const key = keyOf(feature);
            if (key !== null && byKey.has(key)) byKey.set(key, feature);
          }
        }
        if (maybeApplied.length) {
          // Object IDs only grow, so an insert that landed unseen is above the base.
          const fresh = await session.query({
            where: `${field} > ${Math.max(target.maxObjectId, -1)}`,
          });
          // Filter on the client too: not every paging path keeps the where.
          const candidates = new Map<string, Feature>();
          for (const feature of fresh) {
            const key = keyOf(feature);
            if (key !== null && Number(key) > target.maxObjectId) candidates.set(key, feature);
          }
          for (const op of maybeApplied) {
            for (const [key, feature] of candidates) {
              if (sentFingerprint(feature, op.feature) !== op.mineFingerprint) continue;
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
      // Diff against the server's current rows, so an update sends only what
      // differs from them, and a "keep mine" overwrites the latest version.
      const baseline: Feature[] = [];
      for (const op of [...plan.updates, ...plan.deletes]) {
        const theirs = plan.remote.byKey.get(op.key as string);
        if (theirs) baseline.push({ ...theirs, id: op.key as string });
      }
      // My update carries the service-maintained values (editor tracking) as
      // they were when I loaded it; take those from the server's version and
      // only my editable attributes and geometry from mine.
      const editable = new Set(target.editableFields);
      const readOnly = (session.info.fields ?? [])
        .map((f) => f.name)
        .filter((name) => !editable.has(name));
      const mergedUpdate = (op: OutboxOp): Feature => {
        const mine = op.feature as Feature;
        const theirs = plan.remote.byKey.get(op.key as string);
        const properties: Record<string, unknown> = { ...(theirs?.properties ?? mine.properties) };
        for (const [key, value] of Object.entries(mine.properties ?? {})) {
          if (editable.has(key)) properties[key] = value;
        }
        return {
          ...mine,
          id: op.key as string,
          geometry: target.ignoreGeometry && theirs ? theirs.geometry : mine.geometry,
          properties,
        };
      };
      const current: Feature[] = [
        ...plan.updates.map(mergedUpdate),
        ...plan.inserts.map((op) => {
          // A re-created feature (keep mine on a server delete) still holds the
          // service-maintained values of the old row; the service sets its own.
          const properties = { ...(op.feature?.properties ?? {}) };
          for (const name of readOnly) delete properties[name];
          return { ...(op.feature as Feature), properties, id: op.id };
        }),
      ];
      let edits;
      try {
        edits = planArcGISEdits(
          { type: "FeatureCollection", features: baseline },
          { type: "FeatureCollection", features: current },
          session.info,
        );
      } catch (error) {
        throw new EditSyncRejectedError(error instanceof Error ? error.message : String(error));
      }
      // planArcGISEdits deletes every baseline feature the current set lacks:
      // exactly the planned deletes, since updates are always in both.
      if (!edits.adds.length && !edits.updates.length && !edits.deletes.length) {
        // Every planned update matched the server already.
        return { applied: [...plan.updates, ...plan.deletes].map((op) => op.id), failed: [] };
      }
      let response;
      try {
        response = await session.applyEdits({
          adds: edits.adds.map((e) => e.payload),
          updates: edits.updates.map((e) => e.payload),
          deletes: edits.deletes,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof Error && error.name === "ArcGISEditsRejectedError") {
          throw new EditSyncRejectedError(message);
        }
        throw new EditSyncUncertainError(message);
      }
      // A missing result, or an add that succeeded without an object ID, leaves
      // the outcome unknown: the retry then looks for those inserts first.
      if (
        (response.addResults?.length ?? 0) !== edits.adds.length ||
        (response.updateResults?.length ?? 0) !== edits.updates.length ||
        (response.deleteResults?.length ?? 0) !== edits.deletes.length ||
        response.addResults?.some((r) => r.success && !Number.isSafeInteger(r.objectId))
      ) {
        throw new EditSyncUncertainError("ArcGIS returned incomplete edit results.");
      }
      const opByKey = new Map(
        [...plan.updates, ...plan.deletes].map((op) => [op.key as string, op]),
      );
      const applied: string[] = [];
      const failed: Array<{ opId: string; message: string }> = [];
      const insertedKeys = new Map<string, string>();
      const record = (opId: string | undefined, entry: ArcGISEditResultEntry | undefined) => {
        if (!opId) return false;
        if (entry?.success) {
          applied.push(opId);
          return true;
        }
        failed.push({
          opId,
          message: entry?.error?.description
            ? describeArcGISEditError(entry.error.description)
            : `ArcGIS error ${entry?.error?.code ?? "unknown"}`,
        });
        return false;
      };
      edits.adds.forEach((add, i) => {
        const entryResult = response.addResults?.[i];
        const opId = String(add.feature.id);
        if (record(opId, entryResult) && Number.isSafeInteger(entryResult?.objectId)) {
          insertedKeys.set(opId, String(entryResult!.objectId));
        }
      });
      edits.updates.forEach((update, i) => {
        record(opByKey.get(String(update.objectId))?.id, response.updateResults?.[i]);
      });
      edits.deletes.forEach((id, i) => {
        record(opByKey.get(String(id))?.id, response.deleteResults?.[i]);
      });
      // Updates the plan skipped as identical to the server are done too.
      const sent = new Set([...applied, ...failed.map((f) => f.opId)]);
      for (const op of plan.updates) if (!sent.has(op.id)) applied.push(op.id);
      return { applied, failed, insertedKeys };
    },
  };
}

/** Store access for {@link reconcileArcGISLayerAfterSync}. */
export interface ArcGISReconcileDeps {
  getLayer: (layerId: string) => GeoLibreLayer | undefined;
  updateLayer: (layerId: string, patch: Partial<GeoLibreLayer>) => void;
  session: ArcGISOutboxSession | null | undefined;
}

/**
 * After a sync, bring the open layer and its base in line with the service:
 * stamp assigned object IDs on new features, take the server's version of
 * every feature that synced (server-calculated values) or was kept as theirs,
 * and drop deleted ones from the base. Features still queued keep their old
 * base, so they keep showing as unsaved.
 *
 * @param entry The entry as it was before the sync.
 * @param outcome The sync outcome.
 * @param deps Store access and the live session.
 * @returns True when the layer was updated.
 */
export async function reconcileArcGISLayerAfterSync(
  entry: OutboxEntry,
  outcome: SyncOutcome,
  deps: ArcGISReconcileDeps,
): Promise<boolean> {
  const layer = deps.getLayer(entry.layerId);
  const target = entry.target as ArcGISOutboxTarget;
  if (!layer?.geojson || !deps.session) return false;
  const current = arcgisOutboxTarget(layer);
  if (!current || arcgisOutboxId(current) !== entry.id) return false;
  const field = target.objectIdField;
  const keyOf = objectIdKey(field);
  const fingerprint = arcgisFingerprint(target);
  const remaining = new Set((outcome.entry?.ops ?? []).map((op) => op.id));
  const settled = entry.ops.filter((op) => !remaining.has(op.id));
  const theirsKeys = new Set(outcome.theirsKeys);

  // Local feature id -> assigned object ID, for every operation that was sent
  // as an insert (including an update re-created by keep mine).
  const assigned = new Map<string | number, number>();
  // Server key -> the version this sync wrote, to tell later local edits apart.
  const written = new Map<string, Feature>();
  const deleted = new Set<string>();
  for (const op of settled) {
    const insertedKey = outcome.insertedKeys.get(op.id);
    if (insertedKey !== undefined && op.feature?.id !== undefined) {
      assigned.set(op.feature.id, Number(insertedKey));
    }
    const key = insertedKey ?? op.key;
    if (key === null || theirsKeys.has(key)) continue;
    if (op.kind === "delete") deleted.add(key);
    else if (op.feature)
      written.set(key, {
        ...op.feature,
        properties: { ...op.feature.properties, [field]: Number(key) },
      });
  }
  const refreshKeys = new Set<string>([...written.keys(), ...theirsKeys]);
  // A failed read is not an empty server: keep the old versions instead.
  let freshByKey: Map<string | null, Feature> | null = new Map();
  if (refreshKeys.size) {
    try {
      const fresh = await deps.session.query({ objectIds: [...refreshKeys].join(",") });
      freshByKey = new Map(fresh.map((f) => [keyOf(f), f]));
    } catch {
      freshByKey = null;
    }
  }
  const live = deps.getLayer(entry.layerId);
  if (!live?.geojson) return false;
  const baseline = baselineOf(live) ?? { type: "FeatureCollection", features: [] };

  const seen = new Set<string>();
  const features: Feature[] = [];
  for (const feature of live.geojson.features) {
    const oid =
      feature.id !== undefined && assigned.has(feature.id) ? assigned.get(feature.id) : undefined;
    const withId =
      oid === undefined
        ? feature
        : { ...feature, properties: { ...feature.properties, [field]: oid } };
    const key = keyOf(withId);
    if (key !== null) seen.add(key);
    const server = key !== null && freshByKey ? freshByKey.get(key) : undefined;
    if (key !== null && theirsKeys.has(key) && freshByKey) {
      // Keep theirs: show the server's version, or drop a feature it deleted.
      if (server) features.push({ ...server, id: withId.id });
      continue;
    }
    // Synced features take server-calculated values, unless edited again
    // since the save (then the newer local values stay).
    const sent = key !== null ? written.get(key) : undefined;
    if (server && sent && fingerprint(withId) === fingerprint(sent)) {
      features.push({ ...server, id: withId.id });
      continue;
    }
    features.push(withId);
  }
  // Keep theirs on a feature deleted locally: bring the server's version back.
  if (freshByKey) {
    for (const key of theirsKeys) {
      const server = freshByKey.get(key);
      if (server && !seen.has(key)) features.push(server);
    }
  }
  const nextBase = new Map<string, Feature>();
  for (const feature of baseline.features) {
    const key = keyOf(feature);
    if (key !== null && !deleted.has(key)) nextBase.set(key, feature);
  }
  for (const [key, sent] of written) {
    // The server's copy when it was read, else what this sync wrote.
    nextBase.set(key, freshByKey?.get(key) ?? sent);
  }
  if (freshByKey) {
    for (const key of theirsKeys) {
      const server = freshByKey.get(key);
      if (server) nextBase.set(key, server);
      else nextBase.delete(key);
    }
  }
  const { geometryEdited: _cleared, ...metadata } = live.metadata;
  deps.updateLayer(entry.layerId, {
    geojson: { ...live.geojson, features },
    metadata: {
      ...metadata,
      ...(outcome.entry ? { geometryEdited: true } : {}),
      arcgisEditBaseline: structuredClone({
        type: "FeatureCollection",
        features: [...nextBase.values()],
      }),
      arcgisSaveUncertain: false,
    },
  });
  return true;
}
