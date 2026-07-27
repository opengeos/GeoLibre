import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fieldSourceInputName,
  isFieldParameterName,
} from "../apps/geolibre-desktop/src/lib/whitebox-field-params";

describe("isFieldParameterName", () => {
  it("matches the field/attribute suffixes tools use for a column name", () => {
    // points_to_line (GeoLibre#1459) plus the shapes seen across the catalog.
    for (const name of [
      "line_field",
      "sort_field",
      "field",
      "fields",
      "compare_fields",
      "attribute",
      "predictor_fields",
      "allowed_vehicle_profiles_field",
    ]) {
      assert.equal(isFieldParameterName(name), true, name);
    }
  });

  it("leaves parameters that only contain the word alone", () => {
    // A suffix match, not a substring one: these name something else entirely.
    for (const name of [
      "field_calculator_expression",
      "fieldwork",
      "spacing",
      "include_end",
      "output",
    ]) {
      assert.equal(isFieldParameterName(name), false, name);
    }
  });
});

describe("fieldSourceInputName", () => {
  it("resolves the input a prefixed field parameter names", () => {
    // align_features: `match_field` reads the `input` layer while
    // `target_match_field` reads `target`, so the longest prefix has to win.
    assert.equal(fieldSourceInputName("target_match_field", ["input", "target"]), "target");
    assert.equal(fieldSourceInputName("match_field", ["input", "target"]), undefined);
  });

  it("tolerates a plural input name", () => {
    // generate_od_links names its inputs `origins`/`destinations`.
    assert.equal(fieldSourceInputName("origin_id_field", ["origins", "destinations"]), "origins");
  });

  it("returns undefined when no input name lines up", () => {
    // detect_feature_changes: `compare_fields` names neither `update` nor
    // `base`, so the caller offers both layers' columns instead of guessing.
    assert.equal(fieldSourceInputName("compare_fields", ["update", "base"]), undefined);
    assert.equal(fieldSourceInputName("field", ["input", "barriers"]), undefined);
  });
});
