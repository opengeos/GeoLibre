import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeoLibreLayer } from "@geolibre/core";
import type { ArcGISEditInfo } from "@geolibre/plugins/arcgis-edits";
import type { ArcGISApplyEditsResponse, ArcGISOutboxSession } from "@geolibre/plugins/arcgis-layer";
import type { Feature, FeatureCollection } from "geojson";
import {
  arcgisFingerprint,
  arcgisOutboxId,
  arcgisOutboxTarget,
  buildArcGISChangeSet,
  createArcGISSyncAdapter,
  readFailure,
  reconcileArcGISLayerAfterSync,
  withLocalFeatureIds,
} from "../apps/geolibre-desktop/src/lib/edit-sync/arcgis-edit-sync";
import {
  applyConflictResolutions,
  EditSyncOfflineError,
  EditSyncRejectedError,
  EditSyncWaitingError,
  syncOutboxEntry,
  type OutboxEntry,
} from "../apps/geolibre-desktop/src/lib/edit-sync/edit-outbox";

const INFO: ArcGISEditInfo = {
  objectIdField: "OBJECTID",
  globalIdField: "GlobalID",
  capabilities: "Create,Update,Delete,Query",
  geometryType: "esriGeometryPoint",
  fields: [
    { name: "OBJECTID", type: "esriFieldTypeOID", editable: false },
    { name: "GlobalID", type: "esriFieldTypeGlobalID", editable: false },
    { name: "name", type: "esriFieldTypeString", editable: true, nullable: true },
    { name: "status", type: "esriFieldTypeString", editable: true, nullable: true },
    { name: "last_edited_date", type: "esriFieldTypeDate", editable: false },
  ],
};

let clock = 1_000;

function row(oid: number, x: number, status: string, edited = clock): Feature {
  return {
    type: "Feature",
    id: `f${oid}`,
    geometry: { type: "Point", coordinates: [x, 1] },
    properties: {
      OBJECTID: oid,
      GlobalID: `{G-${oid}}`,
      name: `asset ${oid}`,
      status,
      last_edited_date: edited,
    },
  };
}

/**
 * A fake feature service: `/query` by objectIds or `OBJECTID > n`, and
 * `applyEdits` with per-feature results and editor tracking, like ArcGIS.
 */
class FakeService {
  rows = new Map<number, Feature>();
  nextOid = 500;
  edits: Array<{ adds?: unknown[]; updates?: unknown[]; deletes?: number[] }> = [];
  failQuery: Error | null = null;
  failApply: Error | null = null;
  loseResponse = false;
  refuse = new Set<number>();

  session(info: ArcGISEditInfo = INFO): ArcGISOutboxSession {
    return {
      layerUrl: "https://services.example.com/arcgis/rest/services/Assets/FeatureServer/0",
      info,
      query: async (params) => {
        if (this.failQuery) throw this.failQuery;
        if (params.objectIds) {
          const ids = params.objectIds.split(",").map(Number);
          return ids.flatMap((id) =>
            this.rows.has(id) ? [structuredClone(this.rows.get(id)!)] : [],
          );
        }
        const above = Number(/> (-?\d+)/.exec(params.where ?? "")?.[1] ?? -1);
        return [...this.rows.values()]
          .filter((f) => (f.properties!.OBJECTID as number) > above)
          .map((f) => structuredClone(f));
      },
      applyEdits: async (edits) => {
        this.edits.push(structuredClone(edits));
        if (this.failApply) throw this.failApply;
        clock += 1;
        const response: ArcGISApplyEditsResponse = {
          addResults: [],
          updateResults: [],
          deleteResults: [],
        };
        for (const add of (edits.adds ?? []) as Array<{
          attributes: Record<string, unknown>;
          geometry: { x: number; y: number };
        }>) {
          const oid = this.nextOid++;
          this.rows.set(oid, {
            type: "Feature",
            id: `f${oid}`,
            geometry: { type: "Point", coordinates: [add.geometry.x, add.geometry.y] },
            properties: {
              ...add.attributes,
              OBJECTID: oid,
              GlobalID: `{G-${oid}}`,
              last_edited_date: clock,
            },
          });
          response.addResults!.push({ success: true, objectId: oid });
        }
        for (const update of (edits.updates ?? []) as Array<{
          attributes: Record<string, unknown>;
          geometry?: { x: number; y: number };
        }>) {
          const oid = update.attributes.OBJECTID as number;
          if (this.refuse.has(oid)) {
            response.updateResults!.push({
              success: false,
              objectId: oid,
              error: { code: 1000, description: "Domain violation" },
            });
            continue;
          }
          const prior = this.rows.get(oid)!;
          this.rows.set(oid, {
            ...prior,
            geometry: update.geometry
              ? { type: "Point", coordinates: [update.geometry.x, update.geometry.y] }
              : prior.geometry,
            properties: { ...prior.properties, ...update.attributes, last_edited_date: clock },
          });
          response.updateResults!.push({ success: true, objectId: oid });
        }
        for (const oid of edits.deletes ?? []) {
          this.rows.delete(oid);
          response.deleteResults!.push({ success: true, objectId: oid });
        }
        if (this.loseResponse) {
          this.loseResponse = false;
          throw new TypeError("Failed to fetch");
        }
        return response;
      },
    };
  }
}

