/**
 * Pins the undo-history boundary of the app store after its split into slices
 * (`packages/core/src/store/`): project data stays undoable exactly as before,
 * while the `ui` dialog/panel sub-state (and the other session-only fields)
 * never records an undo step and is never reverted by undo/redo.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { setHistoryCoalesceMs } from "../packages/core/src/history";
import { type AppState, redo, undo, useAppStore } from "../packages/core/src/store";
import { partializeHistory } from "../packages/core/src/store/undo-history";
import {
  DEFAULT_STORY_MAP,
  type ProcessingRerunRequest,
  type ProjectComment,
} from "../packages/core/src/types";

const emptyFC = { type: "FeatureCollection" as const, features: [] };

function pastLen(): number {
  return useAppStore.temporal.getState().pastStates.length;
}

function futureLen(): number {
  return useAppStore.temporal.getState().futureStates.length;
}

function store(): AppState {
  return useAppStore.getState();
}

/**
 * One call per `ui` setter, each moving its flag away from the default. The
 * layer id argument is the layer the test adds, for the setters that preselect
 * a target layer.
 */
function uiSetterCalls(layerId: string): Array<[string, () => void]> {
  const rerun: ProcessingRerunRequest = { kind: "vector", toolId: "buffer", parameters: {} };
  return [
    ["setProcessingOpen", () => store().setProcessingOpen(true)],
    ["setProcessingInitialTool", () => store().setProcessingInitialTool("slope")],
    ["setConversionOpen", () => store().setConversionOpen("vector-to-vector")],
    ["setVectorToolOpen", () => store().setVectorToolOpen("buffer")],
    ["setNetworkToolOpen", () => store().setNetworkToolOpen("isochrone")],
    ["setStatisticsToolOpen", () => store().setStatisticsToolOpen("global-morans-i")],
    ["setRasterToolOpen", () => store().setRasterToolOpen("hillshade")],
    ["setSegmentationOpen", () => store().setSegmentationOpen(true)],
    ["setObjectDetectionOpen", () => store().setObjectDetectionOpen(true)],
    ["setSegmentEverythingOpen", () => store().setSegmentEverythingOpen(true)],
    ["setGeocodeOpen", () => store().setGeocodeOpen(true)],
    ["setSqlWorkspaceOpen", () => store().setSqlWorkspaceOpen(true)],
    ["setLoadEditorFeaturesOpen", () => store().setLoadEditorFeaturesOpen(true, layerId)],
    ["setPythonConsoleOpen", () => store().setPythonConsoleOpen(true)],
    ["setNotebookOpen", () => store().setNotebookOpen(true)],
    ["setAssistantOpen", () => store().setAssistantOpen(true)],
    ["setAttributeTableOpen", () => store().setAttributeTableOpen(true)],
    ["setRasterAttributeTableOpen", () => store().setRasterAttributeTableOpen(true)],
    ["setDashboardOpen", () => store().setDashboardOpen(true)],
    ["setStorymapPanelOpen", () => store().setStorymapPanelOpen(true)],
    ["setStorymapPresenting", () => store().setStorymapPresenting(true, true)],
    ["setStorymapLayerOpacity", () => store().setStorymapLayerOpacity({ [layerId]: 0.25 })],
    ["setStorymapComposing", () => store().setStorymapComposing("chapter-1")],
    ["setBatchToolsOpen", () => store().setBatchToolsOpen(true)],
    ["setModelBuilderOpen", () => store().setModelBuilderOpen(true)],
    ["setModelBuilderRequestedModelId", () => store().setModelBuilderRequestedModelId("m-1")],
    ["setStyleManagerOpen", () => store().setStyleManagerOpen(true)],
    ["setProcessingHistoryOpen", () => store().setProcessingHistoryOpen(true)],
    ["setSelectByExpressionOpen", () => store().setSelectByExpressionOpen(true, layerId)],
    ["setSelectByLocationOpen", () => store().setSelectByLocationOpen(true, layerId)],
    ["setProcessingRerun", () => store().setProcessingRerun(rerun)],
    ["setZoomToSelectedFeature", () => store().setZoomToSelectedFeature(true)],
    ["setCollaborateDialogOpen", () => store().setCollaborateDialogOpen(true)],
  ];
}

