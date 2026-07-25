import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { useAppStore } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import type {
  GeoLensFetch,
  GeoLensHttpResponse,
} from "../packages/plugins/src/plugins/geolens-api";
import {
  clearEditSessions,
  GEOLENS_FEATURES_SOURCE_KIND,
  pendingCountsFor,
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
