import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeoLibreLayer } from "@geolibre/core";
import {
  PostgisRequestError,
  PostgisWriteRejectedError,
  type ReadPostgisTableRequest,
  type ReadPostgisTableResult,
  type WritePostgisTableRequest,
  type WritePostgisTableResult,
} from "@geolibre/processing";
import type { Feature, FeatureCollection } from "geojson";
import {
  syncOutboxEntry,
  type OutboxEntry,
} from "../apps/geolibre-desktop/src/lib/edit-sync/edit-outbox";
import { canonicalJson } from "../apps/geolibre-desktop/src/lib/edit-sync/feature-fingerprint";
import {
  buildPostgisChangeSet,
  createPostgisSyncAdapter,
  EDIT_SYNC_BASELINE_KEY,
  hasPostgisSyncBaseline,
  overlayLocalOps,
  unsyncedLocalOps,
  postgisOutboxId,
  postgisOutboxTarget,
  postgisSyncBaseline,
  refreshPostgisLayerAfterSync,
} from "../apps/geolibre-desktop/src/lib/edit-sync/postgis-edit-sync";

function row(gid: number, x: number, name: string): Feature {
  return {
    type: "Feature",
    id: gid,
    geometry: { type: "Point", coordinates: [x, 1] },
    properties: { gid, name },
  };
}

/**
 * A fake sidecar over one PostGIS table: `/postgis/read` and `/postgis/write`
 * with the real endpoints' semantics (row hashes, 409 on a stale hash,
 * baseline-scoped deletes, keyless inserts taking the next serial value).
 */
class FakeSidecar {
  rows = new Map<number, Feature>();
  nextGid = 1000;
  writes: WritePostgisTableRequest[] = [];
  readError: Error | null = null;
  writeError: Error | null = null;
  /** Runs after the write commits, before its answer: simulates a lost response. */
  loseWriteResponse = false;

  hash(feature: Feature): string {
    return (
      canonicalJson({ g: feature.geometry, p: feature.properties }).length.toString(36) +
      canonicalJson(feature)
        .replace(/[^a-z0-9]/gi, "")
        .slice(-12)
    );
  }

  reads: ReadPostgisTableRequest[] = [];

  read = async (request: ReadPostgisTableRequest): Promise<ReadPostgisTableResult> => {
    this.reads.push(request);
    if (this.readError) throw this.readError;
    const features = [...this.rows.values()].map((f) => structuredClone(f));
    const row_hashes: Record<string, string> = {};
    for (const f of features) row_hashes[String(f.id)] = this.hash(f);
    return {
      geojson: { type: "FeatureCollection", features },
      schema: "public",
      table: "parcels",
      geometry_column: "geom",
      srid: 4326,
      primary_key: "gid",
      feature_count: features.length,
      row_hashes,
    };
  };

  write = async (request: WritePostgisTableRequest): Promise<WritePostgisTableResult> => {
    this.writes.push(structuredClone(request));
    if (this.writeError) throw this.writeError;
    assert.ok(Array.isArray(request.baseline_keys), "baseline_keys must always be sent");
    for (const [key, hash] of Object.entries(request.expected_row_hashes ?? {})) {
      const current = this.rows.get(Number(key));
      if (!current || this.hash(current) !== hash) {
        throw new PostgisWriteRejectedError("Concurrent modification detected", 409);
      }
    }
    let inserted = 0;
    let updated = 0;
    // PostGIS serves coordinates with 9 decimals (ST_AsGeoJSON's default).
    const stored = (feature: Feature): Feature => {
      const round = (v: unknown): unknown =>
        typeof v === "number" ? Math.round(v * 1e9) / 1e9 : Array.isArray(v) ? v.map(round) : v;
      const geometry = feature.geometry as { type: string; coordinates: unknown };
      return {
        ...structuredClone(feature),
        geometry: { ...geometry, coordinates: round(geometry.coordinates) } as Feature["geometry"],
      };
    };
    for (const raw of request.geojson.features) {
      const feature = stored(raw);
      const key = feature.properties?.gid ?? feature.id;
      if (typeof key === "number" && this.rows.has(key)) {
        this.rows.set(key, { ...structuredClone(feature), id: key });
        updated += 1;
      } else {
        const gid = typeof key === "number" ? key : this.nextGid++;
        this.rows.set(gid, {
          ...structuredClone(feature),
          id: gid,
          properties: { ...feature.properties, gid },
        });
        inserted += 1;
      }
    }
    let deleted = 0;
    for (const key of request.baseline_keys ?? []) {
      // Strict like the sidecar: a stringified integer key matches nothing.
      if (typeof key === "number" && this.rows.delete(key)) deleted += 1;
    }
    if (this.loseWriteResponse) {
      this.loseWriteResponse = false;
      throw new TypeError("Failed to fetch");
    }
    return {
      schema: "public",
      table: "parcels",
      feature_count: this.rows.size,
      inserted,
      updated,
      deleted,
      messages: [],
      skipped_fields: [],
    };
  };
}

