import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { useAppStore } from "@geolibre/core";
import { SKETCHES_SOURCE_KIND } from "@geolibre/plugins/geo-editor-geometry";
import type { GeoLibreSelection } from "@geolibre/plugins";
import { createPluginLayerGroupActions } from "../apps/geolibre-desktop/src/lib/plugin-layer-groups";
import { createPluginLayerQueries } from "../apps/geolibre-desktop/src/lib/plugin-layer-queries";

// These exercise `createPluginLayerQueries`, which `createAppAPI` spreads into
// the object it hands plugins, rather than reaching through `createAppAPI`
// itself. Loading `usePlugins.ts` pulls in the whole built-in plugin registry
// (and MapCanvas, CesiumCanvas, and every `maplibre-*` plugin with it), which
// forced this file to stub `maplibre-gl`, `window`, and `localStorage` just to
// import it, and put 39 browser-only modules into the coverage report. The
// wiring itself is a typed spread, so `npm run build` is what holds it.

describe("external plugin query API", () => {
  beforeEach(() => {
    useAppStore.getState().newProject({ name: "Plugin query API" });
  });

  it("returns every selected feature and its layer id", () => {
    const store = useAppStore.getState();
    const layerId = store.addGeoJsonLayer("Catchments", {
      type: "FeatureCollection",
      features: [
        { type: "Feature", id: "A", properties: { NAME: "A" }, geometry: null },
        { type: "Feature", id: "B", properties: { NAME: "B" }, geometry: null },
      ],
    });
    store.selectLayer(layerId);
    store.selectFeatures(["A", "B"]);

    const app = createPluginLayerQueries();
    assert.equal(app.getSelectedLayerId(), layerId);
    assert.deepEqual(
      app.getSelectedFeatures().map((feature) => feature.id),
      ["A", "B"],
    );
  });

  it("notifies and unsubscribes selection listeners", () => {
    const app = createPluginLayerQueries();
    const events: unknown[] = [];
    const unsubscribe = app.onSelectionChange((selection) => events.push(selection));
    assert.ok(unsubscribe);
    useAppStore.getState().selectFeatures(["A"]);
    assert.equal(events.length, 1);
    unsubscribe();
    useAppStore.getState().selectFeatures([]);
    assert.equal(events.length, 1);
  });

  it("lists layers and returns feature properties and geometry without mutating state", () => {
    const store = useAppStore.getState();
    const layerId = store.addGeoJsonLayer("Catchments", {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "A",
          properties: { NAME: "Upper Basin", AREA_KM2: 12.5 },
          geometry: { type: "Point", coordinates: [101.7, 3.1] },
        },
      ],
    });
    const before = JSON.stringify(useAppStore.getState());

    const app = createPluginLayerQueries();
    assert.deepEqual(app.listLayers(), [
      {
        id: layerId,
        name: "Catchments",
        type: "geojson",
        visible: true,
        opacity: 1,
      },
    ]);
    assert.deepEqual(app.getLayerFeatures(layerId), [
      {
        type: "Feature",
        id: "A",
        properties: { NAME: "Upper Basin", AREA_KM2: 12.5 },
        geometry: { type: "Point", coordinates: [101.7, 3.1] },
      },
    ]);
    app.getSelectedFeatures();
    app.getSelectedLayerId();
    app.getDrawnFeatures();

    assert.equal(JSON.stringify(useAppStore.getState()), before);
  });

  it("returns detached features from every plugin query boundary", () => {
    const store = useAppStore.getState();
    const layerId = store.addGeoJsonLayer("Sketches", {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "A",
          properties: { metadata: { label: "Original" } },
          geometry: { type: "Point", coordinates: [101.7, 3.1] },
        },
      ],
    });
    store.updateLayer(layerId, {
      metadata: { sourceKind: SKETCHES_SOURCE_KIND },
    });
    store.selectLayer(layerId);

    const app = createPluginLayerQueries();
    let callbackSelection: GeoLibreSelection | undefined;
    const unsubscribe = app.onSelectionChange((selection) => {
      callbackSelection = selection;
    });
    assert.ok(unsubscribe);
    store.selectFeatures(["A"]);
    assert.ok(callbackSelection);

    const returnedFeatures = [
      app.getLayerFeatures(layerId)[0],
      app.getSelectedFeatures()[0],
      app.getDrawnFeatures()[0],
      callbackSelection.features[0],
    ];
    for (const feature of returnedFeatures) {
      assert.ok(feature);
      const properties = feature.properties as { metadata: { label: string } };
      properties.metadata.label = "Mutated by plugin";
      assert.equal(feature.geometry?.type, "Point");
      feature.geometry.coordinates[0] = 0;
    }
    unsubscribe();

    const storedFeature = useAppStore.getState().layers.find((layer) => layer.id === layerId)
      ?.geojson?.features[0];
    assert.ok(storedFeature);
    assert.deepEqual(storedFeature.properties, { metadata: { label: "Original" } });
    assert.deepEqual(storedFeature.geometry, { type: "Point", coordinates: [101.7, 3.1] });
  });

  it("throws when a requested layer does not exist", () => {
    const app = createPluginLayerQueries();
    assert.throws(() => app.getLayerFeatures("missing-layer"), {
      message: 'No layer with id "missing-layer"',
    });
  });

  it("resolves selected features by their array index when ids are absent", () => {
    const store = useAppStore.getState();
    const layerId = store.addGeoJsonLayer("Unkeyed", {
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: { NAME: "First" }, geometry: null },
        { type: "Feature", properties: { NAME: "Second" }, geometry: null },
      ],
    });
    store.selectLayer(layerId);
    store.selectFeatures(["1"]);

    assert.deepEqual(
      createPluginLayerQueries()
        .getSelectedFeatures()
        .map((feature) => feature.properties?.NAME),
      ["Second"],
    );
  });

  it("returns an empty feature list for an empty selection", () => {
    const store = useAppStore.getState();
    const layerId = store.addGeoJsonLayer("Catchments", {
      type: "FeatureCollection",
      features: [{ type: "Feature", id: "A", properties: {}, geometry: null }],
    });
    store.selectLayer(layerId);

    const app = createPluginLayerQueries();
    assert.equal(app.getSelectedLayerId(), layerId);
    assert.deepEqual(app.getSelectedFeatures(), []);
  });

  it("returns features from every sketch layer and excludes ordinary layers", () => {
    const store = useAppStore.getState();
    store.addGeoJsonLayer("Catchments", {
      type: "FeatureCollection",
      features: [{ type: "Feature", id: "ordinary", properties: {}, geometry: null }],
    });
    const sketchLayerId = store.addGeoJsonLayer("Sketches", {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "drawn-1",
          properties: { label: "Outlet" },
          geometry: { type: "Point", coordinates: [101.6, 3.2] },
        },
      ],
    });
    store.updateLayer(sketchLayerId, {
      metadata: { sourceKind: SKETCHES_SOURCE_KIND },
    });

    assert.deepEqual(createPluginLayerQueries().getDrawnFeatures(), [
      {
        type: "Feature",
        id: "drawn-1",
        properties: { label: "Outlet" },
        geometry: { type: "Point", coordinates: [101.6, 3.2] },
      },
    ]);
  });
});

