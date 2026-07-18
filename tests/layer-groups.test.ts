import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  DEFAULT_LAYER_STYLE,
  applyGroupEffects,
  applyProjectToStore,
  buildLayerTree,
  createEmptyProject,
  normalizeGroupContiguity,
  parseProject,
  projectFromStore,
  serializeProject,
  useAppStore,
  type GeoLibreLayer,
  type LayerGroup,
} from "@geolibre/core";
import { setHistoryCoalesceMs } from "../packages/core/src/history";
import { redo, undo } from "../packages/core/src/store";

function layer(id: string, patch: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id,
    name: id,
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    geojson: { type: "FeatureCollection", features: [] },
    ...patch,
  };
}

function group(id: string, patch: Partial<LayerGroup> = {}): LayerGroup {
  return {
    id,
    name: id,
    collapsed: false,
    visible: true,
    opacity: 1,
    ...patch,
  };
}

const emptyFC = { type: "FeatureCollection" as const, features: [] };

describe("buildLayerTree", () => {
  it("renders top-level layers top-first with no groups", () => {
    const tree = buildLayerTree([layer("a"), layer("b")], []);
    assert.deepEqual(
      tree.map((item) => (item.kind === "layer" ? item.layer.id : null)),
      ["b", "a"],
    );
  });

  it("gathers a group's members under a single header at the top member", () => {
    const layers = [
      layer("a"),
      layer("g1", { groupId: "g" }),
      layer("g2", { groupId: "g" }),
      layer("b"),
    ];
    const tree = buildLayerTree(layers, [group("g")]);
    // Display order (top-first): b, [group g: g2, g1], a
    assert.equal(tree.length, 3);
    assert.equal(tree[0].kind, "layer");
    assert.equal(tree[1].kind, "group");
    if (tree[1].kind === "group") {
      assert.equal(tree[1].group.id, "g");
      assert.deepEqual(
        tree[1].children.map((l) => l.id),
        ["g2", "g1"],
      );
    }
    assert.equal(tree[2].kind, "layer");
  });

  it("emits empty groups pinned at the top", () => {
    const tree = buildLayerTree([layer("a")], [group("empty")]);
    assert.equal(tree[0].kind, "group");
    if (tree[0].kind === "group") {
      assert.equal(tree[0].group.id, "empty");
      assert.equal(tree[0].children.length, 0);
    }
  });

  it("treats a dangling groupId as an ungrouped layer", () => {
    const tree = buildLayerTree([layer("a", { groupId: "missing" })], []);
    assert.equal(tree.length, 1);
    assert.equal(tree[0].kind, "layer");
  });
});

describe("applyGroupEffects", () => {
  it("multiplies opacity and ANDs visibility into children", () => {
    const layers = [
      layer("a", { opacity: 0.8, visible: true, groupId: "g" }),
      layer("b", { opacity: 1, visible: true }),
    ];
    const groups = [group("g", { opacity: 0.5, visible: false })];
    const result = applyGroupEffects(layers, groups);
    assert.equal(result[0].opacity, 0.4);
    assert.equal(result[0].visible, false);
    // Ungrouped layer is untouched (same reference).
    assert.equal(result[1], layers[1]);
  });

  it("returns the same array when there are no groups", () => {
    const layers = [layer("a")];
    assert.equal(applyGroupEffects(layers, []), layers);
  });

  it("preserves the reference when a group has no effect", () => {
    const layers = [layer("a", { groupId: "g" })];
    const result = applyGroupEffects(layers, [group("g")]);
    assert.equal(result[0], layers[0]);
  });
});

describe("normalizeGroupContiguity", () => {
  it("pulls scattered group members into one block at the first member", () => {
    const layers = [layer("g1", { groupId: "g" }), layer("x"), layer("g2", { groupId: "g" })];
    const result = normalizeGroupContiguity(layers);
    assert.deepEqual(
      result.map((l) => l.id),
      ["g1", "g2", "x"],
    );
  });
});