function loadLayer(sidecar: FakeSidecar): GeoLibreLayer {
  const geojson: FeatureCollection = {
    type: "FeatureCollection",
    features: [...sidecar.rows.values()].map((f) => structuredClone(f)),
  };
  return {
    id: "layer-parcels",
    name: "Parcels",
    type: "geojson",
    visible: true,
    opacity: 1,
    source: { type: "geojson" },
    geojson,
    metadata: {
      sourceKind: "postgis-table",
      postgisSchema: "public",
      postgisTable: "parcels",
      postgisPrimaryKey: "gid",
      postgisGeometryColumn: "geom",
      postgisConnectionLabel: "postgresql://alice:***@db/gis",
      postgisBaselineKeys: geojson.features.map((f) => f.id),
      [EDIT_SYNC_BASELINE_KEY]: postgisSyncBaseline(geojson),
    },
  } as unknown as GeoLibreLayer;
}

function entryFor(layer: GeoLibreLayer, features: Feature[]): OutboxEntry {
  const target = postgisOutboxTarget(layer)!;
  const ops = buildPostgisChangeSet(layer, { type: "FeatureCollection", features })!;
  return {
    id: postgisOutboxId(target),
    backend: "postgis",
    target,
    targetLabel: "public.parcels",
    layerId: layer.id,
    layerName: layer.name,
    ops,
    status: "pending",
    conflicts: [],
    attempts: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

function adapterFor(sidecar: FakeSidecar, entry: OutboxEntry) {
  return createPostgisSyncAdapter(entry, {
    read: sidecar.read,
    write: sidecar.write,
    resolveConnection: () => "postgresql://alice:secret@db/gis",
  });
}

describe("PostGIS outbox target", () => {
  it("describes the table without credentials and keys one entry per table", () => {
    const sidecar = new FakeSidecar();
    sidecar.rows.set(1, row(1, 0, "a"));
    const layer = loadLayer(sidecar);
    const target = postgisOutboxTarget(layer)!;
    assert.equal(target.table, "parcels");
    assert.equal(target.primaryKey, "gid");
    assert.ok(!JSON.stringify(target).includes("secret"));
    assert.ok(hasPostgisSyncBaseline(layer));
    assert.equal(postgisOutboxId(target), postgisOutboxId(postgisOutboxTarget(layer)!));
    const legacy = {
      ...layer,
      metadata: { ...layer.metadata, [EDIT_SYNC_BASELINE_KEY]: undefined },
    };
    assert.equal(hasPostgisSyncBaseline(legacy as GeoLibreLayer), false);
    assert.equal(buildPostgisChangeSet(legacy as GeoLibreLayer, layer.geojson!), null);
  });
});

describe("PostGIS sync adapter", () => {
  it("sends only changed rows, scoped deletes, and the read's row hashes", async () => {
    const sidecar = new FakeSidecar();
    for (let gid = 1; gid <= 4; gid++) sidecar.rows.set(gid, row(gid, gid, `p${gid}`));
    const layer = loadLayer(sidecar);
    const edited = [
      row(1, 1, "p1"),
      row(2, 2, "renamed"),
      row(3, 3, "p3"),
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [9, 9] },
        properties: { name: "new" },
      },
    ] as Feature[];
    const entry = entryFor(layer, edited);
    const outcome = await syncOutboxEntry(entry, adapterFor(sidecar, entry));
    assert.equal(outcome.kind, "synced");
    assert.equal(sidecar.writes.length, 1);
    const [write] = sidecar.writes;
    assert.equal(write.geojson.features.length, 2);
    assert.deepEqual(write.baseline_keys, [4]);
    assert.deepEqual(Object.keys(write.expected_row_hashes!).sort(), ["2", "4"]);
    assert.deepEqual(
      [...sidecar.rows.keys()].sort((a, b) => a - b),
      [1, 2, 3, 1000],
    );
    assert.equal(sidecar.rows.get(2)!.properties!.name, "renamed");
  });

  it("detects a row another session edited and leaves it for review", async () => {
    const sidecar = new FakeSidecar();
    sidecar.rows.set(1, row(1, 1, "a"));
    sidecar.rows.set(2, row(2, 2, "b"));
    const layer = loadLayer(sidecar);
    const entry = entryFor(layer, [row(1, 1, "mine"), row(2, 2, "also mine")]);
    sidecar.rows.set(1, row(1, 1, "theirs"));
    const outcome = await syncOutboxEntry(entry, adapterFor(sidecar, entry));
    assert.equal(outcome.kind, "conflict");
    assert.equal(sidecar.rows.get(1)!.properties!.name, "theirs");
    assert.equal(sidecar.rows.get(2)!.properties!.name, "also mine");
    assert.equal(outcome.entry!.conflicts[0].key, "1");
  });

  it("retries the read when a row changes between the read and the write", async () => {
    const sidecar = new FakeSidecar();
    sidecar.rows.set(1, row(1, 1, "a"));
    const layer = loadLayer(sidecar);
    const entry = entryFor(layer, [row(1, 1, "mine")]);
    const write = sidecar.write;
    let raced = false;
    // Another session edits the row after our read, just before our write.
    sidecar.write = async (request) => {
      if (!raced) {
        raced = true;
        sidecar.rows.set(1, row(1, 1, "sneaky"));
      }
      return write(request);
    };
    const racing = adapterFor(sidecar, entry);
    const outcome = await syncOutboxEntry(entry, racing);
    assert.equal(outcome.kind, "conflict");
    assert.equal(sidecar.rows.get(1)!.properties!.name, "sneaky");
  });

  it("queues on an unreachable database and dedupes an insert whose answer was lost", async () => {
    const sidecar = new FakeSidecar();
    sidecar.rows.set(1, row(1, 1, "a"));
    const layer = loadLayer(sidecar);
    const newFeature = {
      type: "Feature",
      geometry: { type: "Point", coordinates: [5, 5] },
      properties: { name: "field note" },
    } as Feature;
    const entry = entryFor(layer, [row(1, 1, "a"), newFeature]);
    const adapter = adapterFor(sidecar, entry);

    sidecar.readError = new PostgisRequestError("Could not connect to PostgreSQL", 503);
    const offline = await syncOutboxEntry(entry, adapter);
    assert.equal(offline.kind, "offline");
    assert.equal(sidecar.writes.length, 0);

    sidecar.readError = null;
    sidecar.loseWriteResponse = true;
    const lost = await syncOutboxEntry(offline.entry!, adapter);
    assert.equal(lost.kind, "offline");
    assert.equal(lost.entry!.ops[0].maybeApplied, true);
    assert.equal(sidecar.rows.size, 2);

    const retry = await syncOutboxEntry(lost.entry!, adapter);
    assert.equal(retry.kind, "synced");
    assert.equal(retry.alreadyApplied, 1);
    assert.equal(sidecar.rows.size, 2, "the insert must not land twice");
  });

  it("matches a landed edit despite PostGIS rounding coordinates to 9 decimals", async () => {
    const sidecar = new FakeSidecar();
    sidecar.rows.set(1, row(1, 1, "a"));
    const layer = loadLayer(sidecar);
    const drawn = {
      type: "Feature",
      geometry: { type: "Point", coordinates: [-83.912345678912, 35.955555555555] },
      properties: { name: "precise" },
    } as Feature;
    const moved = {
      ...row(1, 1, "a"),
      geometry: { type: "Point", coordinates: [1.123456789123, 1] },
    } as Feature;
    const entry = entryFor(layer, [moved, drawn]);
    const adapter = adapterFor(sidecar, entry);
    sidecar.loseWriteResponse = true;
    const lost = await syncOutboxEntry(entry, adapter);
    assert.equal(lost.kind, "offline");
    const retry = await syncOutboxEntry(lost.entry!, adapter);
    // Neither a false conflict on the moved row nor a second insert.
    assert.equal(retry.kind, "synced");
    assert.equal(retry.alreadyApplied, 2);
    assert.equal(sidecar.rows.size, 2);
  });

  it("never treats a drawn feature's editor id as a table key", () => {
    const sidecar = new FakeSidecar();
    sidecar.rows.set(5, row(5, 5, "five"));
    const layer = loadLayer(sidecar);
    const drawn = {
      type: "Feature",
      id: 5,
      geometry: { type: "Point", coordinates: [9, 9] },
      properties: { name: "drawn" },
    } as Feature;
    const ops = buildPostgisChangeSet(layer, {
      type: "FeatureCollection",
      features: [row(5, 5, "five"), drawn],
    })!;
    assert.deepEqual(
      ops.map((op) => [op.kind, op.key]),
      [["insert", null]],
    );
    assert.equal(ops[0].feature!.id, undefined, "the editor id is not sent as a key");
  });

  it("maps refusals to errors and a 503 write to a retry", async () => {
    const sidecar = new FakeSidecar();
    sidecar.rows.set(1, row(1, 1, "a"));
    const layer = loadLayer(sidecar);
    const entry = entryFor(layer, [row(1, 1, "b")]);
    const adapter = adapterFor(sidecar, entry);
    sidecar.writeError = new PostgisWriteRejectedError("permission denied for table", 400);
    const refused = await syncOutboxEntry(entry, adapter);
    assert.equal(refused.kind, "error");
    assert.match(refused.entry!.lastError!, /permission denied/);

    sidecar.writeError = new PostgisWriteRejectedError("Could not connect", 503);
    const down = await syncOutboxEntry(entry, adapter);
    assert.equal(down.kind, "offline");
    assert.equal(down.entry!.ops[0].maybeApplied, undefined);

    sidecar.writeError = new PostgisWriteRejectedError("Bad Gateway", 502);
    const gateway = await syncOutboxEntry(entry, adapter);
    assert.equal(gateway.kind, "offline");
    assert.equal(gateway.entry!.status, "pending");
    sidecar.writeError = null;

    sidecar.readError = new PostgisRequestError("Bad Gateway", 502);
    assert.equal((await syncOutboxEntry(entry, adapter)).kind, "offline");

    sidecar.readError = new PostgisRequestError("relation does not exist", 404);
    const missing = await syncOutboxEntry(entry, adapter);
    assert.equal(missing.kind, "error");
  });

  it("reads every column, so an excluded field cannot fake a conflict", async () => {
    const sidecar = new FakeSidecar();
    sidecar.rows.set(1, row(1, 1, "a"));
    const layer = {
      ...loadLayer(sidecar),
      fieldVisibility: { name: "excluded" as const },
    } as GeoLibreLayer;
    const entry = entryFor(layer, [row(1, 2, "a")]);
    const outcome = await syncOutboxEntry(entry, adapterFor(sidecar, entry));
    assert.equal(outcome.kind, "synced");
    assert.ok(sidecar.reads.every((read) => read.excluded_fields === undefined));
  });

  it("refuses to build without a connection", () => {
    const sidecar = new FakeSidecar();
    const layer = loadLayer(sidecar);
    const entry = entryFor(layer, []);
    assert.throws(
      () => createPostgisSyncAdapter(entry, { resolveConnection: () => null }),
      (error: Error & { code?: string }) => error.code === "postgisNoConnection",
    );
  });
});

