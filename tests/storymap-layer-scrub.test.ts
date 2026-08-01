import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { DEFAULT_STORY_MAP, useAppStore } from "@geolibre/core";
import { geojsonLayer } from "./helpers/layer-fixtures";

describe("removeLayer storymap scrub", () => {
  beforeEach(() => {
    useAppStore.getState().newProject({ name: "Story scrub" });
  });

  it("drops chapter enter/exit rows that pointed at the removed layer", () => {
    const store = useAppStore.getState();
    store.addLayer(geojsonLayer({ id: "keep", name: "keep" }));
    store.addLayer(geojsonLayer({ id: "gone", name: "gone" }));
    store.setStorymap({
      ...DEFAULT_STORY_MAP,
      title: "Tour",
      chapters: [
        {
          id: "ch-1",
          title: "One",
          description: "",
          alignment: "left",
          hidden: false,
          location: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
          mapAnimation: "flyTo",
          rotateAnimation: false,
          onChapterEnter: [
            { layerId: "gone", opacity: 1 },
            { layerId: "keep", opacity: 0.5 },
          ],
          onChapterExit: [{ layerId: "gone", opacity: 0 }],
        },
      ],
    });

    useAppStore.getState().removeLayer("gone");
    const chapter = useAppStore.getState().storymap?.chapters[0];
    assert.deepEqual(chapter?.onChapterEnter, [{ layerId: "keep", opacity: 0.5 }]);
    assert.deepEqual(chapter?.onChapterExit, []);
    assert.equal(
      useAppStore.getState().layers.some((layer) => layer.id === "gone"),
      false,
    );
  });

  it("scrubs chapter refs when a group deletes its children", () => {
    const store = useAppStore.getState();
    const groupId = store.addLayerGroup("Tour group");
    store.addLayer({ ...geojsonLayer({ id: "keep", name: "keep" }), groupId: undefined });
    store.addLayer({ ...geojsonLayer({ id: "child-a", name: "child-a" }), groupId });
    store.addLayer({ ...geojsonLayer({ id: "child-b", name: "child-b" }), groupId });
    store.setStorymap({
      ...DEFAULT_STORY_MAP,
      title: "Tour",
      chapters: [
        {
          id: "ch-1",
          title: "One",
          description: "",
          alignment: "left",
          hidden: false,
          location: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
          mapAnimation: "flyTo",
          rotateAnimation: false,
          onChapterEnter: [
            { layerId: "child-a", opacity: 1 },
            { layerId: "keep", opacity: 0.5 },
            { layerId: "child-b", opacity: 0.2 },
          ],
          onChapterExit: [{ layerId: "child-a", opacity: 0 }],
        },
      ],
    });

    useAppStore.getState().removeLayerGroup(groupId, { removeChildren: true });
    const chapter = useAppStore.getState().storymap?.chapters[0];
    assert.deepEqual(chapter?.onChapterEnter, [{ layerId: "keep", opacity: 0.5 }]);
    assert.deepEqual(chapter?.onChapterExit, []);
    assert.equal(
      useAppStore
        .getState()
        .layers.some((layer) => layer.id === "child-a" || layer.id === "child-b"),
      false,
    );
  });

  it("clears secondary-pane visibility overrides for deleted group children", () => {
    const store = useAppStore.getState();
    const groupId = store.addLayerGroup("Tour group");
    store.addLayer({ ...geojsonLayer({ id: "child-a", name: "child-a" }), groupId });
    store.addLayer({ ...geojsonLayer({ id: "keep", name: "keep" }), groupId: undefined });
    store.setMapGrid(1, 2);
    const paneId = useAppStore.getState().secondaryMapViews[0].id;
    store.setSecondaryLayerVisibility(paneId, "child-a", false);
    store.setSecondaryLayerVisibility(paneId, "keep", true);

    useAppStore.getState().removeLayerGroup(groupId, { removeChildren: true });
    const pane = useAppStore.getState().secondaryMapViews.find((p) => p.id === paneId);
    assert.deepEqual(pane?.layerVisibility, { keep: true });
  });
});
