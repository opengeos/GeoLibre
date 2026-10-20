import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Feature, FeatureCollection } from "geojson";
import {
  GEO_EDITOR_PLUGIN_ID,
  getGeoEditorOptions,
  hasMassingFeatures,
  isGeomanCommittedDisplayLayer,
  maplibreGeoEditorPlugin as plugin,
  setGeoEditorFileTools,
  sketchesStyleForMassing,
  withCreatedSketch,
  withoutSupersededSketchCopies,
} from "../packages/plugins/src/plugins/maplibre-geo-editor";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "../packages/core/src";
import { NULL_GEOMETRY } from "./helpers/null-geometry";

const polygon = (properties: Record<string, unknown>) => ({
  type: "Feature" as const,
  properties,
  geometry: {
    type: "Polygon" as const,
    coordinates: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
    ],
  },
});

const sketchesLayer = (): GeoLibreLayer => ({
  id: "sketches",
  name: "Sketches",
  type: "geojson",
  visible: true,
  opacity: 1,
  source: {},
  style: structuredClone(DEFAULT_LAYER_STYLE),
  metadata: {},
  geojson: { type: "FeatureCollection", features: [] },
});

describe("maplibreGeoEditorPlugin", () => {
  // The Layers panel toggle keys its active-state highlight on the exported
  // constant, so the two must never drift apart.
  it("has the exported id", () => {
    assert.equal(plugin.id, GEO_EDITOR_PLUGIN_ID);
  });

  it("only identifies polygons with a finite numeric height as massing", () => {
    assert.equal(hasMassingFeatures({ type: "FeatureCollection", features: [polygon({})] }), false);
    assert.equal(
      hasMassingFeatures({
        type: "FeatureCollection",
        features: [{ type: "Feature", properties: { height: 10 }, geometry: NULL_GEOMETRY }],
      }),
      false,
    );
    assert.equal(
      hasMassingFeatures({ type: "FeatureCollection", features: [polygon({ height: 10 })] }),
      true,
    );
    assert.equal(
      hasMassingFeatures({ type: "FeatureCollection", features: [polygon({ height: "10" })] }),
      true,
    );
    assert.equal(
      hasMassingFeatures({ type: "FeatureCollection", features: [polygon({ height: "ten" })] }),
      false,
    );
  });

  it("enables and then resets only the auto-managed massing style", () => {
    const layer = sketchesLayer();
    const massing = { type: "FeatureCollection" as const, features: [polygon({ height: 10 })] };
    const flat = { type: "FeatureCollection" as const, features: [polygon({})] };

    layer.style = sketchesStyleForMassing(layer, massing);
    assert.equal(layer.style.extrusionEnabled, true);
    assert.equal(layer.style.elevation3dEnabled, false);

    layer.style = sketchesStyleForMassing(layer, flat);
    assert.equal(layer.style.extrusionEnabled, false);
    assert.equal(layer.style.extrusionHeightExpression, "");

    layer.style = { ...layer.style, extrusionEnabled: true, extrusionHeightExpression: "custom" };
    assert.equal(sketchesStyleForMassing(layer, flat), layer.style);
  });

  it("keeps the auto-managed style off once the user switches the layer to 2D", () => {
    const layer = sketchesLayer();
    layer.id = "switched-to-2d";
    const massing = { type: "FeatureCollection" as const, features: [polygon({ height: 10 })] };

    layer.style = sketchesStyleForMassing(layer, massing);
    assert.equal(layer.style.extrusionEnabled, true);

    // The Style panel's 2D radio clears the flags but leaves the expression.
    layer.style = { ...layer.style, extrusionEnabled: false, elevation3dEnabled: false };
    assert.equal(sketchesStyleForMassing(layer, massing), layer.style);
  });

  it("only defers to a custom height expression that is actually rendering", () => {
    const massing = { type: "FeatureCollection" as const, features: [polygon({ height: 10 })] };

    // Advanced mode off: the expression is inert (`extrusionHeightValue` ignores
    // it), so massing may take the layer over.
    const stray = sketchesLayer();
    stray.id = "stray-expression";
    stray.style = {
      ...stray.style,
      extrusionEnabled: true,
      extrusionAdvancedStyleEnabled: false,
      extrusionHeightExpression: "custom",
    };
    assert.equal(
      sketchesStyleForMassing(stray, massing).extrusionHeightExpression !== "custom",
      true,
    );

    // Advanced mode on: the user's expression is driving the render, so it stands.
    const live = sketchesLayer();
    live.id = "live-expression";
    live.style = {
      ...live.style,
      extrusionEnabled: true,
      extrusionAdvancedStyleEnabled: true,
      extrusionHeightExpression: "custom",
    };
    assert.equal(sketchesStyleForMassing(live, massing), live.style);
  });

  // A massing draw hides only Geoman's committed-feature layers, so the extruded
  // Sketches layer is what the user sees while the transient aids keep drawing
  // the next footprint's rubber band.
  it("separates Geoman's committed layers from its transient drawing aids", () => {
    const layer = (id: string, source: string) =>
      ({ id, source, type: "fill" }) as unknown as Parameters<
        typeof isGeomanCommittedDisplayLayer
      >[0];

    assert.equal(
      isGeomanCommittedDisplayLayer(layer("gm_main-polygon__fill-layer-0", "gm_main")),
      true,
    );
    assert.equal(
      isGeomanCommittedDisplayLayer(layer("gm_temporary-polygon__fill-layer-0", "gm_temporary")),
      false,
    );
    assert.equal(
      isGeomanCommittedDisplayLayer(
        layer("gm_internal-vertex_marker__circle-layer-0", "gm_internal"),
      ),
      false,
    );
    assert.equal(
      isGeomanCommittedDisplayLayer(layer("layer-sketches-extrusion", "source-sketches")),
      false,
    );
  });

  it("keeps a manual 2D switch when the last massing feature is removed", () => {
    const layer = sketchesLayer();
    layer.id = "2d-then-emptied";
    // A pre-existing property-driven extrusion, so the snapshot has something to
    // restore that would visibly contradict the user's later choice.
    layer.style = { ...layer.style, extrusionEnabled: true, extrusionHeightProperty: "floors" };
    const massing = { type: "FeatureCollection" as const, features: [polygon({ height: 10 })] };
    const flat = { type: "FeatureCollection" as const, features: [polygon({})] };

    layer.style = sketchesStyleForMassing(layer, massing);
    layer.style = { ...layer.style, extrusionEnabled: false, elevation3dEnabled: false };

    assert.equal(sketchesStyleForMassing(layer, flat), layer.style);
  });

  it("restores the complete pre-massing extrusion style", () => {
    const layer = sketchesLayer();
    layer.id = "custom-before-massing";
    layer.style = {
      ...layer.style,
      elevation3dEnabled: true,
      extrusionHeightProperty: "floors",
    };
    const original = structuredClone(layer.style);
    const massing = { type: "FeatureCollection" as const, features: [polygon({ height: 10 })] };
    const flat = { type: "FeatureCollection" as const, features: [polygon({})] };

    layer.style = sketchesStyleForMassing(layer, massing);
    layer.style = sketchesStyleForMassing(layer, flat);
    assert.deepEqual(layer.style, original);
  });

  // The create callback's copy can lack the id Geoman gives the imported
  // feature; storing both would duplicate the new sketch, while a separate
  // sketch drawn on an existing one's coordinates must still be kept.
  it("adds a created sketch only when the editor read does not already hold it", () => {
    const geometry = { type: "Point" as const, coordinates: [1, 2] };
    const created = { type: "Feature" as const, properties: {}, geometry };
    const editorCopy = { ...created, id: "feature-1" };
    const other = {
      type: "Feature" as const,
      id: "feature-0",
      properties: {},
      geometry: { type: "Point" as const, coordinates: [5, 5] },
    };
    const collection = (...features: Feature[]): FeatureCollection => ({
      type: "FeatureCollection",
      features,
    });
    const stored = collection(other);

    // The read already has Geoman's copy: nothing to add.
    assert.deepEqual(withCreatedSketch(collection(other, editorCopy), created, stored).features, [
      other,
      editorCopy,
    ]);
    // The read lags behind the create: add the callback copy.
    assert.deepEqual(withCreatedSketch(collection(other), created, stored).features, [
      other,
      created,
    ]);
    // An older sketch already sits on the same coordinates and the read lags:
    // the new one is still added rather than mistaken for the old one.
    const older = { ...created, id: "feature-0" };
    assert.deepEqual(withCreatedSketch(collection(older), created, collection(older)).features, [
      older,
      created,
    ]);
  });

  // A sketch stored from the id-less callback copy while the read lagged must
  // give way to Geoman's id-bearing copy on the next merge, without dropping a
  // different sketch that sits on the same coordinates.
  it("drops a stored callback copy once the editor holds it under an id", () => {
    const collection = (...features: Feature[]): FeatureCollection => ({
      type: "FeatureCollection",
      features,
    });
    const geometry = { type: "Point" as const, coordinates: [1, 2] };
    const callbackCopy: Feature = { type: "Feature", properties: {}, geometry };
    const editorCopy: Feature = { ...callbackCopy, id: "feature-1" };
    const older: Feature = { ...callbackCopy, id: "feature-0" };

    assert.deepEqual(
      withoutSupersededSketchCopies(collection(older, callbackCopy), collection(older, editorCopy))
        .features,
      [older],
    );
    // The editor has not caught up yet: the stored copy stays.
    assert.deepEqual(
      withoutSupersededSketchCopies(collection(older, callbackCopy), collection(older)).features,
      [older, callbackCopy],
    );
  });
});

describe("geo-editor file tools", () => {
  it("shows the Open/Save buttons by default and drops them when switched off", () => {
    assert.deepEqual(getGeoEditorOptions(null).fileModes, ["open", "save"]);
    setGeoEditorFileTools(false);
    try {
      assert.deepEqual(getGeoEditorOptions(null).fileModes, []);
    } finally {
      setGeoEditorFileTools(true);
    }
    assert.deepEqual(getGeoEditorOptions(null).fileModes, ["open", "save"]);
  });
});
