import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { useAppStore, DEFAULT_LAYER_STYLE } from "@geolibre/core";
import {
  maplibreAnnotationsPlugin,
  ANNOTATIONS_SOURCE_KIND,
  pinFeature,
  stickyNoteFeature,
  placedImageFeature,
  updateElementProps,
  deleteElementById,
} from "../packages/plugins/src/plugins/maplibre-annotations";
import {
  registerRightPanel,
  getRightPanel,
  __resetRightPanelRegistryForTests,
} from "../packages/plugins/src/right-panel-registry";
import { LngLat } from "maplibre-gl";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

describe("Elements Panel & Map Elements", () => {
  beforeEach(() => {
    useAppStore.setState({ layers: [] });
    __resetRightPanelRegistryForTests();
  });

  it("registers the right panel on activate", () => {
    const mockApp: Partial<GeoLibreAppAPI> = {
      registerRightPanel,
      addMapControl: () => true,
      removeMapControl: () => {},
      getMap: () => null,
    };

    maplibreAnnotationsPlugin.activate(mockApp as GeoLibreAppAPI);
    const panel = getRightPanel("geolibre-elements-panel");
    assert.equal(panel !== undefined, true);
    assert.equal(panel?.title, "Elements");

    maplibreAnnotationsPlugin.deactivate(mockApp as GeoLibreAppAPI);
    assert.equal(getRightPanel("geolibre-elements-panel"), undefined);
  });

  it("creates and manages element properties in store", () => {
    const store = useAppStore.getState();
    store.addLayer({
      id: "annotation-layer-1",
      name: "Annotations",
      type: "geojson",
      source: { type: "geojson" },
      visible: true,
      opacity: 1,
      style: { ...DEFAULT_LAYER_STYLE, simpleStyleEnabled: true },
      metadata: { sourceKind: ANNOTATIONS_SOURCE_KIND },
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [10, 20] },
            properties: {
              annotationId: "elem-1",
              __annotation: "pin",
              title: "Pin Alpha",
              description: "First pin description",
              visible: true,
            },
          },
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [15, 25] },
            properties: {
              annotationId: "elem-2",
              __annotation: "sticky_note",
              title: "Note Beta",
              description: "Note body text",
              visible: true,
            },
          },
        ],
      },
    });

    const layer = useAppStore.getState().layers[0];
    assert.equal(layer.geojson?.features.length, 2);
    assert.equal(layer.geojson?.features[0].properties?.title, "Pin Alpha");
    assert.equal(layer.geojson?.features[1].properties?.title, "Note Beta");

    // Call updateElementProps to rename elem-1
    updateElementProps("elem-1", { title: "Renamed" });

    // Assert that the first feature reflects "Renamed", and the sibling feature is unchanged
    const updatedLayer = useAppStore.getState().layers[0];
    assert.equal(updatedLayer.geojson?.features[0].properties?.title, "Renamed");
    assert.equal(updatedLayer.geojson?.features[0].properties?.description, "First pin description");
    assert.equal(updatedLayer.geojson?.features[1].properties?.title, "Note Beta");
    assert.equal(updatedLayer.geojson?.features[1].properties?.description, "Note body text");
  });

  it("builds correct feature objects using pinFeature, stickyNoteFeature, placedImageFeature", () => {
    const pos = new LngLat(-122, 37);
    const pin = pinFeature(pos, "My Pin", "Pin description", "#ff0000");
    assert.equal(pin.geometry.type, "Point");
    assert.ok(pin.properties);
    assert.equal(pin.properties!.__annotation, "pin");
    assert.equal(pin.properties!.title, "My Pin");
    assert.equal(pin.properties!.description, "Pin description");
    assert.equal(pin.properties!.pinColor, "#ff0000");
    assert.equal(pin.properties!.text, "");

    const note = stickyNoteFeature(pos, "Hello world", "Sticky note title", "#00ff00");
    assert.equal(note.properties!.__annotation, "sticky_note");
    assert.equal(note.properties!.title, "Sticky note title");
    assert.equal(note.properties!.description, "Hello world");
    assert.equal(note.properties!.fill, "#00ff00");
    assert.equal(note.properties!.text, "");

    const img = placedImageFeature(pos, "https://example.com/img.png", "My Image");
    assert.equal(img.properties!.__annotation, "placed_image");
    assert.equal(img.properties!.imageUrl, "https://example.com/img.png");
    assert.equal(img.properties!.title, "My Image");
    assert.equal(img.properties!.text, "");
  });

  it("cascades visibility updates and deletion to image overlay layer in the store", () => {
    const store = useAppStore.getState();

    // 1. Add annotation tracking layer with a pinned extent image tracking feature.
    store.addLayer({
      id: "annotation-layer-1",
      name: "Annotations",
      type: "geojson",
      source: { type: "geojson" },
      visible: true,
      opacity: 1,
      style: { ...DEFAULT_LAYER_STYLE, simpleStyleEnabled: true },
      metadata: { sourceKind: ANNOTATIONS_SOURCE_KIND },
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [-122, 37] },
            properties: {
              annotationId: "extent-img-1",
              __annotation: "placed_image",
              title: "Extent Image 1",
              placementMode: "extent",
              overlayLayerId: "image-overlay-1",
              visible: true,
            },
          },
        ],
      },
    });

    // 2. Add the corresponding mock image overlay layer to the store.
    store.addLayer({
      id: "image-overlay-1",
      name: "Extent Image 1 Overlay",
      type: "image",
      source: { type: "image", url: "https://example.com/img.png", coordinates: [] },
      visible: true,
      opacity: 1,
      style: DEFAULT_LAYER_STYLE,
      metadata: {},
    });

    // Verify initial state.
    assert.equal(useAppStore.getState().layers.length, 2);
    assert.equal(
      useAppStore.getState().layers.find((l) => l.id === "image-overlay-1")?.visible,
      true,
    );

    // 3. Test visibility cascading.
    updateElementProps("extent-img-1", { visible: false });
    assert.equal(
      useAppStore.getState().layers.find((l) => l.id === "image-overlay-1")?.visible,
      false,
    );

    updateElementProps("extent-img-1", { visible: true });
    assert.equal(
      useAppStore.getState().layers.find((l) => l.id === "image-overlay-1")?.visible,
      true,
    );

    // 4. Test deletion cascading.
    deleteElementById("extent-img-1");
    // Verify both the overlay layer and tracking feature are removed.
    assert.equal(
      useAppStore.getState().layers.find((l) => l.id === "image-overlay-1"),
      undefined,
    );
    assert.equal(
      useAppStore.getState().layers.find((l) => l.id === "annotation-layer-1"),
      undefined,
    );
  });
});
