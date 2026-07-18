import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  type GeoLibreLayer,
  type LayerVirtualField,
  applyJoinsToLayer,
  applyLayerVirtualFields,
  compileFeatureExpression,
  reapplyLayerJoins,
  stripVirtualFieldColumns,
  useAppStore,
} from "@geolibre/core";
import type { Feature, FeatureCollection } from "geojson";

function pointFeature(properties: Record<string, unknown>): Feature {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [0, 0] },
    properties,
  };
}

function tableFeature(properties: Record<string, unknown>): Feature {
  return { type: "Feature", geometry: null, properties };
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

function vfield(overrides: Partial<LayerVirtualField> = {}): LayerVirtualField {
  return {
    id: "vf1",
    name: "double_density",
    expression: '["*", ["get", "density"], 2]',
    ...overrides,
  };
}

describe("compileFeatureExpression", () => {
  it("compiles once and evaluates per feature", () => {
    const compiled = compileFeatureExpression('["+", ["get", "density"], 1]');
    assert.ok(compiled.ok);
    assert.ok(compiled.evaluate);
    assert.equal(compiled.evaluate(states().features[0]), 95);
    assert.equal(compiled.evaluate(states().features[1]), 2);
  });

  it("reports compile failures without an evaluator", () => {
    const bad = compileFeatureExpression('["nope", 1]');
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.length > 0);
    assert.equal(bad.evaluate, undefined);

    const empty = compileFeatureExpression("   ");
    assert.equal(empty.ok, false);
    assert.deepEqual(empty.errors, []);
  });
});

describe("applyLayerVirtualFields", () => {
  it("materializes the computed column and records bookkeeping", () => {
    const { features, fields } = applyLayerVirtualFields(states().features, [vfield()]);
    assert.deepEqual(features[0].properties, {
      name: "Alabama",
      density: 94,
      double_density: 188,
    });
    assert.equal(features[1].properties?.double_density, 2);
    assert.equal(fields[0].addedField, "double_density");
    assert.equal(fields[0].error, undefined);
    assert.equal(fields[0].errorCount, undefined);
  });

  it("does not mutate the input features", () => {
    const input = states().features;
    applyLayerVirtualFields(input, [vfield()]);
    assert.deepEqual(input[0].properties, { name: "Alabama", density: 94 });
  });

  it("lets a later field read an earlier field's column", () => {
    const { features } = applyLayerVirtualFields(states().features, [
      vfield(),
      vfield({
        id: "vf2",
        name: "quad_density",
        expression: '["*", ["get", "double_density"], 2]',
      }),
    ]);
    assert.equal(features[0].properties?.quad_density, 376);
  });

  it("skips a field whose name collides with an existing column", () => {
    const { features, fields } = applyLayerVirtualFields(states().features, [
      vfield({ name: "density", expression: '["get", "name"]' }),
    ]);
    assert.equal(features[0].properties?.density, 94);
    assert.equal(fields[0].addedField, undefined);
    assert.equal(fields[0].error, undefined);
  });

  it("contributes nothing for a disabled field", () => {
    const { features, fields } = applyLayerVirtualFields(states().features, [
      vfield({ enabled: false }),
    ]);
    assert.equal(features[0].properties?.double_density, undefined);
    assert.equal(fields[0].addedField, undefined);
  });

  it("records a compile error instead of throwing", () => {
    const { features, fields } = applyLayerVirtualFields(states().features, [
      vfield({ expression: '["definitely-not-an-operator"]' }),
    ]);
    assert.equal(features[0].properties?.double_density, undefined);
    assert.equal(fields[0].addedField, undefined);
    assert.ok(fields[0].error);
  });

  it("nulls cells that fail at runtime and counts them", () => {
    const { features, fields } = applyLayerVirtualFields(states().features, [
      // to-number of a non-numeric string is a runtime error per feature.
      vfield({ name: "as_number", expression: '["to-number", ["get", "name"]]' }),
    ]);
    assert.equal(features[0].properties?.as_number, null);
    assert.equal(fields[0].addedField, "as_number");
    assert.equal(fields[0].errorCount, 3);
  });

  it("keeps accurate bookkeeping on a zero-feature layer", () => {
    // An empty dataset must not look like a name collision: a valid field
    // still records its column, and a compile error still surfaces.
    const valid = applyLayerVirtualFields([], [vfield()]);
    assert.deepEqual(valid.features, []);
    assert.equal(valid.fields[0].addedField, "double_density");
    assert.equal(valid.fields[0].error, undefined);

    const broken = applyLayerVirtualFields(
      [],
      [vfield({ expression: '["definitely-not-an-operator"]' })],
    );
    assert.equal(broken.fields[0].addedField, undefined);
    assert.ok(broken.fields[0].error);
  });

  it("normalizes missing values to null cells", () => {
    const { features } = applyLayerVirtualFields(states().features, [
      vfield({ name: "missing", expression: '["get", "nope"]' }),
    ]);
    assert.equal(features[0].properties?.missing, null);
  });
});

