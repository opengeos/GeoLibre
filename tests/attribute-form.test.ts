import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_BASEMAP,
  DEFAULT_LAYER_STYLE,
  coerceAttributeFormValue,
  createEmptyProject,
  getAttributeFormField,
  attributeFormFieldLabel,
  isAttributeFormFieldVisible,
  parseProject,
  parseValueMapText,
  projectFromStore,
  serializeProject,
  validateAttributeFormField,
  validateAttributeFormValues,
  valueMapLabelFor,
  valueMapToText,
  type AttributeFormConfig,
  type AttributeFormFieldConfig,
  type GeoLibreLayer,
} from "@geolibre/core";
import { buildPropertiesWithForm } from "../apps/geolibre-desktop/src/lib/field-collection";

function fieldConfig(patch: Partial<AttributeFormFieldConfig> = {}): AttributeFormFieldConfig {
  return { field: "population", widget: "number", ...patch };
}

describe("value map text parsing", () => {
  it("parses value=label lines, bare values, and drops blanks/duplicates", () => {
    const entries = parseValueMapText(
      "residential=Residential\n\ncommercial\nresidential=Again\n  park = City Park  ",
    );
    assert.deepEqual(entries, [
      { value: "residential", label: "Residential" },
      { value: "commercial" },
      { value: "park", label: "City Park" },
    ]);
  });

  it("round-trips through valueMapToText", () => {
    const text = "a=Alpha\nb\nc=Gamma";
    assert.equal(valueMapToText(parseValueMapText(text)), text);
  });

  it("omits labels identical to the value", () => {
    assert.deepEqual(parseValueMapText("a=a"), [{ value: "a" }]);
    assert.equal(valueMapToText([{ value: "a", label: "a" }]), "a");
  });

  it("resolves display labels for stored values", () => {
    const config = fieldConfig({
      widget: "valueMap",
      valueMap: [{ value: "res", label: "Residential" }, { value: "com" }],
    });
    assert.equal(valueMapLabelFor(config, "res"), "Residential");
    assert.equal(valueMapLabelFor(config, "com"), "com");
    assert.equal(valueMapLabelFor(config, "unknown"), "unknown");
    assert.equal(valueMapLabelFor(config, null), "");
  });
});

describe("widget value coercion", () => {
  it("coerces number and range widgets to numbers", () => {
    assert.equal(coerceAttributeFormValue(fieldConfig(), "42"), 42);
    assert.equal(coerceAttributeFormValue(fieldConfig({ widget: "range" }), "3.5"), 3.5);
  });

  it("keeps an unparsable numeric string verbatim so validation can flag it", () => {
    assert.equal(coerceAttributeFormValue(fieldConfig(), "abc"), "abc");
  });

  it("coerces checkbox strings to booleans", () => {
    const config = fieldConfig({ widget: "checkbox" });
    assert.equal(coerceAttributeFormValue(config, "true"), true);
    assert.equal(coerceAttributeFormValue(config, "false"), false);
    assert.equal(coerceAttributeFormValue(config, ""), null);
  });

  it("stores value-map selections as numbers when every entry is numeric", () => {
    const numeric = fieldConfig({
      field: "zone_code",
      widget: "valueMap",
      valueMap: [{ value: "1", label: "Residential" }, { value: "2" }],
    });
    // All-numeric codes keep the property numerically typed, so edited rows
    // stay consistent with untouched rows.
    assert.equal(coerceAttributeFormValue(numeric, "1"), 1);
    const mixed = fieldConfig({
      field: "zone",
      widget: "valueMap",
      valueMap: [{ value: "1" }, { value: "res" }],
    });
    assert.equal(coerceAttributeFormValue(mixed, "1"), "1");
    // Zero-padded codes are identifiers, not numbers: they stay strings so a
    // listed selection ("01") keeps matching its entry in validation.
    const padded = fieldConfig({
      field: "fips",
      widget: "valueMap",
      valueMap: [{ value: "01" }, { value: "02" }],
    });
    assert.equal(coerceAttributeFormValue(padded, "01"), "01");
    assert.equal(
      validateAttributeFormField(padded, {
        fips: coerceAttributeFormValue(padded, "01"),
      }),
      null,
    );
  });

  it("stores text and date strings trimmed, empty as null", () => {
    const config = fieldConfig({ widget: "text" });
    assert.equal(coerceAttributeFormValue(config, "  hi  "), "hi");
    assert.equal(coerceAttributeFormValue(config, "   "), null);
    assert.equal(
      coerceAttributeFormValue(fieldConfig({ widget: "date" }), "2026-07-18"),
      "2026-07-18",
    );
  });
});

