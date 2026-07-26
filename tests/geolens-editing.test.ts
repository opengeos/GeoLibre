import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { useAppStore } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import {
  normalizeBaseUrl,
  type GeoLensFetch,
  type GeoLensHttpResponse,
} from "../packages/plugins/src/plugins/geolens-api";
import {
  clearEditSessions,
  GEOLENS_FEATURES_SOURCE_KIND,
  GEOLENS_SAMPLE_SERVERS,
  pendingCountsFor,
  refreshLayerToExtent,
  saveLayerEdits,
  type GeoLensEditableLayer,
} from "../packages/plugins/src/plugins/maplibre-geolens";

/**
 * The save path end to end against a scripted server: the baseline is read back
 * from GeoLens (the restored-project case), the diff is written one feature at a
 * time, assigned row ids land on the store layer, and a write that fails stays
 * pending instead of being quietly absorbed into the new baseline.
 */

const CLIENT = { baseUrl: "https://demo.example.com", apiKey: "k" };
const DATASET = "ds-1";

function point(x: number, y: number) {
  return { type: "Point" as const, coordinates: [x, y] };
}

/** The dataset as GeoLens holds it: two features, gids 1 and 2. */
function serverItems(): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      { type: "Feature", id: 1, geometry: point(0, 0), properties: { name: "a" } },
      { type: "Feature", id: 2, geometry: point(1, 1), properties: { name: "b" } },
    ],
  } as FeatureCollection;
}

/**
 * A transport that serves the items request from `serverItems` and answers each
 * subsequent write from `writes`, recording the method/url of every call.
 */
function stubServer(writes: Array<{ ok?: boolean; status?: number; body?: unknown }>) {
  const calls: Array<{ url: string; method: string }> = [];
  let writeIndex = 0;
  const fetchImpl: GeoLensFetch = (url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (method === "GET") {
      const res: GeoLensHttpResponse = { ok: true, status: 200, json: async () => serverItems() };
      return Promise.resolve(res);
    }
    const scripted = writes[writeIndex++] ?? {};
    return Promise.resolve({
      ok: scripted.ok ?? true,
      status: scripted.status ?? 200,
      json: async () => scripted.body ?? {},
    });
  };
  return { fetchImpl, calls };
}

/** Put an edited copy of the dataset in the store, as the panel would see it. */
function addEditedLayer(features: FeatureCollection["features"]): GeoLensEditableLayer {
  const store = useAppStore.getState();
  const id = store.addGeoJsonLayer(
    "Meteorites",
    { type: "FeatureCollection", features } as FeatureCollection,
    `geolens:${CLIENT.baseUrl}/${DATASET}#items`,
  );
  const layer = useAppStore.getState().layers.find((l) => l.id === id);
  assert.ok(layer);
  useAppStore.getState().updateLayer(id, {
    metadata: {
      ...layer.metadata,
      sourceKind: GEOLENS_FEATURES_SOURCE_KIND,
      geolensBaseUrl: CLIENT.baseUrl,
      geolensDatasetId: DATASET,
    },
  });
  const stored = useAppStore.getState().layers.find((l) => l.id === id);
  assert.ok(stored?.geojson);
  return {
    id,
    name: stored.name,
    datasetId: DATASET,
    baseUrl: CLIENT.baseUrl,
    geojson: stored.geojson,
  };
}

function layerGeojson(layerId: string): FeatureCollection {
  const layer = useAppStore.getState().layers.find((l) => l.id === layerId);
  assert.ok(layer?.geojson);
  return layer.geojson;
}

beforeEach(() => {
  clearEditSessions();
  for (const layer of [...useAppStore.getState().layers]) {
    useAppStore.getState().removeLayer(layer.id);
  }
});

