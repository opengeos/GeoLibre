import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  evaluateLayerDragActivation,
  filterTouchMenuItems,
  LAYER_MOUSE_DRAG_THRESHOLD_PX,
  LAYER_TOUCH_DRAG_HOLD_MS,
  LAYER_TOUCH_DRAG_SCROLL_TOLERANCE_PX,
  pruneEmptyTouchMenuItems,
  resolveTouchMenuPage,
  type TouchMenuItem,
} from "../apps/geolibre-desktop/src/lib/touch-menu-nav";

const noop = () => {};

const SAMPLE_TREE: TouchMenuItem[] = [
  {
    kind: "section",
    id: "project",
    label: "Project",
    items: [
      { kind: "action", id: "save", label: "Save project", onSelect: noop },
      {
        kind: "submenu",
        id: "export",
        label: "Export",
        items: [
          {
            kind: "action",
            id: "export-geojson",
            label: "GeoJSON",
            keywords: "vector json",
            onSelect: noop,
          },
          {
            kind: "action",
            id: "export-gpkg",
            label: "GeoPackage",
            description: "SQLite spatial archive",
            onSelect: noop,
          },
        ],
      },
    ],
  },
  {
    kind: "section",
    id: "empty-section",
    label: "Empty",
    items: [
      {
        kind: "submenu",
        id: "empty-submenu",
        label: "Empty submenu",
        items: [],
      },
    ],
  },
];

describe("touch drill-down menu navigation", () => {
  it("prunes empty sections and submenus recursively", () => {
    const pruned = pruneEmptyTouchMenuItems(SAMPLE_TREE);
    assert.equal(pruned.length, 1);
    assert.equal(pruned[0].id, "project");
  });

  it("resolves nested submenus and clamps stale path segments", () => {
    const root = resolveTouchMenuPage("Menu", SAMPLE_TREE, []);
    assert.equal(root.title, "Menu");
    assert.equal(root.parentTitle, null);
    assert.deepEqual(root.path, []);

    const sub = resolveTouchMenuPage("Menu", SAMPLE_TREE, ["export"]);
    assert.equal(sub.title, "Export");
    assert.equal(sub.parentTitle, "Menu");
    assert.deepEqual(sub.path, ["export"]);
    assert.equal(sub.items.length, 2);

    const clamped = resolveTouchMenuPage("Menu", SAMPLE_TREE, ["export", "missing-child"]);
    assert.equal(clamped.title, "Export");
    assert.deepEqual(clamped.path, ["export"]);
  });

  it("searches across nested actions by label, description, keywords, and trail", () => {
    const byKeyword = filterTouchMenuItems(SAMPLE_TREE, "vector");
    assert.equal(byKeyword.length, 1);
    assert.equal(byKeyword[0].item.id, "export-geojson");
    assert.deepEqual(byKeyword[0].trail, ["Project", "Export"]);

    const byTrailAndDesc = filterTouchMenuItems(SAMPLE_TREE, "export sqlite");
    assert.equal(byTrailAndDesc.length, 1);
    assert.equal(byTrailAndDesc[0].item.id, "export-gpkg");

    assert.deepEqual(filterTouchMenuItems(SAMPLE_TREE, "   "), []);
  });
});

describe("touch-safe layer drag activation", () => {
  it("activates mouse drags immediately past the distance threshold", () => {
    assert.equal(
      evaluateLayerDragActivation({
        pointerType: "mouse",
        distancePx: LAYER_MOUSE_DRAG_THRESHOLD_PX - 1,
        elapsedMs: 0,
      }),
      "pending",
    );
    assert.equal(
      evaluateLayerDragActivation({
        pointerType: "mouse",
        distancePx: LAYER_MOUSE_DRAG_THRESHOLD_PX,
        elapsedMs: 0,
      }),
      "activate",
    );
  });

  it("requires a brief hold on touch and yields to scrolling when moving early", () => {
    assert.equal(
      evaluateLayerDragActivation({
        pointerType: "touch",
        distancePx: 3,
        elapsedMs: LAYER_TOUCH_DRAG_HOLD_MS - 10,
      }),
      "pending",
    );
    assert.equal(
      evaluateLayerDragActivation({
        pointerType: "touch",
        distancePx: LAYER_TOUCH_DRAG_SCROLL_TOLERANCE_PX + 2,
        elapsedMs: 40,
      }),
      "cancel",
    );
    assert.equal(
      evaluateLayerDragActivation({
        pointerType: "touch",
        distancePx: 2,
        elapsedMs: LAYER_TOUCH_DRAG_HOLD_MS,
      }),
      "activate",
    );
  });
});
