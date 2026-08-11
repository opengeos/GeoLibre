import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  DEFAULT_LAYER_STYLE,
  applyGroupEffects,
  applyProjectToStore,
  buildLayerPanelUnits,
  buildLayerTree,
  createEmptyProject,
  effectiveLayerRenderState,
  layerGroupMoveability,
  layerPanelGroupHeaders,
  normalizeGroupContiguity,
  reorderLayerGroupInPanel,
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

  it("emits an empty group at the top when no other group is positioned", () => {
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

/** Panel rows top-first as `layer:<id>` / `group:<id>`, for readable asserts. */
function panelOrder(layers: GeoLibreLayer[], groups: LayerGroup[]): string[] {
  return buildLayerPanelUnits(layers, groups).map((unit) =>
    unit.groupId ? `group:${unit.groupId}` : `layer:${unit.layers[0].id}`,
  );
}

describe("buildLayerPanelUnits", () => {
  it("stacks empty groups in group order at the top of an empty panel", () => {
    assert.deepEqual(panelOrder([], [group("g1"), group("g2")]), ["group:g1", "group:g2"]);
  });

  it("keeps an empty group below the populated group it follows (GeoLibre#1739)", () => {
    // Group 1 gains a layer; Group 2 is still empty and must stay under it.
    const layers = [layer("a", { groupId: "g1" })];
    assert.deepEqual(panelOrder(layers, [group("g1"), group("g2")]), ["group:g1", "group:g2"]);
  });

  it("puts an empty group above the populated group that follows it", () => {
    const layers = [layer("a", { groupId: "g2" })];
    assert.deepEqual(panelOrder(layers, [group("g1"), group("g2")]), ["group:g1", "group:g2"]);
  });

  it("places an empty child group directly below its parent's block", () => {
    const layers = [layer("a", { groupId: "parent" })];
    // "child" precedes "parent" in the array, so only the parent link can put
    // it under the parent rather than above it.
    assert.deepEqual(
      panelOrder(layers, [group("child", { parentId: "parent" }), group("parent")]),
      ["group:parent", "group:child"],
    );
  });

  it("keeps a fully empty parent visible when its child precedes it", () => {
    // "Move to group" only rewrites parentId, so a child can sit ahead of its
    // own parent in the array. Both folders are empty, so neither can be drawn
    // against a descendant layer and both need a block of their own.
    assert.deepEqual(panelOrder([], [group("child", { parentId: "parent" }), group("parent")]), [
      "group:parent",
      "group:child",
    ]);
  });

  it("gives an empty organizer's own empty child a block, not the organizer", () => {
    // "outer" has a layer beneath it via "inner", so the panel draws its header
    // against that layer; only "spare", whose subtree is empty, needs a block.
    const layers = [layer("a", { groupId: "inner" })];
    const groups = [
      group("outer"),
      group("inner", { parentId: "outer" }),
      group("spare", { parentId: "outer" }),
    ];
    assert.deepEqual(panelOrder(layers, groups), ["group:inner", "group:spare"]);
  });

  it("keeps a nested empty folder beside its sibling, not outside its parent", () => {
    // The reported follow-up to GeoLibre#1739: "c2" gains the first layer, and
    // "c1" has to stay next to it under "p" rather than being pushed past the
    // unrelated top-level "other".
    const layers = [layer("a", { groupId: "c2" })];
    const groups = [
      group("p"),
      group("c1", { parentId: "p" }),
      group("c2", { parentId: "p" }),
      group("other"),
    ];
    assert.deepEqual(panelOrder(layers, groups), ["group:c1", "group:c2", "group:other"]);
  });

  it("anchors a top-level folder past a whole subtree, not inside it", () => {
    // "other" follows "p" in the array, so it belongs below everything nested
    // in it. The nested "c2" sits at the top of p's block, so anchoring on the
    // nearest group in array order rather than on the nearest *sibling* would
    // wedge "other" between p's two children.
    const layers = [layer("a1", { groupId: "c1" }), layer("a2", { groupId: "c2" })];
    const groups = [
      group("p"),
      group("c1", { parentId: "p" }),
      group("c2", { parentId: "p" }),
      group("other"),
    ];
    assert.deepEqual(panelOrder(layers, groups), ["group:c2", "group:c1", "group:other"]);
  });

  it("draws a parent header above the nested folder it holds", () => {
    // "p" has a layer only through "c2", so its header is drawn against that
    // layer's row; the empty "c1" is drawn against the same row and must follow
    // the parent it sits inside.
    const layers = [layer("a", { groupId: "c2" })];
    const groups = [group("p"), group("c1", { parentId: "p" }), group("c2", { parentId: "p" })];
    const headers = layerPanelGroupHeaders(layers, groups);
    assert.deepEqual(
      headers.aboveLayer.get("a")?.map((g) => g.id),
      ["p", "c1", "c2"],
    );
    assert.equal(headers.bottom.length, 0);
  });

  it("orders and draws grandchild folders at two levels of nesting", () => {
    // Depth 2: only "leafB" holds a layer, so "leafA" is placed by its own
    // sibling rather than by "mid" or "p", both of which are ancestors whose
    // ranges already contain the slot. "other" clears the whole subtree.
    const layers = [layer("a", { groupId: "leafB" })];
    const groups = [
      group("p"),
      group("mid", { parentId: "p" }),
      group("leafA", { parentId: "mid" }),
      group("leafB", { parentId: "mid" }),
      group("other"),
    ];
    assert.deepEqual(panelOrder(layers, groups), ["group:leafA", "group:leafB", "group:other"]);
    // Every ancestor header precedes the folders nested in it.
    const headers = layerPanelGroupHeaders(layers, groups);
    assert.deepEqual(
      headers.aboveLayer.get("a")?.map((g) => g.id),
      ["p", "mid", "leafA", "leafB"],
    );
    assert.deepEqual(
      headers.bottom.map((g) => g.id),
      ["other"],
    );
  });

  it("anchors headers against the layer rows the panel draws", () => {
    const layers = [layer("bottom"), layer("a", { groupId: "g1" }), layer("top")];
    const headers = layerPanelGroupHeaders(layers, [group("g1"), group("g2")]);
    // Display order is top-first: top, [g1: a], bottom. g2 follows g1's block,
    // so it draws immediately above "bottom".
    assert.deepEqual(
      headers.aboveLayer.get("a")?.map((g) => g.id),
      ["g1"],
    );
    assert.deepEqual(
      headers.aboveLayer.get("bottom")?.map((g) => g.id),
      ["g2"],
    );
    assert.equal(headers.bottom.length, 0);
  });

  it("drops an empty group to the panel bottom when nothing follows it", () => {
    const layers = [layer("a", { groupId: "g1" })];
    const headers = layerPanelGroupHeaders(layers, [group("g1"), group("g2")]);
    assert.deepEqual(
      headers.bottom.map((g) => g.id),
      ["g2"],
    );
    assert.deepEqual(
      headers.aboveLayer.get("a")?.map((g) => g.id),
      ["g1"],
    );
  });

  it("emits a scattered group's header once, at its top-most block", () => {
    const layers = [layer("g1", { groupId: "g" }), layer("x"), layer("g2", { groupId: "g" })];
    const headers = layerPanelGroupHeaders(layers, [group("g")]);
    assert.deepEqual(
      headers.aboveLayer.get("g2")?.map((h) => h.id),
      ["g"],
    );
    assert.equal(headers.aboveLayer.has("g1"), false);
  });

  it("terminates on a parentId cycle instead of hanging", () => {
    // Each group is the other's parent, so the ancestor walk gives both a
    // position from the one layer and neither is emitted as an empty folder.
    const groups = [group("g1", { parentId: "g2" }), group("g2", { parentId: "g1" })];
    assert.deepEqual(panelOrder([layer("a", { groupId: "g1" })], groups), ["group:g1"]);
  });

  it("ends the ancestor walk at a parentId that names no group", () => {
    const groups = [group("g1", { parentId: "missing" })];
    assert.deepEqual(panelOrder([layer("a", { groupId: "g1" })], groups), ["group:g1"]);
  });
});

describe("reorderLayerGroupInPanel", () => {
  it("swaps two empty groups without touching the layers", () => {
    const layers = [layer("a")];
    const groups = [group("g1"), group("g2")];
    const moved = reorderLayerGroupInPanel(layers, groups, "g2", "up");
    assert.ok(moved);
    assert.deepEqual(
      moved.groups.map((g) => g.id),
      ["g2", "g1"],
    );
    assert.deepEqual(
      moved.layers.map((l) => l.id),
      ["a"],
    );
    assert.deepEqual(panelOrder(moved.layers, moved.groups), ["group:g2", "group:g1", "layer:a"]);
  });

  it("moves a populated group past an empty one (GeoLibre#1739)", () => {
    const layers = [layer("a", { groupId: "g1" })];
    const groups = [group("g1"), group("g2")];
    const moved = reorderLayerGroupInPanel(layers, groups, "g1", "down");
    assert.ok(moved);
    assert.deepEqual(panelOrder(moved.layers, moved.groups), ["group:g2", "group:g1"]);
  });

  it("compacts a subtree that straddles an unrelated block when moving it", () => {
    // Nesting only rewrites parentId, so "loose" can sit between two sibling
    // child groups. Moving the parent gathers the subtree into one block and
    // leaves "loose" on the far side of it — more than one row shifts.
    const layers = [
      layer("bottom"),
      layer("c1layer", { groupId: "c1" }),
      layer("loose"),
      layer("c2layer", { groupId: "c2" }),
      layer("top"),
    ];
    const groups = [group("p"), group("c1", { parentId: "p" }), group("c2", { parentId: "p" })];
    assert.deepEqual(panelOrder(layers, groups), [
      "layer:top",
      "group:c2",
      "layer:loose",
      "group:c1",
      "layer:bottom",
    ]);

    const moved = reorderLayerGroupInPanel(layers, groups, "p", "down");
    assert.ok(moved);
    assert.deepEqual(panelOrder(moved.layers, moved.groups), [
      "layer:top",
      "layer:loose",
      "layer:bottom",
      "group:c2",
      "group:c1",
    ]);
  });

  it("carries a whole subtree past a sibling group as one block", () => {
    const layers = [layer("c1", { groupId: "childA" }), layer("s1", { groupId: "sib" })];
    const groups = [
      group("parent"),
      group("childA", { parentId: "parent" }),
      group("childB", { parentId: "parent" }),
      group("sib"),
    ];
    // Panel before: sib, [childA: c1], childB (empty, under its parent).
    assert.deepEqual(panelOrder(layers, groups), ["group:sib", "group:childA", "group:childB"]);

    const moved = reorderLayerGroupInPanel(layers, groups, "parent", "up");
    assert.ok(moved);
    // Both children travel with the parent and stay in its block.
    assert.deepEqual(panelOrder(moved.layers, moved.groups), [
      "group:childA",
      "group:childB",
      "group:sib",
    ]);
    assert.deepEqual(
      moved.layers.map((l) => l.id),
      ["s1", "c1"],
    );
  });

  it("returns null at the ends of the panel", () => {
    const layers = [layer("a", { groupId: "g1" })];
    const groups = [group("g1"), group("g2")];
    assert.equal(reorderLayerGroupInPanel(layers, groups, "g1", "up"), null);
    assert.equal(reorderLayerGroupInPanel(layers, groups, "g2", "down"), null);
    assert.equal(reorderLayerGroupInPanel(layers, groups, "missing", "up"), null);
  });

  it("swaps two nested folders inside their parent", () => {
    const layers = [layer("a", { groupId: "c2" })];
    const groups = [group("p"), group("c1", { parentId: "p" }), group("c2", { parentId: "p" })];
    assert.deepEqual(panelOrder(layers, groups), ["group:c1", "group:c2"]);

    const moved = reorderLayerGroupInPanel(layers, groups, "c1", "down");
    assert.ok(moved);
    assert.deepEqual(panelOrder(moved.layers, moved.groups), ["group:c2", "group:c1"]);
  });

  it("keeps a nested group inside its parent at either end", () => {
    // "other" is not a sibling, so it is a wall rather than the next block:
    // "c1" cannot move up past its parent's header, nor "c2" down out of it.
    const layers = [layer("a", { groupId: "c1" })];
    const groups = [
      group("p"),
      group("c1", { parentId: "p" }),
      group("c2", { parentId: "p" }),
      group("other"),
    ];
    const moveability = layerGroupMoveability(layers, groups);
    assert.deepEqual(moveability.get("c1"), { up: false, down: true });
    assert.deepEqual(moveability.get("c2"), { up: true, down: false });
    assert.equal(reorderLayerGroupInPanel(layers, groups, "c2", "down"), null);
  });

  it("steps a nested group over its parent's own layers without leaving it", () => {
    // "p" owns "L" directly and holds the populated child "c1". Those rows are
    // one more block inside "p", so ordering the child against them is a real
    // reorder — but "other" is outside "p" and stays a wall.
    const layers = [
      layer("Z", { groupId: "other" }),
      layer("L", { groupId: "p" }),
      layer("M", { groupId: "c1" }),
    ];
    const groups = [group("p"), group("c1", { parentId: "p" }), group("other")];
    assert.deepEqual(panelOrder(layers, groups), ["group:c1", "group:p", "group:other"]);

    const moved = reorderLayerGroupInPanel(layers, groups, "c1", "down");
    assert.ok(moved);
    assert.deepEqual(panelOrder(moved.layers, moved.groups), [
      "group:p",
      "group:c1",
      "group:other",
    ]);
    // Still the last block inside "p": it cannot go on to cross "other".
    assert.equal(reorderLayerGroupInPanel(moved.layers, moved.groups, "c1", "down"), null);
  });

  it("leaves an empty child where it is when only layer rows are adjacent", () => {
    // An empty folder cannot record a position between two layer rows, so a
    // move that would only cross its parent's own layers changes nothing — the
    // same limit empty folders have at the top level.
    const layers = [layer("L", { groupId: "p" })];
    const groups = [group("p"), group("c1", { parentId: "p" })];
    assert.deepEqual(panelOrder(layers, groups), ["group:p", "group:c1"]);
    assert.equal(reorderLayerGroupInPanel(layers, groups, "c1", "up"), null);
    assert.equal(reorderLayerGroupInPanel(layers, groups, "c1", "down"), null);
  });

  it("moves a grandchild among its siblings and stops at its own parent", () => {
    const layers = [layer("a", { groupId: "leafB" })];
    const groups = [
      group("p"),
      group("mid", { parentId: "p" }),
      group("leafA", { parentId: "mid" }),
      group("leafB", { parentId: "mid" }),
      group("other"),
    ];
    // "mid" is the wall for its children, not the outer "p" or "other".
    const moveability = layerGroupMoveability(layers, groups);
    assert.deepEqual(moveability.get("leafA"), { up: false, down: true });
    assert.deepEqual(moveability.get("leafB"), { up: true, down: false });

    const moved = reorderLayerGroupInPanel(layers, groups, "leafA", "down");
    assert.ok(moved);
    assert.deepEqual(panelOrder(moved.layers, moved.groups), [
      "group:leafB",
      "group:leafA",
      "group:other",
    ]);
  });

  it("steps a top-level group over a whole subtree in one move", () => {
    const layers = [layer("a", { groupId: "c1" }), layer("b", { groupId: "c2" })];
    const groups = [
      group("p"),
      group("c1", { parentId: "p" }),
      group("c2", { parentId: "p" }),
      group("other"),
    ];
    assert.deepEqual(panelOrder(layers, groups), ["group:c2", "group:c1", "group:other"]);

    const moved = reorderLayerGroupInPanel(layers, groups, "other", "up");
    assert.ok(moved);
    // "other" clears both of p's children rather than landing between them.
    assert.deepEqual(panelOrder(moved.layers, moved.groups), [
      "group:other",
      "group:c2",
      "group:c1",
    ]);
  });

  it("reports the directions each group can move", () => {
    const moveability = layerGroupMoveability(
      [layer("a", { groupId: "g1" })],
      [group("g1"), group("g2")],
    );
    assert.deepEqual(moveability.get("g1"), { up: false, down: true });
    assert.deepEqual(moveability.get("g2"), { up: true, down: false });
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

  it("inherits visibility and opacity through nested groups", () => {
    const layers = [layer("a", { groupId: "child", opacity: 0.8 })];
    const groups = [
      group("parent", { opacity: 0.5, visible: false }),
      group("child", { parentId: "parent", opacity: 0.25 }),
    ];
    const result = applyGroupEffects(layers, groups);
    assert.equal(result[0].visible, false);
    assert.equal(result[0].opacity, 0.1);
  });
});

describe("effectiveLayerRenderState", () => {
  it("folds the whole group chain, matching applyGroupEffects", () => {
    const child = layer("a", { groupId: "child", opacity: 0.8 });
    const groups = [
      group("parent", { opacity: 0.5, visible: false }),
      group("child", { parentId: "parent", opacity: 0.25 }),
    ];
    assert.deepEqual(effectiveLayerRenderState(child, groups), {
      visible: false,
      opacity: 0.1,
    });
  });

  it("returns the layer's own values when it is ungrouped", () => {
    const orphan = layer("a", { opacity: 0.3, visible: false });
    assert.deepEqual(effectiveLayerRenderState(orphan, [group("g", { visible: false })]), {
      visible: false,
      opacity: 0.3,
    });
  });

  it("ignores a dangling groupId rather than dropping the layer", () => {
    const dangling = layer("a", { groupId: "gone", opacity: 0.6 });
    assert.deepEqual(effectiveLayerRenderState(dangling, [group("g", { opacity: 0.5 })]), {
      visible: true,
      opacity: 0.6,
    });
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

  it("moves multiple layers into a group atomically and preserves their order", () => {
    const a = useAppStore.getState().addGeoJsonLayer("A", emptyFC);
    const b = useAppStore.getState().addGeoJsonLayer("B", emptyFC);
    const c = useAppStore.getState().addGeoJsonLayer("C", emptyFC);
    const gid = useAppStore.getState().addLayerGroup("G");
    useAppStore.temporal.getState().clear();

    useAppStore.getState().moveLayersToGroup([c, a], gid);

    const grouped = useAppStore
      .getState()
      .layers.filter((item) => item.groupId === gid)
      .map((item) => item.id);
    assert.deepEqual(grouped, [a, c]);
    assert.equal(useAppStore.temporal.getState().pastStates.length, 1);
    assert.equal(useAppStore.getState().layers.find((item) => item.id === b)?.groupId, undefined);
  });

  it("leaves already-targeted layers in place during a mixed bulk move", () => {
    const a = useAppStore.getState().addGeoJsonLayer("A", emptyFC);
    const b = useAppStore.getState().addGeoJsonLayer("B", emptyFC);
    const c = useAppStore.getState().addGeoJsonLayer("C", emptyFC);
    const gid = useAppStore.getState().addLayerGroup("G", [b]);

    useAppStore.getState().moveLayersToGroup([a, b], gid);

    assert.deepEqual(
      useAppStore.getState().layers.map((item) => item.id),
      [b, a, c],
    );
    assert.equal(useAppStore.getState().layers.find((item) => item.id === a)?.groupId, gid);
  });

  it("reorders selected top-level layers as one block", () => {
    const a = useAppStore.getState().addGeoJsonLayer("A", emptyFC);
    const b = useAppStore.getState().addGeoJsonLayer("B", emptyFC);
    const c = useAppStore.getState().addGeoJsonLayer("C", emptyFC);
    const d = useAppStore.getState().addGeoJsonLayer("D", emptyFC);
    useAppStore.temporal.getState().clear();

    useAppStore.getState().moveLayersRelative([a, b], d, "above");

    assert.deepEqual(
      useAppStore.getState().layers.map((item) => item.id),
      [c, d, a, b],
    );
    assert.equal(useAppStore.temporal.getState().pastStates.length, 1);
  });

  it("reorders selected grouped layers as one block", () => {
    const a = useAppStore.getState().addGeoJsonLayer("A", emptyFC);
    const b = useAppStore.getState().addGeoJsonLayer("B", emptyFC);
    const c = useAppStore.getState().addGeoJsonLayer("C", emptyFC);
    const gid = useAppStore.getState().addLayerGroup("G", [a, b, c]);

    useAppStore.getState().moveLayersRelative([b, c], a, "below");

    assert.deepEqual(
      useAppStore.getState().layers.map((item) => item.id),
      [b, c, a],
    );
    assert.ok(useAppStore.getState().layers.every((item) => item.groupId === gid));
  });

  it("skips selected layers outside the target's group when reordering", () => {
    const a = useAppStore.getState().addGeoJsonLayer("A", emptyFC);
    const b = useAppStore.getState().addGeoJsonLayer("B", emptyFC);
    const c = useAppStore.getState().addGeoJsonLayer("C", emptyFC);
    const d = useAppStore.getState().addGeoJsonLayer("D", emptyFC);
    const gid = useAppStore.getState().addLayerGroup("G", [b, c]);

    // C belongs to G but A does not, so lifting C out of G's block would make
    // normalizeGroupContiguity drag the never-selected B along with it.
    useAppStore.getState().moveLayersRelative([c, d], a, "below");

    assert.deepEqual(
      useAppStore.getState().layers.map((item) => item.id),
      [d, a, b, c],
    );
    assert.deepEqual(
      useAppStore
        .getState()
        .layers.filter((item) => item.groupId === gid)
        .map((item) => item.id),
      [b, c],
    );
  });

  it("nests groups, rejects cycles, and promotes children when ungrouping", () => {
    const parent = useAppStore.getState().addLayerGroup("Parent");
    const child = useAppStore.getState().addLayerGroup("Child");
    const grandchild = useAppStore.getState().addLayerGroup("Grandchild");
    useAppStore.getState().moveLayerGroupToGroup(child, parent);
    useAppStore.getState().moveLayerGroupToGroup(grandchild, child);
    assert.equal(useAppStore.getState().layerGroups.find((g) => g.id === child)?.parentId, parent);
    assert.equal(
      useAppStore.getState().layerGroups.find((g) => g.id === grandchild)?.parentId,
      child,
    );

    useAppStore.getState().moveLayerGroupToGroup(parent, grandchild);
    assert.equal(
      useAppStore.getState().layerGroups.find((g) => g.id === parent)?.parentId,
      undefined,
    );

    useAppStore.getState().removeLayerGroup(child);
    assert.equal(
      useAppStore.getState().layerGroups.find((g) => g.id === grandchild)?.parentId,
      parent,
    );
  });

  it("deletes a nested group's full subtree and its layers", () => {
    const a = useAppStore.getState().addGeoJsonLayer("A", emptyFC);
    const b = useAppStore.getState().addGeoJsonLayer("B", emptyFC);
    const parent = useAppStore.getState().addLayerGroup("Parent", [a]);
    const child = useAppStore.getState().addLayerGroup("Child", [b]);
    useAppStore.getState().moveLayerGroupToGroup(child, parent);
    useAppStore.getState().removeLayerGroup(parent, { removeChildren: true });
    assert.equal(useAppStore.getState().layerGroups.length, 0);
    assert.equal(useAppStore.getState().layers.length, 0);
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

  it("reorders an organizer group using its descendant layer blocks", () => {
    const childLayer = useAppStore.getState().addGeoJsonLayer("Child", emptyFC);
    const neighbor = useAppStore.getState().addGeoJsonLayer("Neighbor", emptyFC);
    const parent = useAppStore.getState().addLayerGroup("Parent");
    const child = useAppStore.getState().addLayerGroup("Child group", [childLayer]);
    useAppStore.getState().moveLayerGroupToGroup(child, parent);

    useAppStore.getState().reorderLayerGroup(parent, "up");
    assert.deepEqual(
      useAppStore.getState().layers.map((candidate) => candidate.id),
      [neighbor, childLayer],
    );
  });

  it("keeps the group order when a group gains its first layer, and reorders empty groups (GeoLibre#1739)", () => {
    const g1 = useAppStore.getState().addLayerGroup("Group 1");
    const g2 = useAppStore.getState().addLayerGroup("Group 2");
    const order = () =>
      buildLayerPanelUnits(useAppStore.getState().layers, useAppStore.getState().layerGroups)
        .map((unit) => unit.groupId)
        .filter(Boolean);
    assert.deepEqual(order(), [g1, g2]);

    // Both folders are empty, and both must still be movable.
    useAppStore.getState().reorderLayerGroup(g2, "up");
    assert.deepEqual(order(), [g2, g1]);
    useAppStore.getState().reorderLayerGroup(g2, "down");
    assert.deepEqual(order(), [g1, g2]);

    // Adding a layer to Group 1 must not push it below the still-empty Group 2.
    const a = useAppStore.getState().addGeoJsonLayer("A", emptyFC);
    useAppStore.getState().moveLayerToGroup(a, g1);
    assert.deepEqual(order(), [g1, g2]);

    // And the now-populated group can still be moved past the empty one.
    useAppStore.getState().reorderLayerGroup(g1, "down");
    assert.deepEqual(order(), [g2, g1]);
  });

  it("undoes a reorder that only moved empty groups", () => {
    // Swapping two empty folders leaves `layers` untouched, so the history
    // entry rests entirely on the group order having changed.
    const g1 = useAppStore.getState().addLayerGroup("Group 1");
    const g2 = useAppStore.getState().addLayerGroup("Group 2");
    useAppStore.temporal.getState().clear();

    useAppStore.getState().reorderLayerGroup(g2, "up");
    assert.deepEqual(
      useAppStore.getState().layerGroups.map((group) => group.id),
      [g2, g1],
    );
    undo();
    assert.deepEqual(
      useAppStore.getState().layerGroups.map((group) => group.id),
      [g1, g2],
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
    const groups = [
      group("parent", { name: "Parent" }),
      group("g", { name: "Folder", parentId: "parent", opacity: 0.5 }),
    ];
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
    assert.equal(parsed.layerGroups?.length, 2);
    assert.equal(parsed.layerGroups?.[1].name, "Folder");
    assert.equal(parsed.layerGroups?.[1].parentId, "parent");
    assert.equal(parsed.layerGroups?.[1].opacity, 0.5);
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