describe("app store undo history after the slice split", () => {
  let layerId: string;

  beforeEach(() => {
    setHistoryCoalesceMs(0);
    store().newProject({ name: "slices" });
    layerId = store().addGeoJsonLayer("A", emptyFC);
    useAppStore.temporal.getState().clear();
  });

  it("undoes and redoes a layer opacity edit", () => {
    store().setLayerOpacity(layerId, 0.3);
    assert.equal(pastLen(), 1);
    undo();
    assert.equal(store().layers[0].opacity, 1);
    assert.equal(futureLen(), 1);
    redo();
    assert.equal(store().layers[0].opacity, 0.3);
    assert.equal(pastLen(), 1);
  });

  it("tracks no `ui` field in the history snapshot", () => {
    const snapshot = partializeHistory(store());
    assert.equal("ui" in snapshot, false);
    assert.deepEqual(Object.keys(snapshot).sort(), [
      "basemapOpacity",
      "basemapStyleUrl",
      "basemapVisible",
      "blankBackgroundColor",
      "comments",
      "layerGroups",
      "layers",
      "storymap",
    ]);
  });

  it("records no undo step for any dialog or panel flag", () => {
    const touched = new Set<string>();
    for (const [name, call] of uiSetterCalls(layerId)) {
      const before = store().ui;
      call();
      const after = store().ui;
      assert.notEqual(after, before, `${name} did not change ui`);
      for (const key of Object.keys(after) as (keyof AppState["ui"])[]) {
        if (after[key] !== before[key]) touched.add(key);
      }
      assert.equal(pastLen(), 0, `${name} recorded an undo step`);
    }
    // Every ui field is exercised, so a flag added later is covered too.
    assert.deepEqual([...touched].sort(), Object.keys(store().ui).sort());
  });

  it("never reverts dialog state on undo or redo", () => {
    store().setLayerOpacity(layerId, 0.3);
    for (const [, call] of uiSetterCalls(layerId)) call();
    const openUi = store().ui;
    assert.equal(openUi.vectorToolOpen, "buffer");
    assert.equal(openUi.sqlWorkspaceOpen, true);
    assert.equal(pastLen(), 1); // only the opacity edit

    undo(); // reverts the opacity edit, not the dialogs
    assert.equal(store().layers[0].opacity, 1);
    assert.equal(store().ui, openUi);

    redo();
    assert.equal(store().layers[0].opacity, 0.3);
    assert.equal(store().ui, openUi);

    // Closing a dialog is not an undo step either, and undo skips past it.
    store().setVectorToolOpen(null);
    store().setSqlWorkspaceOpen(false);
    assert.equal(pastLen(), 1);
    undo();
    assert.equal(store().layers[0].opacity, 1);
    assert.equal(store().ui.vectorToolOpen, null);
    assert.equal(store().ui.sqlWorkspaceOpen, false);
  });

  it("keeps the other tracked fields undoable", () => {
    const groupId = store().addLayerGroup("G");
    store().renameLayerGroup(groupId, "Renamed");
    store().setBasemapVisible(false);
    store().setBlankBackgroundColor("#112233");
    store().setStorymap({ ...DEFAULT_STORY_MAP, title: "Story" });
    store().addComment({
      id: "c-1",
      anchor: { type: "point", lngLat: [0, 0] },
      author: { name: "Tester", color: "#ff0000" },
      body: "note",
      createdAt: "2026-01-01T00:00:00.000Z",
      resolved: false,
      replies: [],
    } satisfies ProjectComment);
    assert.equal(pastLen(), 6);

    undo();
    assert.deepEqual(store().comments, []);
    undo();
    assert.equal(store().storymap, null);
    undo();
    assert.equal(store().blankBackgroundColor, null);
    undo();
    assert.equal(store().basemapVisible, true);
    undo();
    assert.equal(store().layerGroups[0].name, "G");
    undo();
    assert.deepEqual(store().layerGroups, []);

    for (let i = 0; i < 6; i++) redo();
    assert.equal(store().layerGroups[0].name, "Renamed");
    assert.equal(store().basemapVisible, false);
    assert.equal(store().blankBackgroundColor, "#112233");
    assert.equal(store().storymap?.title, "Story");
    assert.equal(store().comments.length, 1);
  });

  it("keeps untracked project and session fields out of the history", () => {
    const groupId = store().addLayerGroup("G");
    useAppStore.temporal.getState().clear();

    store().toggleLayerGroupCollapsed(groupId);
    store().setMapView({ zoom: 9 });
    store().setPreferences({ ...store().preferences });
    store().setLegend({ ...store().legend });
    store().setProjectName("Renamed project");
    store().setDashboardColumns(3);
    store().selectLayer(layerId);
    store().selectFeatures(["f-1", "f-2"]);
    store().setIdentifyLayer(layerId);
    store().setPointerCoords([1, 2]);
    store().setCollaboration({ selfName: "Tester" });
    store().setAppRole("viewer");
    assert.equal(pastLen(), 0);
  });
});