// The group half of the API a plugin needs to build nested folders (#2553).
// These go through the same factories `createAppAPI` spreads in rather than
// calling the store directly: every method on `GeoLibreAppAPI` is optional, so
// type checking alone would not notice a delegate going missing or forwarding
// its arguments in the wrong order.
describe("external plugin layer-group API", () => {
  beforeEach(() => {
    useAppStore.getState().newProject({ name: "Plugin group API" });
  });

  it("nests a group inside another one and reports the tree", () => {
    const app = { ...createPluginLayerGroupActions(), ...createPluginLayerQueries() };
    const parentId = app.addLayerGroup("Basins");
    const childId = app.addLayerGroup("Sub-basins");
    app.moveLayerGroupToGroup(childId, parentId);

    assert.deepEqual(app.listLayerGroups(), [
      { id: parentId, name: "Basins", parentId: null, visible: true, opacity: 1, collapsed: false },
      {
        id: childId,
        name: "Sub-basins",
        parentId,
        visible: true,
        opacity: 1,
        collapsed: false,
      },
    ]);
  });

  it("lifts a nested group back to the panel root with a null parent", () => {
    const app = { ...createPluginLayerGroupActions(), ...createPluginLayerQueries() };
    const parentId = app.addLayerGroup("Basins");
    const childId = app.addLayerGroup("Sub-basins");
    app.moveLayerGroupToGroup(childId, parentId);
    app.moveLayerGroupToGroup(childId, null);

    assert.deepEqual(
      app.listLayerGroups().map((group) => group.parentId),
      [null, null],
    );
  });

  it("refuses a move that would make a group its own ancestor", () => {
    const app = { ...createPluginLayerGroupActions(), ...createPluginLayerQueries() };
    const parentId = app.addLayerGroup("Basins");
    const childId = app.addLayerGroup("Sub-basins");
    app.moveLayerGroupToGroup(childId, parentId);
    // The cycle the panel's menu never offers but a plugin could ask for.
    app.moveLayerGroupToGroup(parentId, childId);

    const groups = app.listLayerGroups();
    assert.equal(groups.find((group) => group.id === parentId)?.parentId, null);
    assert.equal(groups.find((group) => group.id === childId)?.parentId, parentId);
  });

  it("ignores an unknown group id on either side of the move", () => {
    const app = { ...createPluginLayerGroupActions(), ...createPluginLayerQueries() };
    const groupId = app.addLayerGroup("Basins");
    app.moveLayerGroupToGroup("missing-group", groupId);
    app.moveLayerGroupToGroup(groupId, "missing-parent");

    assert.deepEqual(
      app.listLayerGroups().map((group) => [group.id, group.parentId]),
      [[groupId, null]],
    );
  });

  it("moves layers into a group it created and removes the group alone", () => {
    const store = useAppStore.getState();
    const layerId = store.addGeoJsonLayer("Catchments", {
      type: "FeatureCollection",
      features: [{ type: "Feature", id: "A", properties: {}, geometry: null }],
    });
    const app = { ...createPluginLayerGroupActions(), ...createPluginLayerQueries() };
    const groupId = app.addLayerGroup("Basins");
    app.moveLayersToGroup([layerId], groupId);
    assert.equal(useAppStore.getState().layers[0]?.groupId, groupId);

    // Removing the folder must leave the layer behind, not delete it with it.
    app.removeLayerGroup(groupId);
    assert.deepEqual(app.listLayerGroups(), []);
    assert.deepEqual(
      app.listLayers().map((layer) => layer.id),
      [layerId],
    );
  });
});
