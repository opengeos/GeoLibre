import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  createEmptyProject,
  createSampleStoryMap,
  DEFAULT_LAYER_STYLE,
  parseProject,
  projectFromStore,
  serializeProject,
  setHistoryCoalesceMs,
  undo,
  useAppStore,
  type GeoLibreLayer,
  type GeoLibreProject,
  type LayerGroup,
} from "@geolibre/core";
import {
  restoreLayerFromSnapshot,
  restoreLayerReferencesFromSnapshot,
} from "../apps/geolibre-desktop/src/lib/snapshot-layer-restore";

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

describe("restoring a deleted layer's references", () => {
  beforeEach(() => {
    setHistoryCoalesceMs(0);
    useAppStore.getState().newProject();
    useAppStore.temporal.getState().clear();
  });

  // Give layer "a" one of every reference removeLayer scrubs, plus matching
  // references on "b" that must survive untouched.
  function seedReferences(): void {
    const store = useAppStore.getState();
    store.addLayer(layer("a"));
    store.addLayer(layer("b"));
    store.setMapGrid(1, 2);
    const storymap = createSampleStoryMap();
    const chapter = storymap.chapters[0];
    const pane = useAppStore.getState().secondaryMapViews[0];
    useAppStore.setState({
      widgets: [
        { id: "w-a", layerId: "a", type: "histogram", field: "pop" },
        { id: "w-b", layerId: "b", type: "histogram", field: "pop" },
      ],
      comments: [
        {
          id: "c-a",
          anchor: { type: "feature", layerId: "a", featureId: 1 },
          author: { name: "Ana", color: "#123456" },
          body: "check this",
          createdAt: "2026-01-01T00:00:00.000Z",
          resolved: false,
          replies: [],
        },
      ],
      legend: {
        ...useAppStore.getState().legend,
        order: ["b", "a"],
        overrides: { a: { label: "Alpha" }, "a::0": { hidden: true } },
      },
      storymap: {
        ...storymap,
        chapters: [
          {
            ...chapter,
            onChapterEnter: [
              { id: "row-b", layerId: "b", opacity: 1 },
              { id: "row-a", layerId: "a", opacity: 0.5 },
            ],
          },
          ...storymap.chapters.slice(1),
        ],
      },
      secondaryMapViews: [{ ...pane, layerVisibility: { a: false, b: true } }],
      printLayout: {
        ...useAppStore.getState().printLayout,
        tableLayerId: "a",
        showDataTable: true,
        atlasLayerId: "b",
        atlasEnabled: true,
      },
    });
  }

  it("brings back exactly what deleting the layer scrubbed", () => {
    seedReferences();
    const before = useAppStore.getState();
    // Read back the way Project History reads a snapshot.
    const snapshot = parseProject(serializeProject(projectFromStore(before)));

    useAppStore.getState().removeLayer("a");
    const scrubbed = useAppStore.getState();
    assert.deepEqual(
      scrubbed.widgets.map((w) => w.id),
      ["w-b"],
      "removeLayer scrubbed the widget (precondition)",
    );

    const patch = restoreLayerReferencesFromSnapshot(scrubbed, snapshot, "a");
    const next = { ...scrubbed, ...patch };
    assert.deepEqual(next.widgets.map((w) => w.id).sort(), ["w-a", "w-b"]);
    assert.deepEqual(
      next.comments.map((c) => c.id),
      ["c-a"],
    );
    assert.deepEqual(next.legend.order, before.legend.order);
    assert.deepEqual(next.legend.overrides, before.legend.overrides);
    assert.deepEqual(
      next.storymap!.chapters[0].onChapterEnter.map((row) => row.id),
      ["row-b", "row-a"],
    );
    assert.deepEqual(next.secondaryMapViews[0].layerVisibility, { a: false, b: true });
    assert.equal(next.printLayout.tableLayerId, "a");
    assert.equal(next.printLayout.showDataTable, true);
    assert.equal(next.printLayout.atlasLayerId, "b");
  });

  it("does not overwrite what the user changed after the delete", () => {
    seedReferences();
    const snapshot = parseProject(serializeProject(projectFromStore(useAppStore.getState())));
    useAppStore.getState().removeLayer("a");
    // Since the delete: the table block now shows "b", the legend order was
    // reset to the default, and the chapter was deleted.
    useAppStore.setState((s) => ({
      printLayout: { ...s.printLayout, tableLayerId: "b", showDataTable: false },
      legend: { ...s.legend, order: [] },
      storymap: { ...s.storymap!, chapters: s.storymap!.chapters.slice(1) },
    }));
    const state = useAppStore.getState();

    const patch = restoreLayerReferencesFromSnapshot(state, snapshot, "a");
    assert.equal(patch.printLayout, undefined, "a re-pointed block keeps its layer");
    assert.deepEqual(
      patch.legend?.order ?? state.legend.order,
      [],
      "a default order stays default",
    );
    assert.equal(patch.storymap, undefined, "rows of a deleted chapter do not come back");
    assert.ok(patch.widgets, "unrelated sections still restore");
  });

  it("undoes the restore of the layer and its references in one step", () => {
    seedReferences();
    const snapshot = parseProject(serializeProject(projectFromStore(useAppStore.getState())));
    useAppStore.getState().removeLayer("a");
    useAppStore.temporal.getState().clear();

    const state = useAppStore.getState();
    const layers = restoreLayerFromSnapshot(state, snapshot, "a")!;
    const references = restoreLayerReferencesFromSnapshot(state, snapshot, "a");
    useAppStore.setState({ layers, ...references, isDirty: true });
    assert.ok(useAppStore.getState().widgets.some((w) => w.layerId === "a"));

    undo();
    const after = useAppStore.getState();
    assert.equal(
      after.layers.some((l) => l.id === "a"),
      false,
    );
    assert.equal(
      after.widgets.some((w) => w.layerId === "a"),
      false,
    );
    assert.equal(after.comments.length, 0);
    assert.equal("a" in after.legend.overrides, false);
    assert.equal(
      after.storymap!.chapters[0].onChapterEnter.some((r) => r.layerId === "a"),
      false,
    );
    assert.equal("a" in after.secondaryMapViews[0].layerVisibility, false);
    assert.equal(after.printLayout.tableLayerId, "");
  });

  it("changes nothing when the snapshot had no references to the layer", () => {
    useAppStore.getState().addLayer(layer("a"));
    const snapshot = parseProject(serializeProject(projectFromStore(useAppStore.getState())));
    useAppStore.getState().removeLayer("a");
    assert.deepEqual(restoreLayerReferencesFromSnapshot(useAppStore.getState(), snapshot, "a"), {});
  });
});