describe("saveLayerEdits", () => {
  it("reads the baseline back from the server when there is no session", async () => {
    const layer = addEditedLayer(serverItems().features);
    const { fetchImpl, calls } = stubServer([]);

    const outcome = await saveLayerEdits(CLIENT, layer, 10_000, fetchImpl, () => {});

    assert.deepEqual(outcome, { written: 0, errors: [] });
    // One items read to establish the baseline, and no writes: the layer matches.
    assert.deepEqual(
      calls.map((c) => c.method),
      ["GET"],
    );
    assert.match(calls[0].url, /\/api\/collections\/ds-1\/items/);
  });

  it("writes a move, an insert and a delete, then stamps the new row id back", async () => {
    const layer = addEditedLayer([
      // gid 1 moved.
      { type: "Feature", id: 1, geometry: point(5, 5), properties: { name: "a" } },
      // gid 2 is gone (deleted), and a feature was drawn (no id).
      { type: "Feature", geometry: point(9, 9), properties: { name: "drawn" } },
    ]);
    const { fetchImpl, calls } = stubServer([
      {},
      { status: 201, body: { id: 77 } },
      { status: 204 },
    ]);

    const outcome = await saveLayerEdits(CLIENT, layer, 10_000, fetchImpl, () => {});

    assert.deepEqual(outcome.errors, []);
    assert.equal(outcome.written, 3);
    assert.deepEqual(
      calls.map((c) => c.method),
      ["GET", "PATCH", "POST", "DELETE"],
    );
    // The drawn feature now carries the gid GeoLens assigned, so saving again
    // updates that row instead of inserting a second copy.
    assert.equal(layerGeojson(layer.id).features[1].id, 77);

    const after = useAppStore.getState().layers.find((l) => l.id === layer.id);
    assert.ok(after?.geojson);
    assert.deepEqual(pendingCountsFor({ ...layer, geojson: after.geojson }), {
      added: 0,
      changed: 0,
      deleted: 0,
    });
  });

  it("leaves a rejected change pending and keeps the rest", async () => {
    const layer = addEditedLayer([
      { type: "Feature", id: 1, geometry: point(5, 5), properties: { name: "a" } },
      { type: "Feature", id: 2, geometry: point(7, 7), properties: { name: "b" } },
    ]);
    // gid 1 is refused; gid 2 succeeds.
    const { fetchImpl } = stubServer([
      { ok: false, status: 422, body: { detail: "bad geometry" } },
      {},
    ]);

    const outcome = await saveLayerEdits(CLIENT, layer, 10_000, fetchImpl, () => {});

    assert.equal(outcome.written, 1);
    assert.equal(outcome.errors.length, 1);
    assert.match(outcome.errors[0], /bad geometry/);

    // The failed feature still reads as changed, so the user can retry it; the
    // one that landed does not.
    const after = useAppStore.getState().layers.find((l) => l.id === layer.id);
    assert.ok(after?.geojson);
    assert.deepEqual(pendingCountsFor({ ...layer, geojson: after.geojson }), {
      added: 0,
      changed: 1,
      deleted: 0,
    });
  });

  it("leaves a rejected delete pending", async () => {
    const layer = addEditedLayer([
      { type: "Feature", id: 1, geometry: point(0, 0), properties: { name: "a" } },
    ]);
    const { fetchImpl } = stubServer([{ ok: false, status: 409, body: { detail: "referenced" } }]);

    const outcome = await saveLayerEdits(CLIENT, layer, 10_000, fetchImpl, () => {});

    assert.equal(outcome.written, 0);
    assert.equal(outcome.errors.length, 1);
    const after = useAppStore.getState().layers.find((l) => l.id === layer.id);
    assert.ok(after?.geojson);
    assert.deepEqual(pendingCountsFor({ ...layer, geojson: after.geojson }), {
      added: 0,
      changed: 0,
      deleted: 1,
    });
  });

  it("does not re-send a change that was already saved", async () => {
    const layer = addEditedLayer([
      { type: "Feature", id: 1, geometry: point(5, 5), properties: { name: "a" } },
      { type: "Feature", id: 2, geometry: point(1, 1), properties: { name: "b" } },
    ]);
    const { fetchImpl, calls } = stubServer([{}]);

    await saveLayerEdits(CLIENT, layer, 10_000, fetchImpl, () => {});
    const after = useAppStore.getState().layers.find((l) => l.id === layer.id);
    assert.ok(after?.geojson);
    const second = await saveLayerEdits(
      CLIENT,
      { ...layer, geojson: after.geojson },
      10_000,
      fetchImpl,
      () => {},
    );

    assert.deepEqual(second, { written: 0, errors: [] });
    // Only the first save's baseline read and its single PATCH.
    assert.deepEqual(
      calls.map((c) => c.method),
      ["GET", "PATCH"],
    );
  });
});

describe("GEOLENS_SAMPLE_SERVERS", () => {
  it("offers both public deployments as ready-to-use https URLs", () => {
    assert.deepEqual(
      GEOLENS_SAMPLE_SERVERS.map((s) => s.baseUrl),
      ["https://datasets.geolibre.app", "https://demo.getgeolens.com"],
    );
  });

  it("lists each server once, labelled, and already normalized", () => {
    // normalizeBaseUrl runs on whatever reaches the URL field, so a sample that
    // is not already in canonical form would connect to a different string than
    // the one shown — and a trailing slash would double up in every path join.
    const seen = new Set<string>();
    for (const server of GEOLENS_SAMPLE_SERVERS) {
      assert.ok(server.label.trim().length > 0, "sample server needs a label");
      assert.equal(server.baseUrl, normalizeBaseUrl(server.baseUrl));
      assert.equal(seen.has(server.baseUrl), false, `duplicate ${server.baseUrl}`);
      seen.add(server.baseUrl);
    }
  });
});

