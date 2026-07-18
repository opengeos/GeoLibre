import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendFeature,
  buildGeometryFeature,
  buildProperties,
  buildSchema,
  collectionMetadata,
  COLLECTION_GEOMETRY_KEY,
  COLLECTION_SCHEMA_KEY,
  coerceValue,
  drawPreview,
  emptyFeatureCollection,
  FIELD_COLLECTION_FLAG,
  getGeometryType,
  getSchema,
  isCollectionLayer,
  makeLineFeature,
  makePointFeature,
  makePolygonFeature,
  minVertices,
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

  it("avoids the reserved photo key for a user 'Photo' field", () => {
    const schema = buildSchema([{ label: "Photo", type: "text" }]);
    // "Photo" would slug to "photo", which is reserved for the attached image.
    assert.notEqual(schema.fields[0].key, PHOTO_PROPERTY);
    assert.equal(schema.fields[0].key, "photo_2");
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
  it("round-trips the schema and geometry through metadata", () => {
    const schema = buildSchema([{ label: "Name", type: "text" }]);
    const meta = collectionMetadata(schema, "polygon", { existing: 1 });
    assert.equal(meta[FIELD_COLLECTION_FLAG], true);
    assert.equal(meta.existing, 1);
    assert.deepEqual(meta[COLLECTION_SCHEMA_KEY], schema);
    assert.equal(meta[COLLECTION_GEOMETRY_KEY], "polygon");

    const layer = { type: "geojson", metadata: meta };
    assert.equal(isCollectionLayer(layer), true);
    assert.deepEqual(getSchema(layer), schema);
    assert.equal(getGeometryType(layer), "polygon");
  });

  it("defaults geometry to point when unset or invalid", () => {
    assert.equal(getGeometryType({ type: "geojson", metadata: {} }), "point");
    assert.equal(
      getGeometryType({ type: "geojson", metadata: { collectionGeometry: "blob" } }),
      "point",
    );
  });

  it("does not treat ordinary layers as collection layers", () => {
    assert.equal(isCollectionLayer({ type: "geojson", metadata: {} }), false);
    assert.equal(isCollectionLayer({ type: "raster", metadata: { fieldCollection: true } }), false);
  });

  it("getSchema defaults to empty for a malformed schema", () => {
    assert.deepEqual(getSchema({ type: "geojson", metadata: { collectionSchema: 42 } }), {
      fields: [],
    });
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

describe("line/polygon geometry", () => {
  it("minVertices is 1/2/3 for point/line/polygon", () => {
    assert.equal(minVertices("point"), 1);
    assert.equal(minVertices("line"), 2);
    assert.equal(minVertices("polygon"), 3);
  });

  it("makeLineFeature keeps the vertex order", () => {
    const f = makeLineFeature(
      [
        [0, 0],
        [1, 1],
        [2, 0],
      ],
      { name: "Trail" },
    );
    assert.equal(f.geometry.type, "LineString");
    assert.deepEqual(f.geometry.coordinates, [
      [0, 0],
      [1, 1],
      [2, 0],
    ]);
  });

  it("makePolygonFeature closes an open ring", () => {
    const f = makePolygonFeature(
      [
        [0, 0],
        [2, 0],
        [2, 2],
      ],
      {},
    );
    assert.equal(f.geometry.type, "Polygon");
    const ring = f.geometry.coordinates[0];
    assert.deepEqual(ring[0], ring[ring.length - 1]); // closed
    assert.equal(ring.length, 4);
  });

  it("makePolygonFeature does not double-close an already-closed ring", () => {
    const ring = [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 0],
    ] as [number, number][];
    const f = makePolygonFeature(ring, {});
    assert.equal(f.geometry.coordinates[0].length, 4);
  });

  it("buildGeometryFeature throws on empty point coords", () => {
    assert.throws(() => buildGeometryFeature("point", [], {}));
  });

  it("buildGeometryFeature dispatches on geometry type", () => {
    assert.equal(buildGeometryFeature("point", [[1, 2]], {}).geometry.type, "Point");
    assert.equal(
      buildGeometryFeature(
        "line",
        [
          [0, 0],
          [1, 1],
        ],
        {},
      ).geometry.type,
      "LineString",
    );
    assert.equal(
      buildGeometryFeature(
        "polygon",
        [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
        {},
      ).geometry.type,
      "Polygon",
    );
  });

  it("drawPreview includes a vertex point per coord and a line at >= 2", () => {
    const one = drawPreview("line", [[0, 0]]);
    assert.equal(one.features.length, 1); // just the vertex
    const two = drawPreview("line", [
      [0, 0],
      [1, 1],
    ]);
    // two vertices + one line
    assert.equal(two.features.length, 3);
    assert.ok(two.features.some((f) => f.geometry?.type === "LineString"));
  });

  it("drawPreview closes the polygon fill at >= 3 vertices", () => {
    const two = drawPreview("polygon", [
      [0, 0],
      [1, 0],
    ]);
    // 2 vertices + ring line, no fill yet
    assert.ok(!two.features.some((f) => f.geometry?.type === "Polygon"));
    const three = drawPreview("polygon", [
      [0, 0],
      [1, 0],
      [1, 1],
    ]);
    // 3 vertices + line + polygon fill
    assert.equal(three.features.length, 5);
    assert.ok(three.features.some((f) => f.geometry?.type === "Polygon"));
  });
});
