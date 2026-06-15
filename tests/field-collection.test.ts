import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendFeature,
  buildProperties,
  buildSchema,
  collectionMetadata,
  COLLECTION_SCHEMA_KEY,
  coerceValue,
  dataUrlByteLength,
  emptyFeatureCollection,
  FIELD_COLLECTION_FLAG,
  getSchema,
  isCollectionLayer,
  makePointFeature,
  parseOptions,
  PHOTO_PROPERTY,
  slugifyKey,
  validateForm,
} from "../apps/geolibre-desktop/src/lib/field-collection";

describe("slugifyKey", () => {
  it("slugifies labels to safe keys", () => {
    assert.equal(slugifyKey("Tree Species"), "tree_species");
    assert.equal(slugifyKey("  Height (m) "), "height_m");
    assert.equal(slugifyKey("123 Café!"), "123_caf");
  });

  it("falls back to 'field' for empty/symbol-only labels", () => {
    assert.equal(slugifyKey(""), "field");
    assert.equal(slugifyKey("!!!"), "field");
  });

  it("de-duplicates against taken keys", () => {
    assert.equal(slugifyKey("Name", ["name"]), "name_2");
    assert.equal(slugifyKey("Name", ["name", "name_2"]), "name_3");
  });
});

describe("buildSchema", () => {
  it("drops blank labels and assigns unique keys", () => {
    const schema = buildSchema([
      { label: "Name", type: "text" },
      { label: "", type: "text" },
      { label: "Name", type: "number" },
    ]);
    assert.deepEqual(
      schema.fields.map((f) => f.key),
      ["name", "name_2"],
    );
  });

  it("keeps required and choice options only where relevant", () => {
    const schema = buildSchema([
      { label: "Status", type: "choice", required: true, options: ["a", "b"] },
      { label: "Note", type: "text", required: false },
    ]);
    assert.deepEqual(schema.fields[0], {
      key: "status",
      label: "Status",
      type: "choice",
      required: true,
      options: ["a", "b"],
    });
    // Non-required text field carries neither `required` nor `options`.
    assert.deepEqual(schema.fields[1], {
      key: "note",
      label: "Note",
      type: "text",
    });
  });
});

describe("parseOptions", () => {
  it("trims, drops blanks, and de-duplicates", () => {
    assert.deepEqual(parseOptions(" a, b ,a, ,c"), ["a", "b", "c"]);
    assert.deepEqual(parseOptions(""), []);
  });
});

describe("coerceValue", () => {
  it("returns null for blank input", () => {
    assert.equal(coerceValue("text", "  "), null);
    assert.equal(coerceValue("number", ""), null);
  });

  it("parses numbers and rejects non-numeric", () => {
    assert.equal(coerceValue("number", "42"), 42);
    assert.equal(coerceValue("number", "-3.5"), -3.5);
    assert.equal(coerceValue("number", "abc"), null);
  });

  it("keeps text/date/choice verbatim (trimmed)", () => {
    assert.equal(coerceValue("text", "  hi "), "hi");
    assert.equal(coerceValue("date", "2026-06-15"), "2026-06-15");
    assert.equal(coerceValue("choice", "b"), "b");
  });
});

describe("validateForm", () => {
  const schema = buildSchema([
    { label: "Name", type: "text", required: true },
    { label: "Count", type: "number" },
    { label: "Status", type: "choice", options: ["open", "closed"] },
  ]);

  it("passes a valid form", () => {
    const r = validateForm(schema, {
      name: "Oak",
      count: "3",
      status: "open",
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.errors, {});
  });

  it("flags missing required fields", () => {
    const r = validateForm(schema, { name: "  ", count: "3" });
    assert.equal(r.ok, false);
    assert.equal(r.errors.name, "required");
  });

  it("flags bad numbers and out-of-list choices", () => {
    const r = validateForm(schema, {
      name: "Oak",
      count: "not-a-number",
      status: "maybe",
    });
    assert.equal(r.errors.count, "number");
    assert.equal(r.errors.status, "choice");
  });

  it("allows an empty optional field", () => {
    const r = validateForm(schema, { name: "Oak" });
    assert.equal(r.ok, true);
  });
});

describe("buildProperties", () => {
  const schema = buildSchema([
    { label: "Name", type: "text" },
    { label: "Count", type: "number" },
  ]);

  it("coerces values and omits blanks, merging extras", () => {
    const props = buildProperties(
      schema,
      { name: "Oak", count: "5" },
      { [PHOTO_PROPERTY]: "data:image/png;base64,AAAA" },
    );
    assert.deepEqual(props, {
      name: "Oak",
      count: 5,
      photo: "data:image/png;base64,AAAA",
    });
  });

  it("omits fields left blank", () => {
    const props = buildProperties(schema, { name: "Oak", count: "" });
    assert.deepEqual(props, { name: "Oak" });
  });
});

describe("collection layer helpers", () => {
  it("round-trips the schema through metadata", () => {
    const schema = buildSchema([{ label: "Name", type: "text" }]);
    const meta = collectionMetadata(schema, { existing: 1 });
    assert.equal(meta[FIELD_COLLECTION_FLAG], true);
    assert.equal(meta.existing, 1);
    assert.deepEqual(meta[COLLECTION_SCHEMA_KEY], schema);

    const layer = { type: "geojson", metadata: meta };
    assert.equal(isCollectionLayer(layer), true);
    assert.deepEqual(getSchema(layer), schema);
  });

  it("does not treat ordinary layers as collection layers", () => {
    assert.equal(isCollectionLayer({ type: "geojson", metadata: {} }), false);
    assert.equal(
      isCollectionLayer({ type: "raster", metadata: { fieldCollection: true } }),
      false,
    );
  });

  it("getSchema defaults to empty for a malformed schema", () => {
    assert.deepEqual(
      getSchema({ type: "geojson", metadata: { collectionSchema: 42 } }),
      { fields: [] },
    );
  });
});

describe("feature builders", () => {
  it("makes a point feature with the given coordinate and props", () => {
    const f = makePointFeature(-83.5, 35.6, { name: "Oak" });
    assert.deepEqual(f.geometry, { type: "Point", coordinates: [-83.5, 35.6] });
    assert.deepEqual(f.properties, { name: "Oak" });
  });

  it("appends immutably", () => {
    const fc = emptyFeatureCollection();
    const next = appendFeature(fc, makePointFeature(0, 0, {}));
    assert.equal(fc.features.length, 0);
    assert.equal(next.features.length, 1);
  });
});

describe("dataUrlByteLength", () => {
  it("estimates the decoded byte length of a base64 data URL", () => {
    // "AAAA" decodes to 3 bytes; "AAA=" to 2; "AA==" to 1.
    assert.equal(dataUrlByteLength("data:image/png;base64,AAAA"), 3);
    assert.equal(dataUrlByteLength("data:image/png;base64,AAA="), 2);
    assert.equal(dataUrlByteLength("data:image/png;base64,AA=="), 1);
    assert.equal(dataUrlByteLength("not-a-data-url"), 0);
  });
});
