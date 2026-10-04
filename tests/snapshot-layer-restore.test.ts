import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  createEmptyProject,
  DEFAULT_LAYER_STYLE,
  setHistoryCoalesceMs,
  undo,
  useAppStore,
  type GeoLibreLayer,
  type GeoLibreProject,
  type LayerGroup,
} from "@geolibre/core";
import { restoreLayerFromSnapshot } from "../apps/geolibre-desktop/src/lib/snapshot-layer-restore";

function layer(id: string, over: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id,
    name: `Layer ${id}`,
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    ...over,
  };
}

function snapshotOf(layers: GeoLibreLayer[], styles: GeoLibreProject["styles"] = {}) {
  return { ...createEmptyProject("Snap"), layers, styles };
}

const group = (id: string): LayerGroup => ({
  id,
  name: id,
  collapsed: false,
  visible: true,
  opacity: 1,
});

describe("restoreLayerFromSnapshot", () => {
  it("replaces an existing layer wholesale, in place", () => {
    const current = [
      layer("a"),
      layer("b", { opacity: 0.2, filterExpression: ["==", 1, 1], name: "Edited" }),
      layer("c"),
    ];
    const snapshot = snapshotOf([layer("a"), layer("b"), layer("c")]);
    const next = restoreLayerFromSnapshot({ layers: current, layerGroups: [] }, snapshot, "b")!;
    assert.deepEqual(
      next.map((l) => l.id),
      ["a", "b", "c"],
    );
    assert.equal(next[1].opacity, 1);
    assert.equal(next[1].name, "Layer b");
    assert.equal(next[1].filterExpression, undefined);
    assert.equal(next[0], current[0], "other layers keep their identity");
  });

  it("takes the snapshot's top-level style, like a project load", () => {
    const snapshot = snapshotOf([layer("a")], {
      a: { ...DEFAULT_LAYER_STYLE, fillColor: "#abcdef" },
    });
    const next = restoreLayerFromSnapshot(
      {
        layers: [layer("a", { style: { ...DEFAULT_LAYER_STYLE, fillColor: "#000000" } })],
        layerGroups: [],
      },
      snapshot,
      "a",
    )!;
    assert.equal(next[0].style.fillColor, "#abcdef");
  });

  it("re-inserts a deleted layer below its nearest surviving upper neighbour", () => {
    const snapshot = snapshotOf([layer("a"), layer("b"), layer("c"), layer("d")]);
    const current = [layer("a"), layer("x"), layer("d")];
    const next = restoreLayerFromSnapshot({ layers: current, layerGroups: [] }, snapshot, "b")!;
    assert.deepEqual(
      next.map((l) => l.id),
      ["a", "x", "b", "d"],
    );
  });

  it("keeps a deleted top-most layer beside its lower neighbour, below newer layers", () => {
    const snapshot = snapshotOf([layer("a"), layer("b")]);
    const next = restoreLayerFromSnapshot(
      { layers: [layer("a"), layer("z")], layerGroups: [] },
      snapshot,
      "b",
    )!;
    assert.deepEqual(
      next.map((l) => l.id),
      ["a", "b", "z"],
    );
  });

  it("puts a deleted layer on top when no neighbour survives", () => {
    const snapshot = snapshotOf([layer("a"), layer("b")]);
    const next = restoreLayerFromSnapshot(
      { layers: [layer("x"), layer("y")], layerGroups: [] },
      snapshot,
      "b",
    )!;
    assert.deepEqual(
      next.map((l) => l.id),
      ["x", "y", "b"],
    );
  });

  it("drops a group the project no longer has and keeps groups contiguous", () => {
    const snapshot = snapshotOf([layer("a", { groupId: "gone" }), layer("b", { groupId: "g" })]);
    const current = [layer("c", { groupId: "g" }), layer("d")];
    const restoredA = restoreLayerFromSnapshot(
      { layers: current, layerGroups: [group("g")] },
      snapshot,
      "a",
    )!;
    assert.equal(restoredA.find((l) => l.id === "a")!.groupId, undefined);
    const restoredB = restoreLayerFromSnapshot(
      { layers: current, layerGroups: [group("g")] },
      snapshot,
      "b",
    )!;
    const ids = restoredB.map((l) => l.id);
    assert.equal(restoredB.find((l) => l.id === "b")!.groupId, "g");
    assert.equal(Math.abs(ids.indexOf("b") - ids.indexOf("c")), 1, ids.join(","));
  });

  it("returns null when the snapshot lacks the layer", () => {
    assert.equal(
      restoreLayerFromSnapshot({ layers: [], layerGroups: [] }, snapshotOf([]), "nope"),
      null,
    );
  });
});

describe("restoring a layer through the store", () => {
  beforeEach(() => {
    setHistoryCoalesceMs(0);
    useAppStore.getState().newProject();
    useAppStore.temporal.getState().clear();
  });

  it("is a single undoable step", () => {
    useAppStore.getState().addLayer(layer("a"));
    useAppStore.getState().addLayer(layer("b"));
    const snapshot = snapshotOf(useAppStore.getState().layers.map((l) => ({ ...l })));
    useAppStore.getState().removeLayer("a");
    useAppStore.getState().setLayerOpacity("b", 0.3);
    useAppStore.temporal.getState().clear();

    const state = useAppStore.getState();
    const next = restoreLayerFromSnapshot(
      { layers: state.layers, layerGroups: state.layerGroups },
      snapshot,
      "a",
    )!;
    useAppStore.setState({ layers: next, isDirty: true });
    assert.deepEqual(
      useAppStore.getState().layers.map((l) => l.id),
      ["a", "b"],
    );
    assert.equal(useAppStore.getState().layers[1].opacity, 0.3, "other layers untouched");

    undo();
    assert.deepEqual(
      useAppStore.getState().layers.map((l) => l.id),
      ["b"],
    );
  });
});