describe("stripVirtualFieldColumns", () => {
  it("removes exactly the tracked columns, restoring the base properties", () => {
    const applied = applyLayerVirtualFields(states().features, [vfield()]);
    const stripped = stripVirtualFieldColumns(applied.features, applied.fields);
    assert.deepEqual(
      stripped.map((f) => f.properties),
      states().features.map((f) => f.properties),
    );
  });

  it("returns the same feature references when nothing is tracked", () => {
    const input = states().features;
    // Definitions without `addedField` bookkeeping track no columns.
    assert.equal(stripVirtualFieldColumns(input, [vfield()])[0], input[0]);
  });
});

describe("applyJoinsToLayer with virtual fields", () => {
  function makeLayer(overrides: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
    return {
      id: "states",
      name: "States",
      type: "geojson",
      source: {},
      visible: true,
      opacity: 1,
      style: {},
      metadata: {},
      geojson: states(),
      ...overrides,
    } as GeoLibreLayer;
  }

  const censusLayer = (): GeoLibreLayer =>
    ({
      id: "census",
      name: "Census",
      type: "geojson",
      source: {},
      visible: true,
      opacity: 1,
      style: {},
      metadata: {},
      geojson: collection([
        tableFeature({ state_name: "Alabama", pop: 940 }),
        tableFeature({ state_name: "Alaska", pop: 10 }),
        tableFeature({ state_name: "Arizona", pop: 570 }),
      ]),
    }) as GeoLibreLayer;

  it("applies virtual fields after joins so expressions see joined columns", () => {
    const layer = makeLayer({
      joins: [
        {
          id: "j1",
          joinLayerId: "census",
          targetField: "name",
          joinField: "state_name",
        },
      ],
      virtualFields: [
        vfield({
          name: "pop_per_density",
          expression: '["/", ["get", "pop"], ["get", "density"]]',
        }),
      ],
    });
    const derived = applyJoinsToLayer(layer, [layer, censusLayer()]);
    assert.equal(derived.geojson?.features[0].properties?.pop, 940);
    assert.equal(derived.geojson?.features[0].properties?.pop_per_density, 10);
    assert.equal(derived.virtualFields?.[0].addedField, "pop_per_density");

    // Re-deriving is idempotent: strip + reapply lands on the same table.
    const again = applyJoinsToLayer(derived, [derived, censusLayer()]);
    assert.deepEqual(
      again.geojson?.features.map((f) => f.properties),
      derived.geojson?.features.map((f) => f.properties),
    );
  });

  it("reapplyLayerJoins re-derives virtual-field-only layers (project load)", () => {
    // Simulate a saved project whose materialized copy went stale: the stored
    // column says 999 but the expression says density * 2.
    const stale = makeLayer({
      geojson: collection([pointFeature({ name: "Alabama", density: 94, double_density: 999 })]),
      virtualFields: [vfield({ addedField: "double_density" })],
    });
    const [healed] = reapplyLayerJoins([stale]);
    assert.equal(healed.geojson?.features[0].properties?.double_density, 188);
  });
});