describe("refreshPostgisLayerAfterSync", () => {
  it("reloads the open layer, re-bases it, and keeps unsynced edits visible", async () => {
    const sidecar = new FakeSidecar();
    sidecar.rows.set(1, row(1, 1, "a"));
    sidecar.rows.set(2, row(2, 2, "b"));
    const layer = loadLayer(sidecar);
    const entry = entryFor(layer, [row(1, 1, "mine"), row(2, 2, "b2")]);
    sidecar.rows.set(1, row(1, 1, "theirs"));
    const outcome = await syncOutboxEntry(entry, adapterFor(sidecar, entry));
    // While the sync ran, the user edited feature 2 again and drew a feature.
    const live = {
      ...layer,
      geojson: {
        type: "FeatureCollection" as const,
        features: [
          row(1, 1, "mine"),
          row(2, 2, "b3"),
          {
            type: "Feature" as const,
            geometry: { type: "Point" as const, coordinates: [7, 7] },
            properties: { name: "drawn" },
          },
        ],
      },
    } as GeoLibreLayer;
    let patched: Partial<GeoLibreLayer> | null = null;
    const refreshed = await refreshPostgisLayerAfterSync(entry, outcome, {
      read: sidecar.read,
      getLayer: () => live,
      updateLayer: (_id, patch) => {
        patched = patch;
      },
      resolveConnection: () => "x",
    });
    assert.ok(refreshed);
    const next = patched as unknown as Partial<GeoLibreLayer>;
    const names = next.geojson!.features.map((f) => f.properties!.name).sort();
    // Feature 1 waits on a conflict, so my version stays on screen; the edits
    // made during the sync survive the refresh.
    assert.deepEqual(names, ["b3", "drawn", "mine"]);
    assert.equal(next.metadata!.geometryEdited, true);
    const baseline = next.metadata![EDIT_SYNC_BASELINE_KEY] as Record<string, string>;
    assert.deepEqual(Object.keys(baseline).sort(), ["1", "2"]);
  });

  it("does nothing when the layer now points elsewhere", async () => {
    const sidecar = new FakeSidecar();
    const layer = loadLayer(sidecar);
    const entry = entryFor(layer, []);
    const moved = { ...layer, metadata: { ...layer.metadata, postgisTable: "other" } };
    const refreshed = await refreshPostgisLayerAfterSync(
      entry,
      { kind: "synced", entry: null } as never,
      { getLayer: () => moved as GeoLibreLayer, read: sidecar.read, resolveConnection: () => "x" },
    );
    assert.equal(refreshed, false);
  });
});