describe("saveLayerEdits — edits made while the save is in flight", () => {
  it("leaves a mid-save edit pending instead of baselining it as saved", async () => {
    const layer = addEditedLayer([
      { type: "Feature", id: 1, geometry: point(5, 5), properties: { name: "a" } },
      { type: "Feature", id: 2, geometry: point(1, 1), properties: { name: "b" } },
    ]);

    // While the PATCH for feature 1 is in flight, the user moves feature 2. That
    // edit was never part of the plan, so it must still be pending afterwards.
    let edited = false;
    const fetchImpl: GeoLensFetch = (url, init) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return Promise.resolve({ ok: true, status: 200, json: async () => serverItems() });
      }
      if (!edited) {
        edited = true;
        const current = useAppStore.getState().layers.find((l) => l.id === layer.id);
        assert.ok(current?.geojson);
        useAppStore.getState().updateLayer(layer.id, {
          geojson: {
            ...current.geojson,
            features: [
              current.geojson.features[0],
              { ...current.geojson.features[1], geometry: point(8, 8) },
            ],
          } as FeatureCollection,
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    };

    const outcome = await saveLayerEdits(CLIENT, layer, 10_000, fetchImpl, () => {});
    assert.equal(outcome.written, 1);

    const after = useAppStore.getState().layers.find((l) => l.id === layer.id);
    assert.ok(after?.geojson);
    assert.deepEqual(pendingCountsFor({ ...layer, geojson: after.geojson }), {
      added: 0,
      changed: 1,
      deleted: 0,
    });
  });
});

describe("saveLayerEdits — a view-filtered layer", () => {
  /**
   * The dangerous case: the layer holds only the features inside the view it was
   * loaded from. If the baseline were rebuilt over the whole dataset, every
   * feature outside that view would diff as a deletion and the save would delete
   * it from the server. The load terms are recorded on the layer for this reason.
   */
  it("rebuilds the baseline over the same extent, so out-of-view features are not deleted", async () => {
    const layer = addEditedLayer([
      { type: "Feature", id: 2, geometry: point(1, 1), properties: { name: "b" } },
    ]);
    // Loaded from a view that only contained feature 2.
    const viewLayer = { ...layer, featureLimit: 5_000, bbox: [0.5, 0.5, 1.5, 1.5] as const };
    useAppStore.getState().updateLayer(layer.id, {
      metadata: {
        ...(useAppStore.getState().layers.find((l) => l.id === layer.id)?.metadata ?? {}),
        geolensFeatureLimit: 5_000,
        geolensBbox: [0.5, 0.5, 1.5, 1.5],
      },
    });

    const calls: Array<{ url: string; method: string }> = [];
    const fetchImpl: GeoLensFetch = (url, init) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (method === "GET") {
        // The server answers the bbox query with only that feature.
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            type: "FeatureCollection",
            features: [
              { type: "Feature", id: 2, geometry: point(1, 1), properties: { name: "b" } },
            ],
          }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    };

    const outcome = await saveLayerEdits(CLIENT, viewLayer, 10_000, fetchImpl, () => {});

    assert.deepEqual(outcome, { written: 0, errors: [] });
    // The baseline read carried the recorded extent and limit…
    assert.match(calls[0].url, /bbox=0\.5%2C0\.5%2C1\.5%2C1\.5/);
    assert.match(calls[0].url, /limit=5000/);
    // …and nothing was written: no DELETE for the features outside the view.
    assert.deepEqual(
      calls.map((c) => c.method),
      ["GET"],
    );
  });
});

describe("saveLayerEdits — deletions are confirmed", () => {
  it("writes nothing when the plan's deletions are declined", async () => {
    // The layer is missing feature 2 — which looks the same whether the user
    // deleted it or the editor failed to load it.
    const layer = addEditedLayer([
      { type: "Feature", id: 1, geometry: point(0, 0), properties: { name: "a" } },
    ]);
    const { fetchImpl, calls } = stubServer([]);

    const outcome = await saveLayerEdits(
      CLIENT,
      layer,
      10_000,
      fetchImpl,
      () => {},
      undefined,
      () => false,
    );

    assert.deepEqual(outcome, { written: 0, errors: [] });
    assert.deepEqual(
      calls.map((c) => c.method),
      ["GET"],
    );
  });

  it("passes the plan to the confirmation and proceeds when accepted", async () => {
    const layer = addEditedLayer([
      { type: "Feature", id: 1, geometry: point(0, 0), properties: { name: "a" } },
    ]);
    const { fetchImpl, calls } = stubServer([{ status: 204 }]);
    let seen = 0;

    const outcome = await saveLayerEdits(
      CLIENT,
      layer,
      10_000,
      fetchImpl,
      () => {},
      undefined,
      (plan) => {
        seen = plan.deletes.length;
        return true;
      },
    );

    assert.equal(seen, 1);
    assert.equal(outcome.written, 1);
    assert.deepEqual(
      calls.map((c) => c.method),
      ["GET", "DELETE"],
    );
  });
});

