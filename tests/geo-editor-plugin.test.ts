import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GEO_EDITOR_PLUGIN_ID,
  hasMassingFeatures,
  maplibreGeoEditorPlugin as plugin,
  sketchesStyleForMassing,
} from "../packages/plugins/src/plugins/maplibre-geo-editor";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "../packages/core/src";

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
        features: [{ type: "Feature", properties: { height: 10 }, geometry: null }],
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
});
