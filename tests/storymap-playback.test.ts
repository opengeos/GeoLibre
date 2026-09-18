import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  applyStoryLayerOpacity,
  createEmptyProject,
  DEFAULT_LAYER_STYLE,
  isStoryHiddenLayer,
  parseProject,
  serializeProject,
  storyLayerOpacityFactor,
  storyVisibleLayers,
  useAppStore,
  type GeoLibreLayer,
} from "../packages/core/src/index";

function layer(id: string, opacity = 1): GeoLibreLayer {
  return {
    id,
    name: id,
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    geojson: { type: "FeatureCollection", features: [] },
  };
}

describe("storymap playback helpers", () => {
  it("storyLayerOpacityFactor defaults to 1 and clamps recorded values", () => {
    assert.equal(storyLayerOpacityFactor(undefined, "a"), 1);
    assert.equal(storyLayerOpacityFactor({}, "a"), 1);
    assert.equal(storyLayerOpacityFactor({ a: 0.25 }, "a"), 0.25);
    assert.equal(storyLayerOpacityFactor({ a: 4 }, "a"), 1);
    assert.equal(storyLayerOpacityFactor({ a: -1 }, "a"), 0);
    assert.equal(storyLayerOpacityFactor({ a: Number.NaN }, "a"), 1);
  });

  it("applyStoryLayerOpacity replaces the store opacity and keeps identity when untouched", () => {
    const base = layer("a", 0.8);
    assert.equal(applyStoryLayerOpacity(base, {}), base);
    assert.equal(applyStoryLayerOpacity(base, { b: 0 }), base);
    // Same value as the layer already has: no copy needed.
    assert.equal(applyStoryLayerOpacity(base, { a: 0.8 }), base);
    const faded = applyStoryLayerOpacity(base, { a: 0.5 });
    assert.notEqual(faded, base);
    // Absolute, like the MapLibre paint path, not 0.8 x 0.5.
    assert.equal(faded.opacity, 0.5);
    // A chapter fading back to 1 also overrides a translucent base opacity.
    assert.equal(applyStoryLayerOpacity(base, { a: 1 }).opacity, 1);
    // The feature collection is shared, so FeatureCollection-keyed caches hit.
    assert.equal(faded.geojson, base.geojson);
  });

  it("isStoryHiddenLayer is true only for a full fade-out", () => {
    assert.equal(isStoryHiddenLayer({ a: 0 }, "a"), true);
    assert.equal(isStoryHiddenLayer({ a: 0.01 }, "a"), false);
    assert.equal(isStoryHiddenLayer({}, "a"), false);
  });

  it("storyVisibleLayers drops faded-out layers only while presenting", () => {
    const layers = [layer("a"), layer("b"), layer("c")];
    const opacities = { a: 0, b: 0.3 };
    assert.equal(storyVisibleLayers(layers, false, opacities), layers);
    assert.equal(storyVisibleLayers(layers, true, {}), layers);
    assert.deepEqual(
      storyVisibleLayers(layers, true, opacities).map((item) => item.id),
      ["b", "c"],
    );
  });
});

describe("store storymapLayerOpacity", () => {
  beforeEach(() => {
    useAppStore.getState().setStorymapPresenting(false);
  });

  it("merges chapter fades and clamps them", () => {
    const store = useAppStore.getState();
    store.setStorymapPresenting(true);
    store.setStorymapLayerOpacity({ a: 0, b: 2 });
    store.setStorymapLayerOpacity({ b: 0.5, c: -1 });
    assert.deepEqual(useAppStore.getState().ui.storymapLayerOpacity, { a: 0, b: 0.5, c: 0 });
  });

  it("keeps the record identity and stays silent when a write changes nothing", () => {
    const store = useAppStore.getState();
    store.setStorymapLayerOpacity({ a: 0.5 });
    const before = useAppStore.getState().ui.storymapLayerOpacity;
    let notifications = 0;
    const unsubscribe = useAppStore.subscribe(() => {
      notifications += 1;
    });
    try {
      store.setStorymapLayerOpacity({ a: 0.5 });
      store.setStorymapLayerOpacity({});
    } finally {
      unsubscribe();
    }
    assert.equal(useAppStore.getState().ui.storymapLayerOpacity, before);
    // Subscribers (the deck overlay, the Legend panel) must not rebuild for a
    // no-op write.
    assert.equal(notifications, 0);
  });

  it("resets when a presentation starts or ends", () => {
    const store = useAppStore.getState();
    store.setStorymapLayerOpacity({ a: 0 });
    store.setStorymapPresenting(true);
    assert.deepEqual(useAppStore.getState().ui.storymapLayerOpacity, {});
    store.setStorymapLayerOpacity({ a: 0 });
    store.setStorymapPresenting(false);
    assert.deepEqual(useAppStore.getState().ui.storymapLayerOpacity, {});
  });

  it("does not carry fades into a newly loaded project", () => {
    const store = useAppStore.getState();
    store.setStorymapLayerOpacity({ a: 0 });
    useAppStore.getState().loadProject(parseProject(serializeProject(createEmptyProject("Plain"))));
    assert.deepEqual(useAppStore.getState().ui.storymapLayerOpacity, {});
  });
});