function loadLayer(service: FakeService): GeoLibreLayer {
  const features = [...service.rows.values()].map((f) => structuredClone(f));
  return {
    id: "assets",
    name: "Assets",
    type: "geojson",
    visible: true,
    opacity: 1,
    source: {
      type: "geojson",
      arcgisQueryUrl:
        "https://services.example.com/arcgis/rest/services/Assets/FeatureServer/0/query",
    },
    geojson: { type: "FeatureCollection", features },
    metadata: {
      sourceKind: "arcgis-feature",
      arcgisEditInfo: INFO,
      arcgisEditBaseline: { type: "FeatureCollection", features: structuredClone(features) },
    },
  } as unknown as GeoLibreLayer;
}

function edit(layer: GeoLibreLayer, mutate: (features: Feature[]) => Feature[]): GeoLibreLayer {
  const geojson = withLocalFeatureIds(
    { type: "FeatureCollection", features: mutate(structuredClone(layer.geojson!.features)) },
    "OBJECTID",
  );
  return { ...layer, geojson };
}

function entryFor(layer: GeoLibreLayer): OutboxEntry {
  const target = arcgisOutboxTarget(layer)!;
  return {
    id: arcgisOutboxId(target, layer.id),
    backend: "arcgis",
    target,
    targetLabel: layer.name,
    layerId: layer.id,
    layerName: layer.name,
    ops: buildArcGISChangeSet(layer, target)!,
    status: "pending",
    conflicts: [],
    attempts: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

function seed(): FakeService {
  const service = new FakeService();
  for (let oid = 1; oid <= 3; oid++) service.rows.set(oid, row(oid, oid, "ok"));
  return service;
}

describe("ArcGIS outbox target", () => {
  it("versions editable fields and geometry, ignoring service-maintained fields", () => {
    const service = seed();
    const target = arcgisOutboxTarget(loadLayer(service))!;
    assert.deepEqual(target.editableFields, ["name", "status"]);
    assert.equal(target.maxObjectId, 3);
    const fp = arcgisFingerprint(target);
    assert.equal(fp(row(1, 1, "ok", 1)), fp(row(1, 1, "ok", 99)), "editor tracking is ignored");
    assert.notEqual(fp(row(1, 1, "ok")), fp(row(1, 2, "ok")));
    // The service returns its own copy of my coordinates at its resolution.
    const sent = { ...row(1, 1.123456789123, "ok"), id: "f1" };
    const returned = { ...row(1, 1.1234568, "ok"), id: "f1" };
    assert.equal(fp(sent), fp(returned));
    const generalized = arcgisFingerprint({ ...target, ignoreGeometry: true });
    assert.equal(generalized(row(1, 1, "ok")), generalized(row(1, 2, "ok")));
    assert.equal(
      arcgisOutboxTarget({ ...loadLayer(service), metadata: {} } as unknown as GeoLibreLayer),
      null,
    );
  });

  it("gives a copied feature its own id and no object ID", () => {
    const original = row(1, 1, "ok");
    const out = withLocalFeatureIds(
      { type: "FeatureCollection", features: [original, { ...original }] },
      "OBJECTID",
    );
    assert.equal(out.features[0], original);
    assert.match(String(out.features[1].id), /^arcgis-new-/);
    assert.equal(out.features[1].properties!.OBJECTID, undefined);
  });

  it("gives only new features a stable local id", () => {
    const fc: FeatureCollection = {
      type: "FeatureCollection",
      features: [row(1, 1, "ok"), { type: "Feature", geometry: null as never, properties: {} }],
    };
    const out = withLocalFeatureIds(fc, "OBJECTID");
    assert.equal(out.features[0], fc.features[0]);
    assert.match(String(out.features[1].id), /^arcgis-new-/);
    assert.equal(withLocalFeatureIds(out, "OBJECTID"), out);
  });
});

describe("ArcGIS sync adapter", () => {
  it("applies updates, inserts, and deletes in one applyEdits call", async () => {
    const service = seed();
    const layer = edit(loadLayer(service), (features) => [
      { ...features[0], properties: { ...features[0].properties, status: "repaired" } },
      features[1],
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [9, 9] },
        properties: { name: "new asset", status: "new" },
      },
    ]);
    const entry = entryFor(layer);
    const outcome = await syncOutboxEntry(entry, createArcGISSyncAdapter(entry, service.session()));
    assert.equal(outcome.kind, "synced");
    assert.deepEqual([outcome.inserted, outcome.updated, outcome.deleted], [1, 1, 1]);
    assert.equal(service.edits.length, 1);
    const [sent] = service.edits;
    // Only the changed attribute of the update is sent, with its object ID.
    assert.deepEqual((sent.updates![0] as { attributes: unknown }).attributes, {
      status: "repaired",
      OBJECTID: 1,
    });
    assert.deepEqual(sent.deletes, [3]);
    assert.equal(service.rows.get(500)!.properties!.name, "new asset");
    assert.equal([...outcome.insertedKeys.values()][0], "500");
  });

  it("holds a feature someone else edited as a conflict, and keep mine overwrites it", async () => {
    const service = seed();
    const layer = edit(loadLayer(service), (features) =>
      features.map((f) => ({ ...f, properties: { ...f.properties, status: "mine" } })),
    );
    const entry = entryFor(layer);
    service.rows.set(2, row(2, 2, "theirs", 5_000));
    const adapter = createArcGISSyncAdapter(entry, service.session());
    const first = await syncOutboxEntry(entry, adapter);
    assert.equal(first.kind, "conflict");
    assert.equal(first.updated, 2);
    assert.equal(first.entry!.conflicts[0].key, "2");
    assert.equal(service.rows.get(2)!.properties!.status, "theirs");

    const resolved = applyConflictResolutions(
      first.entry!,
      new Map([[first.entry!.ops[0].id, "mine" as const]]),
    );
    const second = await syncOutboxEntry(resolved, adapter);
    assert.equal(second.kind, "synced", second.error ?? "");
    assert.equal(service.rows.get(2)!.properties!.status, "mine");
  });

  it("does not report its own landed save as a conflict on retry", async () => {
    const service = seed();
    const layer = edit(loadLayer(service), (features) => [
      { ...features[0], properties: { ...features[0].properties, status: "fixed" } },
      features[1],
      features[2],
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [7, 7] },
        properties: { name: "drawn offline", status: "new" },
      },
    ]);
    const entry = entryFor(layer);
    const adapter = createArcGISSyncAdapter(entry, service.session());
    service.loseResponse = true;
    const lost = await syncOutboxEntry(entry, adapter);
    assert.equal(lost.kind, "offline");
    assert.equal(service.rows.size, 4, "the write landed before the answer was lost");
    const retry = await syncOutboxEntry(lost.entry!, adapter);
    // Editor tracking moved last_edited_date, but that is not a conflict.
    assert.equal(retry.kind, "synced");
    assert.equal(retry.alreadyApplied, 2);
    assert.equal(service.rows.size, 4, "the insert must not land twice");
  });

  it("keeps a rejected feature queued with the service's message", async () => {
    const service = seed();
    service.refuse.add(1);
    const layer = edit(loadLayer(service), (features) =>
      features.map((f) => ({ ...f, properties: { ...f.properties, status: "x" } })),
    );
    const entry = entryFor(layer);
    const outcome = await syncOutboxEntry(entry, createArcGISSyncAdapter(entry, service.session()));
    assert.equal(outcome.kind, "error");
    assert.equal(outcome.updated, 2);
    assert.deepEqual(
      outcome.entry!.ops.map((op) => [op.key, op.error]),
      [["1", "Domain violation"]],
    );
  });

  it("maps failures: offline, refusals, invalid edits, and a closed layer", async () => {
    const service = seed();
    const layer = edit(loadLayer(service), (features) => [
      { ...features[0], properties: { ...features[0].properties, status: "y" } },
      features[1],
      features[2],
    ]);
    const entry = entryFor(layer);
    assert.throws(() => createArcGISSyncAdapter(entry, undefined), EditSyncWaitingError);

    service.failQuery = new TypeError("Failed to fetch");
    const offline = await syncOutboxEntry(entry, createArcGISSyncAdapter(entry, service.session()));
    assert.equal(offline.kind, "offline");

    service.failQuery = null;
    const rejecting = service.session();
    rejecting.applyEdits = async () => {
      const error = new Error("Token required");
      error.name = "ArcGISEditsRejectedError";
      throw error;
    };
    const refused = await syncOutboxEntry(entry, createArcGISSyncAdapter(entry, rejecting));
    assert.equal(refused.kind, "error");
    assert.match(refused.entry!.lastError!, /Token required/);

    const noUpdates = service.session({ ...INFO, capabilities: "Create,Query" });
    const invalid = await syncOutboxEntry(entry, createArcGISSyncAdapter(entry, noUpdates));
    assert.equal(invalid.kind, "error");

    assert.ok(readFailure(new Error("HTTP 503")) instanceof EditSyncOfflineError);
    assert.ok(readFailure(new Error("HTTP 403")) instanceof EditSyncRejectedError);
  });
});

