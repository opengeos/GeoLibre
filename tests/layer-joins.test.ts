import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  type GeoLibreProject,
  type LayerJoin,
  applyLayerJoins,
  applyJoinsToLayer,
  layerJoinKey,
  reapplyLayerJoins,
  stripJoinFields,
  useAppStore,
} from "@geolibre/core";
import type { Feature, FeatureCollection } from "geojson";

function tableFeature(properties: Record<string, unknown>): Feature {
  return { type: "Feature", geometry: null, properties };
}

function pointFeature(properties: Record<string, unknown>): Feature {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [0, 0] },
    properties,
  };
}

function collection(features: Feature[]): FeatureCollection {
  return { type: "FeatureCollection", features };
}

const states = () =>
  collection([
    pointFeature({ name: "Alabama", density: 94 }),
    pointFeature({ name: "Alaska", density: 1 }),
    pointFeature({ name: "Arizona", density: 57 }),
  ]);

const census = () =>
  collection([
    tableFeature({ state_name: "Alabama", pop: 5_000_000, income: 52_000 }),
    tableFeature({ state_name: "Arizona", pop: 7_200_000, income: 61_000 }),
    tableFeature({ state_name: "Guam", pop: 170_000, income: 58_000 }),
  ]);

function join(overrides: Partial<LayerJoin> = {}): LayerJoin {
  return {
    id: "j1",
    joinLayerId: "census",
    targetField: "name",
    joinField: "state_name",
    ...overrides,
  };
}

const resolveCensus = (id: string) =>
  id === "census" ? census() : undefined;

describe("layerJoinKey", () => {
  it("stringifies scalars so 5 and \"5\" join, and empty values never match", () => {
    assert.equal(layerJoinKey(5), "5");
    assert.equal(layerJoinKey("5"), "5");
    assert.equal(layerJoinKey(true), "true");
    assert.equal(layerJoinKey("01001"), "01001");
    assert.equal(layerJoinKey(null), null);
    assert.equal(layerJoinKey(undefined), null);
    assert.equal(layerJoinKey(""), null);
    assert.equal(layerJoinKey(Number.NaN), null);
  });
});

describe("applyLayerJoins", () => {
  it("left-joins matching rows and null-fills unmatched features", () => {
    const { features, joins } = applyLayerJoins(
      states().features,
      [join()],
      resolveCensus,
    );
    assert.deepEqual(features[0].properties, {
      name: "Alabama",
      density: 94,
      pop: 5_000_000,
      income: 52_000,
    });
    // Alaska has no census row: joined columns exist but are null.
    assert.deepEqual(features[1].properties, {
      name: "Alaska",
      density: 1,
      pop: null,
      income: null,
    });
    assert.deepEqual(joins[0].addedFields, ["pop", "income"]);
    assert.deepEqual(joins[0].stats, {
      matchedCount: 2,
      unmatchedTargetCount: 1,
      unmatchedJoinCount: 1, // Guam
    });
  });

  it("does not mutate the input features", () => {
    const input = states().features;
    applyLayerJoins(input, [join()], resolveCensus);
    assert.deepEqual(input[0].properties, { name: "Alabama", density: 94 });
  });

  it("applies a field subset and a prefix", () => {
    const { features, joins } = applyLayerJoins(
      states().features,
      [join({ fields: ["pop"], prefix: "census_" })],
      resolveCensus,
    );
    assert.deepEqual(features[0].properties, {
      name: "Alabama",
      density: 94,
      census_pop: 5_000_000,
    });
    assert.deepEqual(joins[0].addedFields, ["census_pop"]);
  });

  it("skips a joined column whose output name collides with a base column", () => {
    const { features, joins } = applyLayerJoins(
      states().features,
      [join()],
      (id) =>
        id === "census"
          ? collection([
              tableFeature({ state_name: "Alabama", density: 999, pop: 1 }),
            ])
          : undefined,
    );
    // `density` exists on the base layer, so only `pop` is brought over.
    assert.deepEqual(joins[0].addedFields, ["pop"]);
    assert.equal(features[0].properties?.density, 94);
  });

  it("keeps the first matching join row when keys repeat", () => {
    const { features } = applyLayerJoins(states().features, [join()], (id) =>
      id === "census"
        ? collection([
            tableFeature({ state_name: "Alabama", pop: 1 }),
            tableFeature({ state_name: "Alabama", pop: 2 }),
          ])
        : undefined,
    );
    assert.equal(features[0].properties?.pop, 1);
  });

  it("matches numeric target keys against string join keys", () => {
    const { features } = applyLayerJoins(
      [pointFeature({ code: 5 })],
      [join({ targetField: "code", joinField: "code" })],
      (id) =>
        id === "census"
          ? collection([tableFeature({ code: "5", label: "five" })])
          : undefined,
    );
    assert.equal(features[0].properties?.label, "five");
  });

  it("contributes nothing for a disabled join or a missing source", () => {
    const disabled = applyLayerJoins(
      states().features,
      [join({ enabled: false })],
      resolveCensus,
    );
    assert.deepEqual(disabled.features[0].properties, {
      name: "Alabama",
      density: 94,
    });
    assert.deepEqual(disabled.joins[0].addedFields, []);
    assert.equal(disabled.joins[0].stats, undefined);

    const missing = applyLayerJoins(
      states().features,
      [join({ joinLayerId: "gone" })],
      resolveCensus,
    );
    assert.deepEqual(missing.features[0].properties, {
      name: "Alabama",
      density: 94,
    });
    assert.deepEqual(missing.joins[0].addedFields, []);
  });
});