describe("overlayLocalOps", () => {
  it("applies kept edits over a fresh read", () => {
    const fresh: FeatureCollection = {
      type: "FeatureCollection",
      features: [row(1, 1, "a"), row(2, 2, "b")],
    };
    const keyOf = (f: Feature) => String(f.id);
    const out = overlayLocalOps(
      fresh,
      [
        { id: "u", kind: "update", key: "1", feature: row(1, 1, "mine") },
        { id: "d", kind: "delete", key: "2" },
        { id: "i", kind: "insert", key: null, feature: row(9, 9, "n") },
      ],
      keyOf,
    );
    assert.deepEqual(
      out.features.map((f) => f.properties!.name),
      ["mine", "n"],
    );
    assert.equal(overlayLocalOps(fresh, [], keyOf), fresh);
  });

  it("keeps only the local edits a sync did not settle", () => {
    const settled = [
      { id: "a", kind: "update" as const, key: "1", mineFingerprint: "m1" },
      { id: "b", kind: "insert" as const, key: null, mineFingerprint: "new" },
      { id: "c", kind: "delete" as const, key: "3" },
    ];
    const local = [
      { id: "x", kind: "update" as const, key: "1", mineFingerprint: "m1" }, // synced
      { id: "y", kind: "update" as const, key: "2", mineFingerprint: "m2" }, // edited since
      { id: "z", kind: "insert" as const, key: null, mineFingerprint: "new" }, // synced
      { id: "w", kind: "insert" as const, key: null, mineFingerprint: "new" }, // a second copy
      { id: "v", kind: "delete" as const, key: "3" }, // synced
    ];
    assert.deepEqual(
      unsyncedLocalOps(local, settled).map((op) => op.id),
      ["y", "w"],
    );
  });
});