describe("refreshLayerToExtent", () => {
  const VIEW: readonly [number, number, number, number] = [0.5, 0.5, 1.5, 1.5];

  function stubExtentServer(features: FeatureCollection["features"]) {
    const calls: string[] = [];
    const fetchImpl: GeoLensFetch = (url) => {
      calls.push(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ type: "FeatureCollection", features }),
      });
    };
    return { fetchImpl, calls };
  }

  it("re-reads for the new extent and records it as the layer's terms", async () => {
    const layer = addEditedLayer(serverItems().features);
    const { fetchImpl, calls } = stubExtentServer([
      { type: "Feature", id: 2, geometry: point(1, 1), properties: { name: "b" } },
    ]);

    await refreshLayerToExtent(CLIENT, layer, 500, fetchImpl, VIEW, "current view");

    assert.match(calls[0], /bbox=0\.5%2C0\.5%2C1\.5%2C1\.5/);
    assert.match(calls[0], /limit=500/);
    const after = useAppStore.getState().layers.find((l) => l.id === layer.id);
    assert.equal(after?.geojson?.features.length, 1);
    assert.deepEqual(after?.metadata.geolensBbox, [0.5, 0.5, 1.5, 1.5]);
    assert.equal(after?.metadata.geolensFeatureLimit, 500);
  });

  it("re-baselines, so the newly loaded features do not read as edits", async () => {
    const layer = addEditedLayer(serverItems().features);
    const features = [
      { type: "Feature" as const, id: 2, geometry: point(1, 1), properties: { name: "b" } },
    ];
    const { fetchImpl } = stubExtentServer(features);

    await refreshLayerToExtent(CLIENT, layer, 500, fetchImpl, VIEW, "current view");

    const after = useAppStore.getState().layers.find((l) => l.id === layer.id);
    assert.ok(after?.geojson);
    // Crucially not "1 deleted": the features outside the new view are gone from
    // the layer, but the baseline was rebuilt over the same extent.
    assert.deepEqual(pendingCountsFor({ ...layer, geojson: after.geojson }), {
      added: 0,
      changed: 0,
      deleted: 0,
    });
  });

  it("drops a previous extent when refreshed without one", async () => {
    const layer = addEditedLayer(serverItems().features);
    useAppStore.getState().updateLayer(layer.id, {
      metadata: {
        ...(useAppStore.getState().layers.find((l) => l.id === layer.id)?.metadata ?? {}),
        geolensBbox: [0.5, 0.5, 1.5, 1.5],
      },
    });
    const { fetchImpl, calls } = stubExtentServer(serverItems().features);

    await refreshLayerToExtent(CLIENT, layer, 500, fetchImpl, undefined, "current view");

    assert.equal(calls[0].includes("bbox"), false);
    const after = useAppStore.getState().layers.find((l) => l.id === layer.id);
    assert.equal(after?.metadata.geolensBbox, undefined);
  });

  it("keeps a name the user changed, and updates one this plugin generated", async () => {
    const generated = addEditedLayer(serverItems().features);
    useAppStore.getState().updateLayer(generated.id, { name: "Meteorites" });
    const { fetchImpl } = stubExtentServer(serverItems().features);

    await refreshLayerToExtent(
      CLIENT,
      { ...generated, datasetTitle: "Meteorites" },
      500,
      fetchImpl,
      VIEW,
      "current view",
    );
    assert.equal(
      useAppStore.getState().layers.find((l) => l.id === generated.id)?.name,
      "Meteorites (current view)",
    );

    const renamed = addEditedLayer(serverItems().features);
    useAppStore.getState().updateLayer(renamed.id, { name: "My working copy" });
    await refreshLayerToExtent(
      CLIENT,
      { ...renamed, datasetTitle: "Meteorites" },
      500,
      fetchImpl,
      VIEW,
      "current view",
    );
    assert.equal(
      useAppStore.getState().layers.find((l) => l.id === renamed.id)?.name,
      "My working copy",
    );
  });
});
