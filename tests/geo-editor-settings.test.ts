import type { Feature } from "geojson";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createEmptyProject,
  DEFAULT_GEO_EDITOR_SNAP_TOLERANCE_PX,
  DEFAULT_LAYER_STYLE,
  geoEditorSnapTolerancePx,
  normalizeGeoEditorSettings,
  parseProject,
  serializeProject,
} from "@geolibre/core";
import { useAppStore } from "../packages/core/src/store";
import {
  applyGeomanSnapTolerance,
  getGeoEditorOptions,
} from "../packages/plugins/src/plugins/maplibre-geo-editor";

describe("GeoEditor project settings", () => {
  it("keeps the existing height form and automatic popup by default", () => {
    assert.deepEqual(normalizeGeoEditorSettings(undefined), {
      showAfterDraw: true,
      fields: [{ name: "height", type: "number", geometry: "polygon" }],
    });
  });
  it("normalizes unsafe and duplicate field definitions while preserving an empty schema", () => {
    assert.deepEqual(normalizeGeoEditorSettings({ showAfterDraw: false, fields: [] }), {
      showAfterDraw: false,
      fields: [],
    });
    const settings = normalizeGeoEditorSettings({
      fields: [
        { name: " category ", label: " Category ", type: "string", geometry: "all" },
        { name: "category", type: "number", geometry: "polygon" },
        { name: "__gm_width", type: "number", geometry: "all" },
        { name: "__proto__", type: "string", geometry: "all" },
        { name: "constructor", type: "string", geometry: "all" },
        { name: "bad", type: "script", geometry: "all" },
        { name: 'bad"selector', type: "string", geometry: "all" },
        null,
      ],
    });
    assert.deepEqual(settings.fields, [
      { name: "category", label: "Category", type: "string", geometry: "all" },
    ]);
  });
  it("round-trips custom fields and popup preference through the project file", () => {
    const project = createEmptyProject("Drawing");
    project.preferences.map.geoEditor = {
      showAfterDraw: false,
      fields: [{ name: "category", label: "Category", type: "string", geometry: "all" }],
    };
    assert.deepEqual(
      parseProject(serializeProject(project)).preferences.map.geoEditor,
      project.preferences.map.geoEditor,
    );
  });
  it("clamps and round-trips the snapping tolerance", () => {
    assert.equal(geoEditorSnapTolerancePx(undefined), DEFAULT_GEO_EDITOR_SNAP_TOLERANCE_PX);
    assert.equal(geoEditorSnapTolerancePx({ snapTolerancePx: 0 }), 1);
    assert.equal(geoEditorSnapTolerancePx({ snapTolerancePx: 500 }), 100);
    assert.equal(geoEditorSnapTolerancePx({ snapTolerancePx: 7.6 }), 8);
    assert.equal(normalizeGeoEditorSettings({ snapTolerancePx: 250 }).snapTolerancePx, 100);
    assert.equal(normalizeGeoEditorSettings({ snapTolerancePx: "x" }).snapTolerancePx, undefined);
    const project = createEmptyProject("Snapping");
    project.preferences.map.geoEditor = { showAfterDraw: true, fields: [], snapTolerancePx: 30 };
    assert.equal(
      parseProject(serializeProject(project)).preferences.map.geoEditor?.snapTolerancePx,
      30,
    );
  });
  it("applies the snapping tolerance to a live Geoman instance", () => {
    const geoman = { options: { settings: { snapDistance: 18 } } };
    applyGeomanSnapTolerance(geoman as never, { snapTolerancePx: 40 });
    assert.equal(geoman.options.settings.snapDistance, 40);
    applyGeomanSnapTolerance(geoman as never, undefined);
    assert.equal(geoman.options.settings.snapDistance, DEFAULT_GEO_EDITOR_SNAP_TOLERANCE_PX);
    // No editor mounted: nothing to update, and no throw.
    applyGeomanSnapTolerance(null, { snapTolerancePx: 40 });
  });
  it("uses configured fields for their geometry scopes in the actual editor options", () => {
    const original = useAppStore.getState().preferences;
    try {
      useAppStore.setState({
        preferences: {
          ...original,
          map: {
            ...original.map,
            geoEditor: {
              showAfterDraw: true,
              fields: [
                { name: "category", label: "Category", type: "string", geometry: "all" },
                { name: "fill", type: "color", geometry: "polygon" },
                { name: "width", type: "number", geometry: "line" },
              ],
            },
          },
        },
      });
      const schema = getGeoEditorOptions(null).attributeSchema;
      assert.equal(schema?.common?.[0].name, "category");
      assert.equal(schema?.polygon?.[0].name, "fill");
      assert.equal(schema?.line?.[0].name, "width");
      assert.deepEqual(schema?.point, []);
    } finally {
      useAppStore.setState({ preferences: original });
    }
  });
});

it("includes existing public Sketches fields automatically while honoring configured overrides", () => {
  const originalState = useAppStore.getState();
  const original = { preferences: originalState.preferences, layers: originalState.layers };
  try {
    useAppStore.setState({
      preferences: {
        ...original.preferences,
        map: {
          ...original.preferences.map,
          geoEditor: {
            showAfterDraw: true,
            fields: [
              { name: "name", label: "Parcel name", type: "textarea", geometry: "polygon" },
              { name: "nested", type: "string", geometry: "all" },
              { name: "mixed", type: "textarea", geometry: "all" },
              { name: "items", type: "string", geometry: "all" },
            ],
          },
        },
      },
      layers: [
        {
          id: "sketches",
          name: "Sketches",
          type: "geojson",
          source: { type: "geojson" },
          visible: true,
          opacity: 1,
          style: { ...DEFAULT_LAYER_STYLE },
          metadata: { sourceKind: "geoeditor-sketches" },
          geojson: {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                geometry: { type: "Point", coordinates: [0, 0] },
                properties: {
                  name: "One",
                  stroke: "red",
                  active: true,
                  count: 2,
                  "Road name": "A",
                  __gm_id: "feature-1",
                  nested: { x: 1 },
                  items: [1, 2],
                  mixed: 1,
                },
              },
              {
                type: "Feature",
                geometry: { type: "Point", coordinates: [1, 1] },
                properties: { mixed: "text" },
              },
            ],
          },
        },
      ],
    });
    const options = getGeoEditorOptions(null);
    const schema = options.attributeSchema;
    for (const [before, after, expected] of [
      [null, null, null],
      [true, "false", false],
      [false, "true", true],
    ]) {
      const feature: Feature = {
        type: "Feature",
        geometry: { type: "Point", coordinates: [0, 0] },
        properties: { active: after },
      };
      options.onAttributeChange?.({
        feature,
        previousProperties: { active: before },
        newProperties: feature.properties,
        isNewFeature: false,
      });
      assert.equal(feature.properties?.active, expected);
    }
    assert.deepEqual(schema?.polygon?.[0], {
      name: "name",
      label: "Parcel name",
      type: "textarea",
    });
    assert.deepEqual(
      schema?.common?.map((field) => [field.name, field.type]),
      [
        ["stroke", "string"],
        ["active", "select"],
        ["count", "number"],
        ["Road name", "string"],
      ],
    );
  } finally {
    useAppStore.setState(original);
  }
});