describe("layer group store actions", () => {
  beforeEach(() => {
    setHistoryCoalesceMs(0);
    useAppStore.getState().newProject({ name: "Groups" });
    useAppStore.temporal.getState().clear();
  });

  it("creates an empty group", () => {
    const id = useAppStore.getState().addLayerGroup("Folder");
    const groups = useAppStore.getState().layerGroups;
    assert.equal(groups.length, 1);
    assert.equal(groups[0].id, id);
    assert.equal(groups[0].name, "Folder");
  });

  it("picks the lowest unique default name, even with custom-named groups", () => {
    const g1 = useAppStore.getState().addLayerGroup();
    useAppStore.getState().addLayerGroup();
    assert.equal(
      useAppStore
        .getState()
        .layerGroups.map((g) => g.name)
        .join(","),
      "Group 1,Group 2",
    );
    // Deleting "Group 1" frees that number; the next default fills the gap.
    useAppStore.getState().removeLayerGroup(g1);
    useAppStore.getState().addLayerGroup();
    const names = useAppStore.getState().layerGroups.map((g) => g.name);
    assert.equal(new Set(names).size, names.length); // all unique
    assert.deepEqual([...names].sort(), ["Group 1", "Group 2"]);

    // A custom name must not push the default past free low numbers.
    useAppStore.getState().newProject({ name: "Custom" });
    const cg = useAppStore.getState().addLayerGroup("Basemaps");
    assert.ok(cg);
    assert.equal(
      useAppStore.getState().addLayerGroup() &&
        useAppStore.getState().layerGroups.find((g) => g.name === "Group 1") !== undefined,
      true,
    );
  });

  it("creates a group from existing layers and keeps members contiguous", () => {
    const a = useAppStore.getState().addGeoJsonLayer("A", emptyFC);
    useAppStore.getState().addGeoJsonLayer("B", emptyFC);
    const c = useAppStore.getState().addGeoJsonLayer("C", emptyFC);
    const gid = useAppStore.getState().addLayerGroup("G", [a, c]);
    const layers = useAppStore.getState().layers;
    const grouped = layers.filter((l) => l.groupId === gid).map((l) => l.id);
    assert.deepEqual(grouped.sort(), [a, c].sort());
    // a and c are adjacent in the array (contiguous block).
    const indices = layers.map((l, i) => (l.groupId === gid ? i : -1)).filter((i) => i >= 0);
    assert.equal(indices[1] - indices[0], 1);
  });

  it("moves a layer into a group and back out", () => {
    const a = useAppStore.getState().addGeoJsonLayer("A", emptyFC);
    const gid = useAppStore.getState().addLayerGroup("G");
    useAppStore.getState().moveLayerToGroup(a, gid);
    assert.equal(useAppStore.getState().layers.find((l) => l.id === a)?.groupId, gid);
    useAppStore.getState().moveLayerToGroup(a, null);
    assert.equal(useAppStore.getState().layers.find((l) => l.id === a)?.groupId, undefined);
  });

  it("reorders a group block past a neighboring layer", () => {
    const a = useAppStore.getState().addGeoJsonLayer("A", emptyFC);
    const b = useAppStore.getState().addGeoJsonLayer("B", emptyFC);
    const gid = useAppStore.getState().addLayerGroup("G", [a]);
    // Array order: [a(g), b]. Move group up (toward array end / top of panel).
    useAppStore.getState().reorderLayerGroup(gid, "up");
    assert.deepEqual(
      useAppStore.getState().layers.map((l) => l.id),
      [b, a],
    );
  });

  it("ungroups children by default but can delete them", () => {
    const a = useAppStore.getState().addGeoJsonLayer("A", emptyFC);
    const gid = useAppStore.getState().addLayerGroup("G", [a]);
    useAppStore.getState().removeLayerGroup(gid);
    assert.equal(useAppStore.getState().layerGroups.length, 0);
    assert.equal(useAppStore.getState().layers.length, 1);
    assert.equal(useAppStore.getState().layers[0].groupId, undefined);

    const b = useAppStore.getState().addGeoJsonLayer("B", emptyFC);
    const gid2 = useAppStore.getState().addLayerGroup("G2", [b]);
    useAppStore.getState().removeLayerGroup(gid2, { removeChildren: true });
    assert.equal(
      useAppStore.getState().layers.some((l) => l.id === b),
      false,
    );
  });

  it("tracks group changes in undo history", () => {
    const a = useAppStore.getState().addGeoJsonLayer("A", emptyFC);
    useAppStore.temporal.getState().clear();
    const gid = useAppStore.getState().addLayerGroup("G", [a]);
    assert.equal(useAppStore.getState().layerGroups.length, 1);
    undo();
    assert.equal(useAppStore.getState().layerGroups.length, 0);
    redo();
    assert.equal(useAppStore.getState().layerGroups.length, 1);
    assert.equal(useAppStore.getState().layerGroups[0].id, gid);
  });

  it("collapse is a UI preference: not dirtying, not in undo history", () => {
    const gid = useAppStore.getState().addLayerGroup("G");
    useAppStore.getState().markSaved();
    useAppStore.temporal.getState().clear();
    const pastBefore = useAppStore.temporal.getState().pastStates.length;

    useAppStore.getState().toggleLayerGroupCollapsed(gid);
    assert.equal(useAppStore.getState().layerGroups[0].collapsed, true);
    // Toggling collapse must not dirty the project nor record an undo entry.
    assert.equal(useAppStore.getState().isDirty, false);
    assert.equal(useAppStore.temporal.getState().pastStates.length, pastBefore);
    // But it is still persisted (so folders reopen collapsed).
    assert.equal(
      projectFromStore({
        projectName: "P",
        mapView: { center: [0, 0], zoom: 1, bearing: 0, pitch: 0 },
        basemapStyleUrl: "",
        basemapVisible: true,
        basemapOpacity: 1,
        layers: useAppStore.getState().layers,
        layerGroups: useAppStore.getState().layerGroups,
        preferences: createEmptyProject().preferences,
        metadata: {},
      }).layerGroups?.[0].collapsed,
      true,
    );
  });
});