describe("store integration", () => {
  beforeEach(() => {
    useAppStore.getState().newProject({ name: "Virtual fields" });
    useAppStore.temporal.getState().clear();
  });

  function layerById(id: string) {
    const layer = useAppStore.getState().layers.find((l) => l.id === id);
    assert.ok(layer, `expected layer ${id}`);
    return layer;
  }

  it("setLayerVirtualFields materializes the column and marks the project dirty", () => {
    const id = useAppStore.getState().addGeoJsonLayer("States", states());
    useAppStore.getState().setLayerVirtualFields(id, [vfield()]);
    const layer = layerById(id);
    assert.equal(layer.geojson?.features[0].properties?.double_density, 188);
    assert.equal(layer.virtualFields?.[0].addedField, "double_density");
    assert.ok(useAppStore.getState().isDirty);
  });

  it("removing every field restores the base attribute table", () => {
    const id = useAppStore.getState().addGeoJsonLayer("States", states());
    useAppStore.getState().setLayerVirtualFields(id, [vfield()]);
    useAppStore.getState().setLayerVirtualFields(id, []);
    const layer = layerById(id);
    assert.deepEqual(layer.geojson?.features[0].properties, {
      name: "Alabama",
      density: 94,
    });
    assert.equal(layer.virtualFields, undefined);
  });

  it("a geojson replacement re-derives the virtual columns", () => {
    const id = useAppStore.getState().addGeoJsonLayer("States", states());
    useAppStore.getState().setLayerVirtualFields(id, [vfield()]);
    useAppStore.getState().updateLayer(id, {
      geojson: collection([pointFeature({ name: "Alabama", density: 100 })]),
    });
    const layer = layerById(id);
    assert.equal(layer.geojson?.features[0].properties?.double_density, 200);
  });

  it("re-derives over a replacement column named like the virtual field (documented trade-off)", () => {
    // Shared contract with the joins engine: a wholesale geojson replacement
    // is stripped with the previous bookkeeping because it can be a
    // write-back of the derived output (the attribute table round-trips
    // layer.geojson). A replacement dataset shipping its own column under
    // the virtual field's name therefore gets the expression's value, not
    // the incoming one — pinned here so a behavior change is deliberate.
    const id = useAppStore.getState().addGeoJsonLayer("States", states());
    useAppStore.getState().setLayerVirtualFields(id, [vfield()]);
    useAppStore.getState().updateLayer(id, {
      geojson: collection([pointFeature({ name: "Alabama", density: 100, double_density: 7 })]),
    });
    const layer = layerById(id);
    assert.equal(layer.geojson?.features[0].properties?.double_density, 200);
  });

  it("editing a join table cascades into dependent virtual fields", () => {
    const store = useAppStore.getState();
    const targetId = store.addGeoJsonLayer("States", states());
    const tableId = store.addGeoJsonLayer(
      "Census",
      collection([tableFeature({ state_name: "Alabama", pop: 940 })]),
    );
    useAppStore.getState().setLayerJoins(targetId, [
      {
        id: "j1",
        joinLayerId: tableId,
        targetField: "name",
        joinField: "state_name",
      },
    ]);
    useAppStore.getState().setLayerVirtualFields(targetId, [
      vfield({
        name: "pop_per_density",
        expression: '["/", ["get", "pop"], ["get", "density"]]',
      }),
    ]);
    assert.equal(layerById(targetId).geojson?.features[0].properties?.pop_per_density, 10);

    // Doubling pop in the join table must flow through the join and into the
    // virtual field on the joined layer.
    useAppStore.getState().updateLayer(tableId, {
      geojson: collection([tableFeature({ state_name: "Alabama", pop: 1880 })]),
    });
    assert.equal(layerById(targetId).geojson?.features[0].properties?.pop_per_density, 20);
  });
});
