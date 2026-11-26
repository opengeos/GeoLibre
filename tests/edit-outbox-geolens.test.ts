import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeoLibreLayer } from "@geolibre/core";
import {
  captureFeatureBaseline,
  fetchDatasetFeature,
  type GeoLensFeatureBaseline,
  type GeoLensFetch,
} from "@geolibre/plugins/geolens-api";
import type { Feature, FeatureCollection } from "geojson";
import {
  applyConflictResolutions,
  EditSyncWaitingError,
  syncOutboxEntry,
  type OutboxEntry,
} from "../apps/geolibre-desktop/src/lib/edit-sync/edit-outbox";
import {
  buildGeoLensChangeSet,
  createGeoLensSyncAdapter,
  geolensOutboxId,
  geolensOutboxTarget,
  reconcileGeoLensLayerAfterSync,
  withGeoLensLocalIds,
} from "../apps/geolibre-desktop/src/lib/edit-sync/geolens-edit-sync";

const BASE = "https://geolens.example.com";
const DATASET = "ds-1";

function building(gid: number, height: number): Feature {
  return {
    type: "Feature",
    id: gid,
    geometry: { type: "Point", coordinates: [gid, 0] },
    properties: { id: null, height },
  };
}

/**
 * A fake GeoLens server: OGC items (paged list and single item, 404 when
 * missing) plus the per-feature POST/PUT/PATCH/DELETE editing endpoints.
 */
class FakeGeoLens {
  rows = new Map<number, Feature>();
  nextGid = 900;
  calls: string[] = [];
  offline = false;
  refuse = new Set<number>();
  /** Drop the answer of the next write after applying it. */
  loseNext = false;

  fetch: GeoLensFetch = async (url, init) => {
    if (this.offline) throw new TypeError("Failed to fetch");
    const method = init?.method ?? "GET";
    const path = new URL(url).pathname;
    this.calls.push(`${method} ${path}`);
    const json = (status: number, body: unknown) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    });
    let m = /\/api\/collections\/[^/]+\/items\/(\d+)$/.exec(path);
    if (m && method === "GET") {
      const row = this.rows.get(Number(m[1]));
      return row
        ? json(200, { ...structuredClone(row), links: [] })
        : json(404, { title: "Not Found" });
    }
    if (/\/items$/.test(path)) {
      return json(200, { type: "FeatureCollection", features: [...this.rows.values()], links: [] });
    }
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    let result;
    if (method === "POST") {
      const gid = this.nextGid++;
      this.rows.set(gid, {
        type: "Feature",
        id: gid,
        geometry: body.geometry,
        properties: body.properties,
      });
      result = json(201, { id: gid });
    } else {
      m = /\/features\/(\d+)$/.exec(path);
      const gid = Number(m![1]);
      if (this.refuse.has(gid)) return json(422, { detail: "height must be positive" });
      if (method === "DELETE") this.rows.delete(gid);
      else {
        const prior = this.rows.get(gid)!;
        this.rows.set(gid, {
          ...prior,
          geometry: body.geometry ?? prior.geometry,
          properties:
            method === "PUT" ? body.properties : { ...prior.properties, ...body.properties },
        });
      }
      result = json(200, {});
    }
    if (this.loseNext) {
      this.loseNext = false;
      throw new TypeError("network connection was lost");
    }
    return result;
  };

  connection(apiKey: string | null = "key") {
    return { client: { baseUrl: BASE, apiKey: apiKey ?? undefined }, fetchImpl: this.fetch };
  }
}

function seed(): {
  server: FakeGeoLens;
  loaded: FeatureCollection;
  baseline: GeoLensFeatureBaseline;
} {
  const server = new FakeGeoLens();
  for (let gid = 1; gid <= 3; gid++) server.rows.set(gid, building(gid, gid * 10));
  const loaded: FeatureCollection = {
    type: "FeatureCollection",
    features: [...server.rows.values()].map((f) => structuredClone(f)),
  };
  return { server, loaded, baseline: captureFeatureBaseline(loaded) };
}