describe("field validation", () => {
  it("flags a missing required value", () => {
    const config = fieldConfig({ required: true });
    assert.deepEqual(validateAttributeFormField(config, {}), {
      code: "required",
    });
    assert.deepEqual(validateAttributeFormField(config, { population: "" }), {
      code: "required",
    });
    assert.equal(validateAttributeFormField(config, { population: 5 }), null);
  });

  it("does not require a value for checkbox widgets (unchecked is valid)", () => {
    const config = fieldConfig({
      field: "verified",
      widget: "checkbox",
      required: true,
    });
    assert.equal(validateAttributeFormField(config, {}), null);
    assert.equal(validateAttributeFormField(config, { verified: false }), null);
  });

  it("flags non-numeric values under number widgets", () => {
    assert.deepEqual(validateAttributeFormField(fieldConfig(), { population: "abc" }), {
      code: "number",
    });
  });

  it("enforces min/max bounds, including one-sided bounds", () => {
    const bounded = fieldConfig({ min: 0, max: 100 });
    assert.equal(validateAttributeFormField(bounded, { population: 50 }), null);
    assert.deepEqual(validateAttributeFormField(bounded, { population: -1 }), {
      code: "range",
      min: 0,
      max: 100,
    });
    const minOnly = fieldConfig({ min: 10 });
    assert.deepEqual(validateAttributeFormField(minOnly, { population: 5 }), {
      code: "range",
      min: 10,
      max: undefined,
    });
  });

  it("enforces value-map membership", () => {
    const config = fieldConfig({
      field: "zone",
      widget: "valueMap",
      valueMap: [{ value: "res" }, { value: "com" }],
    });
    assert.equal(validateAttributeFormField(config, { zone: "res" }), null);
    assert.deepEqual(validateAttributeFormField(config, { zone: "ind" }), {
      code: "valueMap",
    });
    // Empty is allowed unless required.
    assert.equal(validateAttributeFormField(config, {}), null);
  });

  it("evaluates constraint expressions against the candidate record", () => {
    const config = fieldConfig({
      constraintExpression: '[">", ["get", "population"], 0]',
      constraintDescription: "population must be > 0",
    });
    assert.equal(validateAttributeFormField(config, { population: 10 }), null);
    assert.deepEqual(validateAttributeFormField(config, { population: -5 }), {
      code: "constraint",
      message: "population must be > 0",
    });
  });

  it("supports cross-field constraints", () => {
    const config = fieldConfig({
      field: "max_height",
      constraintExpression: '[">=", ["get", "max_height"], ["get", "min_height"]]',
    });
    assert.equal(validateAttributeFormField(config, { max_height: 10, min_height: 2 }), null);
    assert.equal(
      validateAttributeFormField(config, { max_height: 1, min_height: 2 })?.code,
      "constraint",
    );
  });

  it("rejects when the constraint expression cannot be evaluated", () => {
    const config = fieldConfig({
      constraintExpression: '["nonsense-operator", 1]',
    });
    const error = validateAttributeFormField(config, { population: 1 });
    assert.equal(error?.code, "constraint");
    assert.ok(error?.message);
  });
});