describe("reconcileArcGISLayerAfterSync", () => {
  it("stamps assigned object IDs, takes server values, and re-bases synced features", async () => {
    const service = seed();
    const edited = edit(loadLayer(service), (features) => [
      { ...features[0], properties: { ...features[0].properties, status: "mine" } },
      { ...features[1], properties: { ...features[1].properties, status: "conflicted" } },
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [9, 9] },
        properties: { name: "new", status: "new" },
      },
    ]);
    const entry = entryFor(edited);
    service.rows.set(2, row(2, 2, "theirs", 9_000));
    const outcome = await syncOutboxEntry(entry, createArcGISSyncAdapter(entry, service.session()));
    let live = edited;
    const ok = await reconcileArcGISLayerAfterSync(entry, outcome, {
      getLayer: () => live,
      updateLayer: (_id, patch) => {
        live = { ...live, ...patch } as GeoLibreLayer;
      },
      session: service.session(),
    });
    assert.ok(ok);
    const byOid = new Map(live.geojson!.features.map((f) => [f.properties!.OBJECTID, f]));
    assert.equal(byOid.get(500)!.properties!.status, "new");
    assert.equal(
      byOid.get(2)!.properties!.status,
      "conflicted",
      "a queued conflict keeps my value",
    );
    assert.equal(
      byOid.get(1)!.properties!.last_edited_date,
      clock,
      "server-calculated values arrive",
    );
    const base = (live.metadata.arcgisEditBaseline as FeatureCollection).features;
    assert.deepEqual(base.map((f) => f.properties!.OBJECTID).sort(), [1, 2, 500]);
    assert.equal(
      base.find((f) => f.properties!.OBJECTID === 2)!.properties!.status,
      "ok",
      "the conflicted feature keeps its old base",
    );
    assert.equal(live.metadata.geometryEdited, true);
  });
});