describe("layer group serialization", () => {
  it("round-trips groups through projectFromStore and parseProject", () => {
    const layers = [layer("a", { groupId: "g" }), layer("b")];
    const groups = [group("g", { name: "Folder", opacity: 0.5 })];
    const project = projectFromStore({
      projectName: "P",
      mapView: { center: [0, 0], zoom: 1, bearing: 0, pitch: 0 },
      basemapStyleUrl: "",
      basemapVisible: true,
      basemapOpacity: 1,
      layers,
      layerGroups: groups,
      preferences: createEmptyProject().preferences,
      metadata: {},
    });
    const parsed = parseProject(serializeProject(project));
    assert.equal(parsed.layerGroups?.length, 1);
    assert.equal(parsed.layerGroups?.[0].name, "Folder");
    assert.equal(parsed.layerGroups?.[0].opacity, 0.5);
    assert.equal(parsed.layers.find((l) => l.id === "a")?.groupId, "g");
  });

  it("loads a legacy project (no layerGroups) with an empty group list", () => {
    const project = parseProject(
      JSON.stringify({
        version: "0.1.0",
        name: "Legacy",
        mapView: { center: [0, 0], zoom: 1, bearing: 0, pitch: 0 },
        layers: [],
      }),
    );
    assert.equal(project.layerGroups, undefined);
  });

  it("drops a dangling groupId that has no matching group", () => {
    const project = parseProject(
      JSON.stringify({
        version: "0.2.0",
        name: "Dangling",
        mapView: { center: [0, 0], zoom: 1, bearing: 0, pitch: 0 },
        layers: [{ ...layer("a", { groupId: "missing" }) }],
        layerGroups: [],
      }),
    );
    assert.equal(project.layers[0].groupId, undefined);
  });

  it("normalizes non-contiguous group members when applied to the store", () => {
    // A hand-edited / externally produced project with a group's members
    // interleaved among unrelated layers.
    const project = parseProject(
      JSON.stringify({
        version: "0.2.0",
        name: "Interleaved",
        mapView: { center: [0, 0], zoom: 1, bearing: 0, pitch: 0 },
        layers: [layer("g1", { groupId: "g" }), layer("x"), layer("g2", { groupId: "g" })],
        layerGroups: [group("g")],
      }),
    );
    const applied = applyProjectToStore(project);
    // The group's members must be contiguous so the panel renders one header.
    assert.deepEqual(
      applied.layers.map((l) => l.id),
      ["g1", "g2", "x"],
    );
  });
});