describe("stripJoinFields", () => {
  it("removes exactly the tracked columns, restoring the base properties", () => {
    const applied = applyLayerJoins(states().features, [join()], resolveCensus);
    const stripped = stripJoinFields(applied.features, applied.joins);
    assert.deepEqual(
      stripped.map((f) => f.properties),
      states().features.map((f) => f.properties),
    );
  });

  it("returns the same feature references when nothing is tracked", () => {
    const input = states().features;
    assert.equal(stripJoinFields(input, [join()])[0], input[0]);
  });
});

describe("store integration", () => {
  beforeEach(() => {
    useAppStore.getState().newProject({ name: "Joins" });
    useAppStore.temporal.getState().clear();
  });

  function addLayers() {
    const store = useAppStore.getState();
    const targetId = store.addGeoJsonLayer("States", states());
    const tableId = store.addGeoJsonLayer("Census", census());
    return { targetId, tableId };
  }

  function layerById(id: string) {
    const layer = useAppStore.getState().layers.find((l) => l.id === id);
    assert.ok(layer, `expected layer ${id}`);
    return layer;
  }

  it("setLayerJoins materializes joined columns and stats on the layer", () => {
    const { targetId, tableId } = addLayers();
    useAppStore.getState().setLayerJoins(targetId, [
      join({ joinLayerId: tableId }),
    ]);
    const layer = layerById(targetId);
    assert.equal(layer.geojson?.features[0].properties?.pop, 5_000_000);
    assert.equal(layer.joins?.[0].stats?.matchedCount, 2);
    assert.ok(useAppStore.getState().isDirty);
  });

  it("re-running setLayerJoins is idempotent and removal restores the base table", () => {
    const { targetId, tableId } = addLayers();
    const defs = [join({ joinLayerId: tableId })];
    useAppStore.getState().setLayerJoins(targetId, defs);
    useAppStore
      .getState()
      .setLayerJoins(targetId, layerById(targetId).joins ?? defs);
    const joined = layerById(targetId);
    assert.deepEqual(Object.keys(joined.geojson?.features[0].properties ?? {}), [
      "name",
      "density",
      "pop",
      "income",
    ]);

    useAppStore.getState().setLayerJoins(targetId, []);
    const restored = layerById(targetId);
    assert.deepEqual(restored.geojson?.features[0].properties, {
      name: "Alabama",
      density: 94,
    });
    assert.equal(restored.joins, undefined);
  });

  it("updating the join table's data refreshes joined columns on target layers", () => {
    const { targetId, tableId } = addLayers();
    useAppStore.getState().setLayerJoins(targetId, [
      join({ joinLayerId: tableId }),
    ]);
    const updatedCensus = collection([
      tableFeature({ state_name: "Alabama", pop: 9, income: 9 }),
      tableFeature({ state_name: "Alaska", pop: 8, income: 8 }),
    ]);
    useAppStore.getState().updateLayer(tableId, { geojson: updatedCensus });

    const layer = layerById(targetId);
    assert.equal(layer.geojson?.features[0].properties?.pop, 9);
    // Alaska now matches too.
    assert.equal(layer.geojson?.features[1].properties?.pop, 8);
    assert.equal(layer.joins?.[0].stats?.matchedCount, 2);
    assert.equal(layer.joins?.[0].stats?.unmatchedJoinCount, 0);
  });

  it("replacing the target layer's geojson re-applies its joins", () => {
    const { targetId, tableId } = addLayers();
    useAppStore.getState().setLayerJoins(targetId, [
      join({ joinLayerId: tableId }),
    ]);
    // Simulate a file reload delivering raw base data (no joined columns).
    useAppStore.getState().updateLayer(targetId, {
      geojson: collection([pointFeature({ name: "Arizona", density: 57 })]),
    });
    const layer = layerById(targetId);
    assert.equal(layer.geojson?.features[0].properties?.pop, 7_200_000);
  });

  it("loadProject re-resolves persisted joins against the loaded layers", () => {
    const { targetId, tableId } = addLayers();
    useAppStore.getState().setLayerJoins(targetId, [
      join({ joinLayerId: tableId }),
    ]);
    const snapshot = JSON.parse(
      JSON.stringify({
        version: 1,
        name: "Joins",
        mapView: useAppStore.getState().mapView,
        basemapStyleUrl: useAppStore.getState().basemapStyleUrl,
        basemapVisible: true,
        basemapOpacity: 1,
        layers: useAppStore.getState().layers,
        styles: {},
        preferences: useAppStore.getState().preferences,
        metadata: {},
      }),
    ) as GeoLibreProject;
    // Stale saved output: the census table changed after the project was saved.
    const savedTable = snapshot.layers.find((l) => l.id === tableId);
    assert.ok(savedTable?.geojson);
    savedTable.geojson.features = [
      tableFeature({ state_name: "Alaska", pop: 42, income: 1 }),
    ];

    useAppStore.getState().loadProject(snapshot);
    const layer = layerById(targetId);
    assert.equal(layer.geojson?.features[0].properties?.pop, null);
    assert.equal(layer.geojson?.features[1].properties?.pop, 42);
    assert.equal(layer.joins?.[0].stats?.matchedCount, 1);
  });

  it("applyJoinsToLayer refuses a self-join", () => {
    const { targetId } = addLayers();
    const layer = layerById(targetId);
    const result = applyJoinsToLayer(
      layer,
      useAppStore.getState().layers,
      [join({ joinLayerId: targetId })],
    );
    assert.deepEqual(result.joins?.[0].addedFields, []);
    assert.deepEqual(
      result.geojson?.features[0].properties,
      layer.geojson?.features[0].properties,
    );
  });

  it("reapplyLayerJoins passes layers without joins through by reference", () => {
    const { targetId } = addLayers();
    const layers = useAppStore.getState().layers;
    assert.equal(reapplyLayerJoins(layers), layers);
    void targetId;
  });
});