function entryFor(features: Feature[], baseline: GeoLensFeatureBaseline): OutboxEntry {
  const target = geolensOutboxTarget(BASE, DATASET, baseline, 1000);
  const collection = withGeoLensLocalIds({ type: "FeatureCollection", features });
  return {
    id: geolensOutboxId(target),
    backend: "geolens",
    target,
    targetLabel: "Buildings",
    layerId: "geolens-layer",
    layerName: "Buildings",
    ops: buildGeoLensChangeSet(collection, baseline),
    status: "pending",
    conflicts: [],
    attempts: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("GeoLens change sets", () => {
  it("treats null and missing attributes alike, like the plugin's own diff", () => {
    const { loaded, baseline } = seed();
    // An editor round trip drops null keys; that is not an edit.
    const roundTripped = loaded.features.map((f) => ({
      ...f,
      properties: { height: f.properties!.height },
    }));
    assert.deepEqual(
      buildGeoLensChangeSet({ type: "FeatureCollection", features: roundTripped }, baseline),
      [],
    );
  });

  it("gives new features a local id that is not a gid", () => {
    const fc = withGeoLensLocalIds({
      type: "FeatureCollection",
      features: [building(1, 1), { type: "Feature", geometry: null as never, properties: {} }],
    });
    assert.equal(fc.features[0].id, 1);
    assert.match(String(fc.features[1].id), /^geolens-new-/);
    assert.equal(withGeoLensLocalIds(fc), fc);
  });
});

describe("GeoLens sync adapter", () => {
  it("writes updates, inserts, and deletes one request per feature", async () => {
    const { server, baseline } = seed();
    const entry = entryFor(
      [building(1, 99), building(2, 20), { ...building(0, 5), id: undefined }],
      baseline,
    );
    const outcome = await syncOutboxEntry(
      entry,
      createGeoLensSyncAdapter(entry, server.connection()),
    );
    assert.equal(outcome.kind, "synced");
    assert.deepEqual([outcome.inserted, outcome.updated, outcome.deleted], [1, 1, 1]);
    assert.equal(server.rows.get(1)!.properties!.height, 99);
    assert.equal(server.rows.has(3), false);
    assert.equal(server.rows.get(900)!.properties!.height, 5);
    assert.ok(server.calls.includes("PUT /api/datasets/ds-1/features/1"));
  });

  it("holds a feature edited on the server as a conflict and resolves keep theirs", async () => {
    const { server, baseline } = seed();
    const entry = entryFor([building(1, 11), building(2, 22), building(3, 30)], baseline);
    server.rows.set(1, building(1, 1234));
    const adapter = createGeoLensSyncAdapter(entry, server.connection());
    const first = await syncOutboxEntry(entry, adapter);
    assert.equal(first.kind, "conflict");
    assert.equal(server.rows.get(2)!.properties!.height, 22);
    assert.equal(first.entry!.conflicts[0].theirs!.properties!.height, 1234);
    const resolved = applyConflictResolutions(
      first.entry!,
      new Map([[first.entry!.ops[0].id, "theirs" as const]]),
    );
    const second = await syncOutboxEntry(resolved, adapter);
    assert.equal(second.kind, "synced");
    assert.deepEqual(second.theirsKeys, ["1"]);
    assert.equal(server.rows.get(1)!.properties!.height, 1234);
  });

  it("dedupes an insert whose answer was lost and keeps refused features queued", async () => {
    const { server, baseline } = seed();
    const entry = entryFor(
      [building(1, 10), building(2, 25), building(3, 30), { ...building(0, 7), id: undefined }],
      baseline,
    );
    const adapter = createGeoLensSyncAdapter(entry, server.connection());
    server.refuse.add(2);
    // Updates run first: feature 2 is refused, then the insert's answer is lost.
    const fetchImpl = server.fetch;
    server.fetch = async (url, init) => {
      if (init?.method === "POST") server.loseNext = true;
      return fetchImpl(url, init);
    };
    const lostAdapter = createGeoLensSyncAdapter(entry, server.connection());
    const lost = await syncOutboxEntry(entry, lostAdapter);
    assert.equal(lost.kind, "offline");
    assert.equal(server.rows.size, 4);
    server.fetch = fetchImpl;
    const retry = await syncOutboxEntry(lost.entry!, adapter);
    assert.equal(retry.kind, "error");
    assert.equal(retry.alreadyApplied, 1);
    assert.equal(server.rows.size, 4, "the insert must not land twice");
    assert.equal(retry.insertedKeys.size, 1, "the found row's gid is reported");
    assert.match(retry.entry!.ops[0].error!, /height must be positive/);
  });

  it("recognises a landed insert although GeoLens stores 6 decimals", async () => {
    const { server, baseline } = seed();
    const precise = {
      type: "Feature",
      geometry: { type: "Point", coordinates: [-115.2075791234, 36.1191264321] },
      properties: { id: null, height: 3 },
    } as Feature;
    const entry = entryFor([building(1, 10), building(2, 20), building(3, 30), precise], baseline);
    const fetchImpl = server.fetch;
    server.fetch = async (url, init) => {
      if (init?.method === "POST") {
        // Store the way GeoLens serves it, then lose the answer.
        const body = JSON.parse(String(init.body));
        body.geometry.coordinates = body.geometry.coordinates.map(
          (v: number) => Math.round(v * 1e6) / 1e6,
        );
        server.loseNext = true;
        return fetchImpl(url, { ...init, body: JSON.stringify(body) });
      }
      return fetchImpl(url, init);
    };
    const lost = await syncOutboxEntry(entry, createGeoLensSyncAdapter(entry, server.connection()));
    assert.equal(lost.kind, "offline");
    server.fetch = fetchImpl;
    const retry = await syncOutboxEntry(
      lost.entry!,
      createGeoLensSyncAdapter(entry, server.connection()),
    );
    assert.equal(retry.kind, "synced");
    assert.equal(server.rows.size, 4, "no second insert");
  });

  it("waits without a signed-in connection and queues while offline", async () => {
    const { server, baseline } = seed();
    const entry = entryFor([building(1, 15), building(2, 20), building(3, 30)], baseline);
    assert.throws(() => createGeoLensSyncAdapter(entry, undefined), EditSyncWaitingError);
    assert.throws(
      () => createGeoLensSyncAdapter(entry, server.connection(null)),
      EditSyncWaitingError,
    );
    server.offline = true;
    const outcome = await syncOutboxEntry(
      entry,
      createGeoLensSyncAdapter(entry, server.connection()),
    );
    assert.equal(outcome.kind, "offline");
  });

  it("reads one item and reports a missing one as null", async () => {
    const { server } = seed();
    const client = server.connection().client;
    assert.equal((await fetchDatasetFeature(client, DATASET, 2, server.fetch))!.id, 2);
    assert.equal(await fetchDatasetFeature(client, DATASET, 77, server.fetch), null);
  });
});

describe("reconcileGeoLensLayerAfterSync", () => {
  it("stamps gids, applies kept-theirs versions, and re-bases settled features", async () => {
    const { server, baseline } = seed();
    const drawn = { ...building(0, 7), id: undefined };
    const features = withGeoLensLocalIds({
      type: "FeatureCollection",
      features: [building(1, 11), building(2, 22), building(3, 30), drawn],
    }).features;
    const entry = entryFor(features, baseline);
    // entryFor re-stamps ids, so give the layer the ids the ops carry.
    const insertOp = entry.ops.find((op) => op.kind === "insert")!;
    features[3] = insertOp.feature!;
    server.rows.set(1, building(1, 500));
    const adapter = createGeoLensSyncAdapter(entry, server.connection());
    const first = await syncOutboxEntry(entry, adapter);
    const resolved = applyConflictResolutions(
      first.entry!,
      new Map([[first.entry!.ops[0].id, "theirs" as const]]),
    );
    const second = await syncOutboxEntry(resolved, adapter);
    let layer = {
      id: "geolens-layer",
      geojson: { type: "FeatureCollection", features },
      metadata: {},
    } as unknown as GeoLibreLayer;
    let base = baseline;
    // Reconcile the first pass (insert + update) then the keep-theirs pass.
    for (const [before, outcome] of [
      [entry, first],
      [resolved, second],
    ] as const) {
      await reconcileGeoLensLayerAfterSync(before, outcome, {
        getLayer: () => layer,
        updateLayer: (_id, patch) => {
          layer = { ...layer, ...patch } as GeoLibreLayer;
        },
        getBaseline: () => base,
        setBaseline: (_id, next) => {
          base = next;
        },
        connection: server.connection(),
      });
    }
    const heights = new Map(layer.geojson!.features.map((f) => [f.id, f.properties!.height]));
    assert.equal(heights.get(900), 7, "the drawn feature carries its new gid");
    assert.equal(heights.get(1), 500, "kept theirs shows the server version");
    assert.equal(base.get("2")!.properties.height, 22);
    assert.equal(base.get("1")!.properties.height, 500);
    assert.equal(base.get("900")!.properties.height, 7);
    assert.equal(buildGeoLensChangeSet(layer.geojson!, base).length, 0, "nothing left to save");
  });
});
