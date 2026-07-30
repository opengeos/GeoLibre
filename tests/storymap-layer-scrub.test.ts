import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  DEFAULT_LAYER_STYLE,
  DEFAULT_STORY_MAP,
  useAppStore,
  type GeoLibreLayer,
} from "@geolibre/core";

function geojsonLayer(id: string): GeoLibreLayer {
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
  };
}

describe("removeLayer storymap scrub", () => {
  beforeEach(() => {
    useAppStore.getState().newProject({ name: "Story scrub" });
  });

  it("drops chapter enter/exit rows that pointed at the removed layer", () => {
    const store = useAppStore.getState();
    store.addLayer(geojsonLayer("keep"));
    store.addLayer(geojsonLayer("gone"));
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
});
