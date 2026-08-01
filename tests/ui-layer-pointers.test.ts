import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { useAppStore } from "@geolibre/core";
import { geojsonLayer } from "./helpers/layer-fixtures";

describe("UI layer pointer cleanup", () => {
  beforeEach(() => {
    useAppStore.getState().newProject({ name: "Pointer cleanup" });
  });

  describe("removeLayer clears dialog layer ids", () => {
    it("clears selectByExpressionLayerId", () => {
      const store = useAppStore.getState();
      store.addLayer(geojsonLayer({ id: "target" }));
      store.setSelectByExpressionOpen(true, "target");
      assert.equal(useAppStore.getState().ui.selectByExpressionLayerId, "target");

      useAppStore.getState().removeLayer("target");
      assert.equal(useAppStore.getState().ui.selectByExpressionLayerId, null);
    });

    it("clears selectByLocationLayerId", () => {
      const store = useAppStore.getState();
      store.addLayer(geojsonLayer({ id: "target" }));
      store.setSelectByLocationOpen(true, "target");
      assert.equal(useAppStore.getState().ui.selectByLocationLayerId, "target");

      useAppStore.getState().removeLayer("target");
      assert.equal(useAppStore.getState().ui.selectByLocationLayerId, null);
    });

    it("clears loadEditorFeaturesLayerId", () => {
      const store = useAppStore.getState();
      store.addLayer(geojsonLayer({ id: "target" }));
      store.setLoadEditorFeaturesOpen(true, "target");
      assert.equal(useAppStore.getState().ui.loadEditorFeaturesLayerId, "target");

      useAppStore.getState().removeLayer("target");
      assert.equal(useAppStore.getState().ui.loadEditorFeaturesLayerId, null);
    });

    it("does not clear pointers for unrelated layers", () => {
      const store = useAppStore.getState();
      store.addLayer(geojsonLayer({ id: "keep", name: "Keep" }));
      store.addLayer(geojsonLayer({ id: "gone", name: "Gone" }));
      store.setSelectByExpressionOpen(true, "keep");
      store.setSelectByLocationOpen(true, "keep");
      store.setLoadEditorFeaturesOpen(true, "keep");

      useAppStore.getState().removeLayer("gone");
      const ui = useAppStore.getState().ui;
      assert.equal(ui.selectByExpressionLayerId, "keep");
      assert.equal(ui.selectByLocationLayerId, "keep");
      assert.equal(ui.loadEditorFeaturesLayerId, "keep");
    });
  });

  describe("removeLayerGroup clears dialog layer ids", () => {
    it("clears pointers when group children are removed", () => {
      const store = useAppStore.getState();
      const groupId = store.addLayerGroup("G");
      store.addLayer(geojsonLayer({ id: "child", groupId }));
      store.setSelectByExpressionOpen(true, "child");
      store.setSelectByLocationOpen(true, "child");
      store.setLoadEditorFeaturesOpen(true, "child");

      useAppStore.getState().removeLayerGroup(groupId, { removeChildren: true });
      const ui = useAppStore.getState().ui;
      assert.equal(ui.selectByExpressionLayerId, null);
      assert.equal(ui.selectByLocationLayerId, null);
      assert.equal(ui.loadEditorFeaturesLayerId, null);
    });
  });

  describe("newProject/loadProject clear load-editor-features state", () => {
    it("newProject clears loadEditorFeaturesOpen and layerId", () => {
      const store = useAppStore.getState();
      store.addLayer(geojsonLayer({ id: "target" }));
      store.setLoadEditorFeaturesOpen(true, "target");
      assert.equal(useAppStore.getState().ui.loadEditorFeaturesOpen, true);

      useAppStore.getState().newProject();
      const ui = useAppStore.getState().ui;
      assert.equal(ui.loadEditorFeaturesOpen, false);
      assert.equal(ui.loadEditorFeaturesLayerId, null);
    });

    it("loadProject clears loadEditorFeaturesOpen and layerId", () => {
      const store = useAppStore.getState();
      store.addLayer(geojsonLayer({ id: "target" }));
      store.setLoadEditorFeaturesOpen(true, "target");
      assert.equal(useAppStore.getState().ui.loadEditorFeaturesOpen, true);

      useAppStore.getState().loadProject({ name: "Loaded", layers: [], version: 1 });
      const ui = useAppStore.getState().ui;
      assert.equal(ui.loadEditorFeaturesOpen, false);
      assert.equal(ui.loadEditorFeaturesLayerId, null);
    });
  });
});