describe("conditional visibility", () => {
  const config = fieldConfig({
    field: "school_name",
    widget: "text",
    visibilityExpression: '["==", ["get", "type"], "school"]',
  });

  it("shows and hides based on the expression", () => {
    assert.equal(isAttributeFormFieldVisible(config, { type: "school" }), true);
    assert.equal(isAttributeFormFieldVisible(config, { type: "park" }), false);
  });

  it("fails open on empty or broken expressions", () => {
    assert.equal(isAttributeFormFieldVisible(fieldConfig(), { type: "park" }), true);
    assert.equal(
      isAttributeFormFieldVisible(fieldConfig({ visibilityExpression: "not json" }), {}),
      true,
    );
  });

  it("skips hidden fields during whole-record validation", () => {
    const form: AttributeFormConfig = {
      fields: [
        fieldConfig({
          field: "school_name",
          widget: "text",
          required: true,
          visibilityExpression: '["==", ["get", "type"], "school"]',
        }),
      ],
    };
    // Hidden (type != school): the missing required value does not block.
    assert.equal(validateAttributeFormValues(form, { type: "park" }).ok, true);
    // Visible: it does.
    const visible = validateAttributeFormValues(form, { type: "school" });
    assert.equal(visible.ok, false);
    assert.equal(visible.errors.school_name?.code, "required");
  });
});

describe("form config helpers", () => {
  it("looks up field configs and display labels", () => {
    const form: AttributeFormConfig = {
      fields: [fieldConfig({ alias: "Population (2020)" })],
    };
    assert.equal(getAttributeFormField(form, "population")?.alias, "Population (2020)");
    assert.equal(getAttributeFormField(form, "other"), undefined);
    assert.equal(getAttributeFormField(undefined, "population"), undefined);
    assert.equal(attributeFormFieldLabel(fieldConfig({ alias: " " })), "population");
    assert.equal(attributeFormFieldLabel(fieldConfig({ alias: "Pop" })), "Pop");
  });
});

describe("field collection integration", () => {
  it("buildPropertiesWithForm coerces configured fields by widget", () => {
    const schema = {
      fields: [
        { key: "count", label: "Count", type: "text" as const },
        { key: "active", label: "Active", type: "text" as const },
        { key: "note", label: "Note", type: "text" as const },
      ],
    };
    const form: AttributeFormConfig = {
      fields: [
        { field: "count", widget: "number" },
        { field: "active", widget: "checkbox" },
      ],
    };
    const props = buildPropertiesWithForm(
      schema,
      { count: "7", active: "true", note: "hi" },
      form,
      { extra: 1 },
    );
    assert.deepEqual(props, { count: 7, active: true, note: "hi", extra: 1 });
  });
});

describe("project persistence", () => {
  it("round-trips a layer's attributeForm through save and load", () => {
    const attributeForm: AttributeFormConfig = {
      fields: [
        {
          field: "zone",
          widget: "valueMap",
          alias: "Zoning",
          required: true,
          valueMap: [{ value: "res", label: "Residential" }],
          constraintExpression: '["!=", ["get", "zone"], "banned"]',
          constraintDescription: "no banned zones",
          visibilityExpression: '["==", ["get", "kind"], "parcel"]',
        },
        { field: "height", widget: "range", min: 0, max: 300, step: 5 },
      ],
    };
    const layer: GeoLibreLayer = {
      id: "layer-a",
      name: "Layer A",
      type: "geojson",
      source: { type: "geojson" },
      visible: true,
      opacity: 1,
      style: { ...DEFAULT_LAYER_STYLE },
      metadata: {},
      geojson: { type: "FeatureCollection", features: [] },
      attributeForm,
    };
    const project = projectFromStore({
      projectName: "Forms",
      mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
      basemapStyleUrl: DEFAULT_BASEMAP,
      basemapVisible: true,
      basemapOpacity: 1,
      layers: [layer],
      preferences: createEmptyProject().preferences,
      metadata: {},
    });
    assert.deepEqual(project.layers[0]?.attributeForm, attributeForm);
    const reparsed = parseProject(serializeProject(project));
    assert.deepEqual(reparsed.layers[0]?.attributeForm, attributeForm);
  });
});