describe("ArcGIS keep mine on a server delete", () => {
  it("re-creates the feature without the old row's service-maintained values", async () => {
    const service = seed();
    const layer = edit(loadLayer(service), (features) => [
      { ...features[0], properties: { ...features[0].properties, status: "keep me" } },
      features[1],
      features[2],
    ]);
    const entry = entryFor(layer);
    service.rows.delete(1);
    const adapter = createArcGISSyncAdapter(entry, service.session());
    const first = await syncOutboxEntry(entry, adapter);
    assert.equal(first.entry!.conflicts[0].reason, "remoteDeleted");
    const resolved = applyConflictResolutions(
      first.entry!,
      new Map([[first.entry!.ops[0].id, "mine" as const]]),
    );
    const second = await syncOutboxEntry(resolved, adapter);
    assert.equal(second.kind, "synced", second.error ?? "");
    const added = (service.edits.at(-1)!.adds![0] as { attributes: Record<string, unknown> })
      .attributes;
    assert.equal(added.status, "keep me");
    assert.equal(added.OBJECTID, undefined);
    assert.equal(added.last_edited_date, undefined);
  });
});

describe("ArcGIS sync guards", () => {
  it("refuses a session for another service and treats incomplete results as unknown", async () => {
    const service = seed();
    const layer = edit(loadLayer(service), (features) => [
      features[0],
      features[1],
      features[2],
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [8, 8] },
        properties: { name: "n", status: "new" },
      },
    ]);
    const entry = entryFor(layer);
    const other = { ...service.session(), layerUrl: "https://other.example.com/FeatureServer/0" };
    assert.throws(
      () => createArcGISSyncAdapter(entry, other),
      (error: Error & { code?: string }) => error.code === "arcgisTargetMismatch",
    );
    const partial = service.session();
    partial.applyEdits = async () => ({ addResults: [], updateResults: [], deleteResults: [] });
    const outcome = await syncOutboxEntry(entry, createArcGISSyncAdapter(entry, partial));
    assert.equal(outcome.kind, "offline");
    assert.equal(outcome.entry!.ops.find((op) => op.kind === "insert")!.maybeApplied, true);
  });

  it("leaves the layer to a downloaded feature that lost its object ID", () => {
    const service = seed();
    const layer = edit(loadLayer(service), (features) => [
      { ...features[0], properties: { ...features[0].properties, OBJECTID: null } },
      features[1],
      features[2],
    ]);
    assert.equal(buildArcGISChangeSet(layer, arcgisOutboxTarget(layer)!), null);
  });

  it("keeps kept-theirs features when the follow-up read fails", async () => {
    const service = seed();
    const edited = edit(loadLayer(service), (features) => [
      { ...features[0], properties: { ...features[0].properties, status: "mine" } },
      features[1],
      features[2],
    ]);
    const entry = entryFor(edited);
    service.rows.set(1, row(1, 1, "theirs", 9_999));
    const adapter = createArcGISSyncAdapter(entry, service.session());
    const first = await syncOutboxEntry(entry, adapter);
    const resolved = applyConflictResolutions(
      first.entry!,
      new Map([[first.entry!.ops[0].id, "theirs" as const]]),
    );
    const second = await syncOutboxEntry(resolved, adapter);
    let live = edited;
    const failing = service.session();
    failing.query = async () => {
      throw new TypeError("Failed to fetch");
    };
    await reconcileArcGISLayerAfterSync(resolved, second, {
      getLayer: () => live,
      updateLayer: (_id, patch) => {
        live = { ...live, ...patch } as GeoLibreLayer;
      },
      session: failing,
    });
    assert.equal(live.geojson!.features.length, 3, "nothing is dropped on a failed read");
  });
});
