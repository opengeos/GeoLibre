import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { shallow } from "zustand/shallow";
import {
  NO_LAYERS,
  createLayerSliceSelector,
  selectLayerById,
  selectLayerIds,
  selectLayerSummaries,
  selectLayersWhen,
  useAppStore,
} from "@geolibre/core";

// The narrow layer hooks wrap these selectors in `useAppStore` (with
// `useShallow` for the array-returning ones). A component re-renders when the
// selection is not equal to the previous one, so these tests pin down exactly
// which store changes produce an unequal selection.

const pointCollection = {
  type: "FeatureCollection" as const,
  features: [
    {
      type: "Feature" as const,
      properties: {},
      geometry: { type: "Point" as const, coordinates: [0, 0] },
    },
  ],
};

function addLayers(): [string, string] {
  const store = useAppStore.getState();
  store.addGeoJsonLayer("Alpha", pointCollection);
  store.addGeoJsonLayer("Beta", pointCollection);
  const [a, b] = useAppStore.getState().layers;
  return [a.id, b.id];
}

describe("layer selectors", () => {
  beforeEach(() => {
    useAppStore.getState().newProject({ name: "Selectors" });
    useAppStore.temporal.getState().clear();
  });

  it("selectLayerById keeps an untouched layer's identity when another layer changes", () => {
    const [a, b] = addLayers();
    const before = selectLayerById(useAppStore.getState(), a);
    const otherBefore = selectLayerById(useAppStore.getState(), b);
    useAppStore.getState().updateLayer(b, { opacity: 0.3 });
    assert.equal(selectLayerById(useAppStore.getState(), a), before);
    assert.notEqual(selectLayerById(useAppStore.getState(), b), otherBefore);
    assert.equal(selectLayerById(useAppStore.getState(), b)?.opacity, 0.3);
  });

  it("selectLayerById selects nothing for a missing or empty id", () => {
    addLayers();
    assert.equal(selectLayerById(useAppStore.getState(), "missing"), undefined);
    assert.equal(selectLayerById(useAppStore.getState(), null), undefined);
    assert.equal(selectLayerById(useAppStore.getState(), undefined), undefined);
  });

  it("selectLayerIds is shallow-equal across edits and changes on add/remove/reorder", () => {
    const [a, b] = addLayers();
    const ids = selectLayerIds(useAppStore.getState());
    assert.deepEqual(ids, [a, b]);

    useAppStore.getState().updateLayer(a, { opacity: 0.5, name: "Renamed" });
    assert.ok(shallow(ids, selectLayerIds(useAppStore.getState())));

    useAppStore.getState().moveLayer(a, 1);
    const moved = selectLayerIds(useAppStore.getState());
    assert.deepEqual(moved, [b, a]);
    assert.ok(!shallow(ids, moved));

    useAppStore.getState().removeLayer(a);
    assert.deepEqual(selectLayerIds(useAppStore.getState()), [b]);
  });

  it("selectLayerSummaries reuses summaries across non-summary edits", () => {
    const [a] = addLayers();
    const before = selectLayerSummaries(useAppStore.getState());
    assert.equal(before.length, 2);
    assert.equal(before[0].name, "Alpha");
    assert.equal(before[0].type, "geojson");

    useAppStore.getState().updateLayer(a, { opacity: 0.2 });
    const afterOpacity = selectLayerSummaries(useAppStore.getState());
    assert.notEqual(afterOpacity, before);
    assert.ok(shallow(before, afterOpacity), "an opacity edit must not change any summary");
    assert.equal(afterOpacity[0], before[0]);
  });

  it("selectLayerSummaries replaces only the summary whose fields changed", () => {
    const [a, b] = addLayers();
    const before = selectLayerSummaries(useAppStore.getState());

    useAppStore.getState().updateLayer(b, { name: "Gamma" });
    const renamed = selectLayerSummaries(useAppStore.getState());
    assert.ok(!shallow(before, renamed));
    assert.equal(renamed[0], before[0]);
    assert.equal(renamed[1].name, "Gamma");

    useAppStore.getState().setLayerVisibility(a, false);
    const hidden = selectLayerSummaries(useAppStore.getState());
    assert.ok(!shallow(renamed, hidden));
    assert.equal(hidden[0].visible, false);
    assert.equal(hidden[1], renamed[1]);
  });

  it("selectLayersWhen returns the live array while active and a constant otherwise", () => {
    const [a] = addLayers();
    const inactive = selectLayersWhen(false);
    const first = inactive(useAppStore.getState());
    assert.equal(first, NO_LAYERS);
    assert.equal(first.length, 0);
    useAppStore.getState().updateLayer(a, { opacity: 0.1 });
    assert.equal(inactive(useAppStore.getState()), first);

    const active = selectLayersWhen(true);
    assert.equal(active(useAppStore.getState()), useAppStore.getState().layers);
    assert.ok(Object.isFrozen(NO_LAYERS));
  });

  it("createLayerSliceSelector keeps slices stable across edits outside the picked fields", () => {
    const [a, b] = addLayers();
    let picks = 0;
    const select = createLayerSliceSelector((layer) => {
      picks += 1;
      return layer.name === "Beta" ? null : { id: layer.id, geojson: layer.geojson };
    });
    const before = select(useAppStore.getState());
    assert.equal(before.length, 1);
    assert.equal(before[0].id, a);
    assert.equal(picks, 2);

    // Unchanged `layers`: the same array, and no layer is picked again.
    assert.equal(select(useAppStore.getState()), before);
    assert.equal(picks, 2);

    // An opacity edit replaces the record but not the picked fields: only that
    // layer is re-picked, and the slice keeps its identity.
    useAppStore.getState().updateLayer(a, { opacity: 0.4 });
    const afterOpacity = select(useAppStore.getState());
    assert.equal(picks, 3);
    assert.ok(shallow(before, afterOpacity));
    assert.equal(afterOpacity[0], before[0]);

    // A data edit changes a picked field, so the slice is replaced.
    useAppStore.getState().updateLayer(a, { geojson: { ...pointCollection } });
    const afterData = select(useAppStore.getState());
    assert.ok(!shallow(afterOpacity, afterData));
    assert.notEqual(afterData[0], afterOpacity[0]);

    // Renaming the skipped layer so the predicate picks it adds a slice.
    useAppStore.getState().updateLayer(b, { name: "Gamma" });
    const afterRename = select(useAppStore.getState());
    assert.deepEqual(
      afterRename.map((slice) => slice.id),
      [a, b],
    );
    assert.equal(afterRename[0], afterData[0]);

    useAppStore.getState().removeLayer(a);
    assert.deepEqual(
      select(useAppStore.getState()).map((slice) => slice.id),
      [b],
    );
  });
});
