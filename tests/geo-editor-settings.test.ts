import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createEmptyProject,
  normalizeGeoEditorSettings,
  parseProject,
  serializeProject,
} from "@geolibre/core";
import { useAppStore } from "../packages/core/src/store";
import { getGeoEditorOptions } from "../packages/plugins/src/plugins/maplibre-geo-editor";

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
