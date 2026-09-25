import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createEmptyProject,
  createProjectLayerSerializationCache,
  projectFromStore,
  serializeProject,
  serializeProjectWithLayerCache,
  type GeoLibreLayer,
  type GeoLibreProject,
  type MapViewState,
} from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import { geojsonLayer } from "./helpers/layer-fixtures";

/**
 * Build a one-feature collection that counts how often it is serialized.
 *
 * The count comes from a non-enumerable `toJSON` hook, which both
 * `serializeProject` and `JSON.stringify` call exactly once per write, so it
 * observes feature serialization without changing the output.
 *
 * @param counts Tally keyed by `id`, incremented on every serialization.
 * @param id Feature id and tally key.
 * @returns The counted collection.
 */
function countedCollection(counts: Map<string, number>, id: string): FeatureCollection {
  const collection: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id,
        properties: { name: id },
        geometry: { type: "Point", coordinates: [10, 20] },
      },
    ],
  };
  Object.defineProperty(collection, "toJSON", {
    enumerable: false,
    value(this: FeatureCollection) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
      return { ...this };
    },
  });
  return collection;
}

/**
 * Build a project the way the autosave path does: store-shaped layers through
 * `projectFromStore`, which prepares (and so copies) some of them.
 *
 * @param layers Store layer records.
 * @param mapView Camera to write.
 * @returns The project snapshot.
 */
function snapshotOf(layers: GeoLibreLayer[], mapView: MapViewState): GeoLibreProject {
  const empty = createEmptyProject("Cache test");
  return projectFromStore({
    projectName: empty.name,
    mapView,
    basemapStyleUrl: empty.basemapStyleUrl,
    basemapVisible: true,
    basemapOpacity: 1,
    layers,
    preferences: empty.preferences,
    metadata: {},
  });
}

function fixture() {
  const counts = new Map<string, number>();
  const layers = [
    geojsonLayer({ id: "a", name: "A", geojson: countedCollection(counts, "a") }),
    // Exercises the save-time rewrites that return a copied record.
    geojsonLayer({
      id: "b",
      name: "B",
      geojson: countedCollection(counts, "b"),
      metadata: { localBytesUrl: "blob:session", timeBinding: { field: "t" } },
      timeFilter: ["==", ["get", "t"], 1],
    }),
  ];
  return { counts, layers, view: createEmptyProject().mapView };
}

describe("serializeProjectWithLayerCache", () => {
  it("writes the same text as serializeProject", () => {
    const { layers, view } = fixture();
    const cache = createProjectLayerSerializationCache();
    const project = snapshotOf(layers, view);
    const cold = serializeProjectWithLayerCache(project, layers, cache);
    assert.equal(cold, serializeProject(project));
    // A warm cache splices in stored text; it must still match byte for byte.
    const moved = snapshotOf(layers, { ...view, center: [5, 6], zoom: 7 });
    assert.equal(serializeProjectWithLayerCache(moved, layers, cache), serializeProject(moved));
  });

  it("does not re-serialize layer features after a camera-only change", () => {
    const { counts, layers, view } = fixture();
    const cache = createProjectLayerSerializationCache();
    serializeProjectWithLayerCache(snapshotOf(layers, view), layers, cache);
    assert.deepEqual(Object.fromEntries(counts), { a: 1, b: 1 });

    const moved = snapshotOf(layers, { ...view, center: [-120, 45], zoom: 9 });
    const text = serializeProjectWithLayerCache(moved, layers, cache);
    assert.deepEqual(Object.fromEntries(counts), { a: 1, b: 1 });
    assert.deepEqual(JSON.parse(text).mapView.center, [-120, 45]);
  });

  it("re-serializes only the layer whose record changed", () => {
    const { counts, layers, view } = fixture();
    const cache = createProjectLayerSerializationCache();
    serializeProjectWithLayerCache(snapshotOf(layers, view), layers, cache);

    // The store replaces a layer record on every update; mirror that.
    const edited = [layers[0], { ...layers[1], opacity: 0.5 }];
    const text = serializeProjectWithLayerCache(snapshotOf(edited, view), edited, cache);
    assert.deepEqual(Object.fromEntries(counts), { a: 1, b: 2 });
    assert.equal(JSON.parse(text).layers[1].opacity, 0.5);
    assert.equal(text, serializeProject(snapshotOf(edited, view)));
  });

  it("serializes a reordered layer list correctly from the cache", () => {
    const { counts, layers, view } = fixture();
    const cache = createProjectLayerSerializationCache();
    serializeProjectWithLayerCache(snapshotOf(layers, view), layers, cache);
    const reordered = [layers[1], layers[0]];
    const project = snapshotOf(reordered, view);
    const text = serializeProjectWithLayerCache(project, reordered, cache);
    // A moved layer is re-serialized: its cached text was built for another index.
    assert.deepEqual(Object.fromEntries(counts), { a: 2, b: 2 });
    assert.equal(text, serializeProject(project));
  });

  it("does not reuse text built for another index when a layer's toJSON reads its key", () => {
    const keyed = (id: string) =>
      ({
        ...geojsonLayer({ id }),
        toJSON(this: GeoLibreLayer, key: string) {
          return { id: this.id, key };
        },
      }) as GeoLibreLayer;
    const layers = [keyed("a"), keyed("b")];
    const empty = createEmptyProject("Keyed");
    const cache = createProjectLayerSerializationCache();
    serializeProjectWithLayerCache({ ...empty, layers }, layers, cache);
    const reordered = [layers[1], layers[0]];
    const project = { ...empty, layers: reordered };
    const text = serializeProjectWithLayerCache(project, reordered, cache);
    assert.equal(text, serializeProject(project));
    assert.deepEqual(JSON.parse(text).layers, [
      { id: "b", key: "0" },
      { id: "a", key: "1" },
    ]);
  });

  it("bypasses the cache when the sources do not line up with the layers", () => {
    const { counts, layers, view } = fixture();
    const cache = createProjectLayerSerializationCache();
    const project = snapshotOf(layers, view);
    const text = serializeProjectWithLayerCache(project, layers.slice(0, 1), cache);
    assert.equal(text, serializeProject(project));
    // Nothing was stored, so a matching call serializes both layers again.
    serializeProjectWithLayerCache(project, layers, cache);
    assert.deepEqual(Object.fromEntries(counts), { a: 3, b: 3 });
  });
});
