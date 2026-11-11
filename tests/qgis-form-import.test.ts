import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getAttributeFormField,
  isAttributeFormFieldVisible,
  validateAttributeFormValues,
} from "@geolibre/core";
import { DOMParser } from "linkedom";
import {
  detachFromSourceFile,
  getGeometryType,
  getSchema,
  isCollectionLayer,
  isFileBackedCollectionLayer,
} from "../apps/geolibre-desktop/src/lib/field-collection";
import {
  applyCaptureDefaults,
  captureExpressionVariables,
  defaultValueEpsgCodes,
} from "../apps/geolibre-desktop/src/lib/field-collection-defaults";
import {
  MAX_RELATION_ENTRIES,
  relationValueMap,
} from "../apps/geolibre-desktop/src/lib/qgis-form-import";
import {
  importQgisProject,
  materializeQgisFormRelations,
} from "../apps/geolibre-desktop/src/lib/qgis-project-import";

globalThis.DOMParser = DOMParser as unknown as typeof globalThis.DOMParser;

// linkedom's XML mode hands attribute values back with `<`, `>` and `&` still
// escaped, where a browser's DOMParser decodes them. QGIS expressions are full
// of comparison operators, so decode them here to match what the app sees.
{
  const sample = new DOMParser().parseFromString("<a/>", "text/xml").documentElement;
  let proto = Object.getPrototypeOf(sample) as { getAttribute?: unknown } | null;
  while (proto && !Object.prototype.hasOwnProperty.call(proto, "getAttribute")) {
    proto = Object.getPrototypeOf(proto);
  }
  assert.ok(proto, "linkedom Element prototype not found");
  const original = proto.getAttribute as (this: unknown, name: string) => string | null;
  proto.getAttribute = function (this: unknown, name: string) {
    const value = original.call(this, name);
    return typeof value === "string"
      ? value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
      : value;
  };
}

const option = (name: string, value: string | number) =>
  `<Option name="${name}" type="QString" value="${value}"/>`;

/** One `<field>` of a layer's `<fieldConfiguration>`. */
function field(name: string, widget: string, config = ""): string {
  return `<field name="${name}"><editWidget type="${widget}"><config>
    <Option type="Map">${config}</Option></config></editWidget></field>`;
}

/** A QField-style survey project: a point layer with a form, plus lookup tables. */
function surveyProject(): string {
  return `<qgis version="3.44.0">
    <title>Survey</title>
    <relations>
      <relation id="point_owner" referencingLayer="points" referencedLayer="owners">
        <fieldRef referencingField="owner_id" referencedField="id"/>
      </relation>
    </relations>
    <projectlayers>
      <maplayer type="vector" geometry="Point">
        <id>points</id><layername>Measured points</layername>
        <datasource>./data/survey.gpkg|layername=points</datasource><provider>ogr</provider>
        <fieldConfiguration>
          ${field("fid", "TextEdit")}
          ${field("uuid", "UuidGenerator")}
          ${field(
            "species",
            "ValueMap",
            `<Option name="map" type="List">
               <Option type="Map">${option("Oak", "QUE")}</Option>
               <Option type="Map">${option("Beech", "FAG")}</Option>
               <Option type="Map">${option("(none)", "{2839923C-8B7D-419E-B84B-CA2FE9B80EC7}")}</Option>
             </Option>`,
          )}
          ${field("legacy", "ValueMap", `<Option name="map" type="Map">${option("Yes", "y")}${option("No", "n")}</Option>`)}
          ${field("height", "Range", option("Min", 0) + option("Max", 60) + option("Step", 5) + option("Style", "Slider"))}
          ${field("count", "Range", option("Min", -2147483648) + option("Max", 2147483647) + option("Style", "SpinBox"))}
          ${field("damaged", "CheckBox")}
          ${field("fenced", "CheckBox", option("CheckedState", "Y") + option("UncheckedState", "N"))}
          ${field("flag", "CheckBox", option("CheckedState", "1") + option("UncheckedState", "0"))}
          ${field("logged_at", "DateTime", option("field_format", "yyyy-MM-dd HH:mm:ss"))}
          ${field("synced_at", "DateTime", option("field_format", "yyyy-MM-dd") + option("field_iso_format", "true"))}
          ${field("tags", "ValueRelation", option("Layer", "materials") + option("Key", "code") + option("Value", "label") + option("AllowMulti", "true"))}
          ${field("visited", "DateTime")}
          ${field("accuracy", "TextEdit")}
          ${field("easting", "Hidden")}
          ${field("photo_name", "ExternalResource")}
          ${field("material", "ValueRelation", option("Layer", "materials") + option("Key", "code") + option("Value", "label"))}
          ${field("owner_id", "RelationReference", option("Relation", "point_owner"))}
          ${field("parent", "RelationReference", option("Relation", "gone"))}
          ${field("note", "TextEdit")}
        </fieldConfiguration>
        <aliases>
          <alias field="species" name="Tree species" index="2"/>
          <alias field="note" name="" index="14"/>
        </aliases>
        <defaults>
          <default field="visited" expression="now()" applyOnUpdate="0"/>
          <default field="accuracy" expression="coalesce(@position_horizontal_accuracy, @gnss_horizontal_accuracy)" applyOnUpdate="0"/>
          <default field="easting" expression="x(transform(@position_coordinate, 'EPSG:4326', 'EPSG:2056'))" applyOnUpdate="0"/>
          <default field="photo_name" expression="'DCIM/' || species || '_' || format_date(now(), 'yyyyMMdd') || '.jpg'" applyOnUpdate="0"/>
          <default field="count" expression="aggregate('points', 'count', fid)" applyOnUpdate="0"/>
          <default field="note" expression="" applyOnUpdate="0"/>
        </defaults>
        <constraints>
          <constraint field="species" constraints="1" notnull_strength="1" exp_strength="0" unique_strength="0"/>
          <constraint field="damaged" constraints="1" notnull_strength="2" exp_strength="0" unique_strength="0"/>
          <constraint field="height" constraints="4" notnull_strength="0" exp_strength="1" unique_strength="0"/>
          <constraint field="count" constraints="4" notnull_strength="0" exp_strength="1" unique_strength="0"/>
          <constraint field="note" constraints="4" notnull_strength="0" exp_strength="2" unique_strength="0"/>
        </constraints>
        <constraintExpressions>
          <constraint field="height" exp="height > 0 and 60 >= height" desc="between 0 and 60 m"/>
          <constraint field="count" exp="maximum(count) > count" desc=""/>
          <constraint field="note" exp="length(note) > 3" desc="soft"/>
        </constraintExpressions>
      </maplayer>
      <maplayer type="vector" geometry="Polygon">
        <id>parcels</id><layername>Parcels</layername>
        <datasource>./data/survey.gpkg|layername=parcels|subset=a = 1</datasource><provider>ogr</provider>
        <fieldConfiguration>${field("fid", "TextEdit")}${field("name", "TextEdit")}</fieldConfiguration>
      </maplayer>
      <maplayer type="vector" geometry="No geometry">
        <id>materials</id><layername>Materials</layername>
        <datasource>./data/lookups.gpkg|layername=materials</datasource><provider>ogr</provider>
      </maplayer>
      <maplayer type="vector" geometry="No geometry">
        <id>owners</id><layername>Owners</layername>
        <datasource>./data/survey.gpkg|layername=owners</datasource><provider>ogr</provider>
        <previewExpression>"last_name" || ', ' || "first_name"</previewExpression>
      </maplayer>
    </projectlayers>
  </qgis>`;
}

/** Layers come back bottom-to-top, so tests look them up by QGIS id. */
function imported() {
  const result = importQgisProject(surveyProject(), "/home/me/survey/survey.qgs");
  const layer = (id: string) => {
    const found = result.project.layers.find((candidate) => candidate.id === id);
    assert.ok(found, `layer ${id} was not imported`);
    return found;
  };
  return { ...result, result, points: layer("points"), parcels: layer("parcels") };
}

describe("QGIS form import", () => {
  it("reads each GeoPackage layer from its own table", () => {
    const { points, parcels } = imported();
    assert.deepEqual(
      [points, parcels].map((layer) => [layer.sourcePath, layer.metadata.sourceLayer]),
      [
        ["/home/me/survey/data/survey.gpkg", "points"],
        ["/home/me/survey/data/survey.gpkg", "parcels"],
      ],
    );
  });

  it("reports tables without geometry instead of adding empty layers", () => {
    const { warnings } = imported();
    assert.deepEqual(
      warnings.sort((a, b) => a.layerName.localeCompare(b.layerName)),
      [
        { layerName: "Materials", reason: "no-geometry" },
        { layerName: "Owners", reason: "no-geometry" },
      ],
    );
  });

  it("carries widgets, aliases, required fields, constraints and defaults over", () => {
    const { points } = imported();
    const byField = new Map(points.attributeForm?.fields.map((entry) => [entry.field, entry]));
    assert.equal(byField.has("fid"), false);
    assert.deepEqual(byField.get("uuid"), {
      field: "uuid",
      widget: "text",
      defaultValue: "uuid()",
    });
    assert.deepEqual(byField.get("species"), {
      field: "species",
      widget: "valueMap",
      valueMap: [
        { value: "QUE", label: "Oak" },
        { value: "FAG", label: "Beech" },
      ],
      alias: "Tree species",
      required: true,
    });
    assert.deepEqual(byField.get("legacy")?.valueMap, [
      { value: "y", label: "Yes" },
      { value: "n", label: "No" },
    ]);
    assert.deepEqual(byField.get("height"), {
      field: "height",
      widget: "range",
      min: 0,
      max: 60,
      step: 5,
      constraintExpression: JSON.stringify([
        "any",
        ["==", ["get", "height"], null],
        [
          "all",
          [">", ["to-number", ["get", "height"]], 0],
          [">=", 60, ["to-number", ["get", "height"]]],
        ],
      ]),
      constraintDescription: "between 0 and 60 m",
    });
    // The 32-bit limits QGIS writes for an unbounded spin box are not bounds.
    assert.deepEqual(byField.get("count"), { field: "count", widget: "number" });
    // A soft not-null only warns in QGIS, so it is not a required field here.
    assert.deepEqual(byField.get("damaged"), { field: "damaged", widget: "checkbox" });
    assert.deepEqual(byField.get("visited"), {
      field: "visited",
      widget: "date",
      defaultValue: "now()",
    });
    // A checkbox that stores custom states keeps writing those states.
    assert.deepEqual(byField.get("fenced"), {
      field: "fenced",
      widget: "valueMap",
      valueMap: [{ value: "Y" }, { value: "N" }],
      valueType: "string",
    });
    // Numeric states on an integer column keep storing numbers.
    assert.deepEqual(byField.get("flag"), {
      field: "flag",
      widget: "valueMap",
      valueMap: [{ value: "1" }, { value: "0" }],
    });
    // A date/time field keeps its time: the date picker would drop it.
    assert.deepEqual(byField.get("logged_at"), { field: "logged_at", widget: "text" });
    assert.deepEqual(byField.get("synced_at"), { field: "synced_at", widget: "text" });
    // A multi-select holds a list of keys, so it is not made a single choice.
    assert.deepEqual(byField.get("tags"), { field: "tags", widget: "text" });
    assert.equal(
      byField.get("photo_name")?.defaultValue,
      "'DCIM/' || species || '_' || format_date(now(), 'yyyyMMdd') || '.jpg'",
    );
    assert.deepEqual(byField.get("note"), { field: "note", widget: "text" });
  });

  it("notes what it could not carry over", () => {
    assert.deepEqual(imported().formNotes, [
      {
        layerName: "Measured points",
        field: "count",
        reason: "constraint",
        detail: "maximum(count) > count",
      },
      { layerName: "Measured points", field: "count", reason: "default", detail: "aggregate()" },
      { layerName: "Measured points", field: "tags", reason: "relation-multi" },
      { layerName: "Measured points", field: "parent", reason: "relation" },
    ]);
  });

  it("makes a layer with a form a Field Collection target", () => {
    const { points, parcels } = imported();
    assert.equal(isCollectionLayer(points), true);
    assert.equal(getGeometryType(points), "point");
    assert.equal(points.metadata.localFileReloadable, true);
    assert.deepEqual(getSchema(points).fields.slice(0, 3), [
      { key: "uuid", label: "uuid", type: "text" },
      { key: "species", label: "Tree species", type: "text", required: true },
      { key: "legacy", label: "legacy", type: "text" },
    ]);
    assert.equal(getSchema(points).fields.find((entry) => entry.key === "height")?.type, "number");
    // Plain text fields only: nothing to carry over, so not a capture target.
    assert.equal(parcels.attributeForm, undefined);
    assert.equal(isCollectionLayer(parcels), false);
  });

  it("hides a Hidden-widget field", () => {
    const { points } = imported();
    const easting = getAttributeFormField(points.attributeForm, "easting");
    assert.ok(easting);
    assert.equal(isAttributeFormFieldVisible(easting, {}), false);
    const height = getAttributeFormField(points.attributeForm, "height");
    assert.ok(height);
    assert.equal(isAttributeFormFieldVisible(height, {}), true);
  });

  it("does not hold an empty optional field against its constraint", () => {
    const { points } = imported();
    // height is optional: blank passes, as it does in QGIS.
    assert.deepEqual(validateAttributeFormValues(points.attributeForm, { species: "QUE" }), {
      ok: true,
      errors: {},
    });
    const result = validateAttributeFormValues(points.attributeForm, {
      species: "QUE",
      height: 20,
    });
    assert.deepEqual(result, { ok: true, errors: {} });
    const failing = validateAttributeFormValues(points.attributeForm, { height: 80 });
    assert.equal(failing.errors.species?.code, "required");
    assert.equal(failing.errors.height?.code, "range");
  });

  it("fills relation dropdowns from the referenced tables", async () => {
    const { result, points } = imported();
    assert.deepEqual(
      result.formRelations.map((relation) => [relation.field, relation.sourcePath, relation.table]),
      [
        ["material", "/home/me/survey/data/lookups.gpkg", "materials"],
        ["owner_id", "/home/me/survey/data/survey.gpkg", "owners"],
      ],
    );
    const reads: string[] = [];
    await materializeQgisFormRelations(result, async (path, table) => {
      reads.push(`${path}|${table}`);
      if (table === "materials") {
        return [
          { code: "ST", label: "Steel" },
          { code: "CO", label: "Concrete" },
          { code: "ST", label: "Steel (duplicate)" },
          { code: null, label: "No code" },
        ];
      }
      return [
        { id: 2, first_name: "Ada", last_name: "Young" },
        { id: 1, first_name: "Bo", last_name: "Abel" },
      ];
    });
    assert.equal(reads.length, 2);
    const fields = points.attributeForm?.fields ?? [];
    const material = fields.find((entry) => entry.field === "material");
    assert.deepEqual(material?.valueMap, [
      { value: "CO", label: "Concrete" },
      { value: "ST", label: "Steel" },
    ]);
    // Typed from the key column, so text codes stay text and ids stay numbers.
    assert.equal(material?.valueType, "string");
    const owner = fields.find((entry) => entry.field === "owner_id");
    assert.deepEqual(owner?.valueMap, [
      { value: "1", label: "Abel, Bo" },
      { value: "2", label: "Young, Ada" },
    ]);
    assert.equal(owner?.valueType, "number");
    assert.deepEqual(result.formRelations, []);
  });

  it("keeps a text box and notes it when a referenced table cannot be read", async () => {
    const { result, points } = imported();
    await materializeQgisFormRelations(result, async (_path, table) => {
      if (table === "owners") throw new Error("locked");
      return [];
    });
    const fields = points.attributeForm?.fields ?? [];
    assert.equal(fields.find((entry) => entry.field === "owner_id")?.widget, "text");
    assert.deepEqual(
      result.formNotes
        .filter((note) => note.reason.startsWith("relation"))
        .map((note) => [note.field, note.reason]),
      [
        ["tags", "relation-multi"],
        ["parent", "relation"],
        // Read fine but empty, as opposed to the one that could not be read.
        ["material", "relation-empty"],
        ["owner_id", "relation"],
      ],
    );
  });

  it("labels relation entries with the key when nothing else is known", () => {
    assert.deepEqual(
      relationValueMap([{ id: "b" }, { id: "a" }], {
        field: "x",
        referencedLayerId: "t",
        keyField: "id",
        useDisplayExpression: true,
      }),
      { entries: [{ value: "a" }, { value: "b" }], valueType: "string" },
    );
  });

  it("leaves a dropdown as text when its table is too long for a list", async () => {
    const { result, points } = imported();
    await materializeQgisFormRelations(result, async (_path, table) =>
      table === "materials"
        ? Array.from({ length: MAX_RELATION_ENTRIES + 1 }, (_, index) => ({
            code: `M${index}`,
            label: `Material ${index}`,
          }))
        : [{ id: 1, first_name: "Bo", last_name: "Abel" }],
    );
    const fields = points.attributeForm?.fields ?? [];
    assert.equal(fields.find((entry) => entry.field === "material")?.widget, "text");
    assert.equal(fields.find((entry) => entry.field === "owner_id")?.widget, "valueMap");
    assert.deepEqual(
      result.formNotes.filter((note) => note.reason === "relation-too-large"),
      [{ layerName: "Measured points", field: "material", reason: "relation-too-large" }],
    );
  });

  it("detaches a file-backed layer once something is captured into it", () => {
    const { points } = imported();
    assert.equal(isFileBackedCollectionLayer(points), true);
    const patch = detachFromSourceFile(points);
    assert.equal("sourcePath" in patch && patch.sourcePath, undefined);
    assert.equal(patch.metadata?.localFileReloadable, undefined);
    assert.equal(patch.metadata?.capturedFromPath, "/home/me/survey/data/survey.gpkg");
    assert.equal(patch.metadata?.fieldCollection, true);
    const detached = { ...points, ...patch };
    assert.equal(isFileBackedCollectionLayer(detached), false);
    // A layer created in the app, or one read from a URL, has nothing to detach.
    assert.deepEqual(detachFromSourceFile({ metadata: { fieldCollection: true } }), {});
    assert.deepEqual(
      detachFromSourceFile({ sourcePath: "https://example.com/a.geojson", metadata: {} }),
      {},
    );
  });
});

describe("Field Collection default values", () => {
  const fix = {
    lng: 9.25,
    lat: 46.8,
    accuracy: 3.5,
    satellites: 11,
    altitude: 1020,
    heading: null,
    speed: null,
    timestamp: Date.UTC(2026, 10, 11, 12, 0, 0),
  };

  it("exposes a GPS fix as QField position variables, under both spellings", () => {
    const variables = captureExpressionVariables({ fix, layerName: "Points", user: "ada" });
    assert.deepEqual(variables.position_coordinate, {
      type: "Point",
      coordinates: [9.25, 46.8, 1020],
    });
    assert.equal(variables.position_horizontal_accuracy, 3.5);
    assert.equal(variables.gnss_horizontal_accuracy, 3.5);
    assert.equal(variables.position_number_of_used_satellites, 11);
    assert.equal("position_direction" in variables, false);
    assert.equal(variables.layer_name, "Points");
    assert.equal(variables.user_full_name, "ada");
  });

  it("sets no position variables for a point picked on the map", () => {
    const variables = captureExpressionVariables({ fix: null, layerName: "Points" });
    assert.deepEqual(variables, { layer_name: "Points" });
  });

  it("lists the EPSG codes a form's defaults need", () => {
    const { points } = imported();
    assert.deepEqual(defaultValueEpsgCodes(points.attributeForm), [2056, 4326]);
  });

  it("refreshes its own values but never overwrites what the user typed", () => {
    const { points } = imported();
    const form = points.attributeForm;
    const now = () => new Date(2026, 10, 11, 9, 30, 0);
    const first = applyCaptureDefaults(
      form,
      {},
      {},
      {
        now,
        uuid: () => "aaaaaaaa-0000-4000-8000-000000000000",
        variables: captureExpressionVariables({ fix }),
        properties: { species: "QUE" },
      },
    );
    assert.equal(first.values.uuid, "{aaaaaaaa-0000-4000-8000-000000000000}");
    assert.equal(first.values.visited, "2026-11-11");
    assert.equal(first.values.accuracy, "3.5");
    assert.equal(first.values.photo_name, "DCIM/QUE_20261111.jpg");
    // No transform hook yet: the projected easting stays empty, not wrong.
    assert.equal(first.values.easting ?? "", "");

    // The user fixes the date; the point is then re-picked on the map (no fix).
    const edited = { ...first.values, visited: "2026-11-01" };
    const second = applyCaptureDefaults(form, edited, first.autoFilled, {
      now,
      uuid: () => "bbbbbbbb-0000-4000-8000-000000000000",
      variables: captureExpressionVariables({ fix: null }),
      properties: { species: "QUE" },
    });
    assert.equal(second.values.visited, "2026-11-01");
    assert.equal(second.values.accuracy, "");
    assert.equal("visited" in second.autoFilled, false);
  });

  it("fills a default built from a field the user types after the capture", () => {
    const form = {
      fields: [
        { field: "uuid", widget: "text" as const, defaultValue: "uuid('WithoutBraces')" },
        { field: "site", widget: "text" as const },
        { field: "file", widget: "text" as const, defaultValue: "site || '.jpg'" },
      ],
    };
    let id = 0;
    const context = { uuid: () => `id-${(id += 1)}` };
    const captured = applyCaptureDefaults(form, {}, {}, context);
    assert.deepEqual(captured.values, { uuid: "id-1" });

    const typed = { ...captured.values, site: "A1" };
    const updated = applyCaptureDefaults(
      form,
      typed,
      captured.autoFilled,
      { ...context, properties: { uuid: "id-1", site: "A1" } },
      "input",
    );
    // The file name follows the site; the ID is not regenerated by typing.
    assert.deepEqual(updated.values, { uuid: "id-1", site: "A1", file: "A1.jpg" });
    assert.equal(updated.autoFilled.uuid, "id-1");

    const settled = applyCaptureDefaults(
      form,
      updated.values,
      updated.autoFilled,
      { ...context, properties: { uuid: "id-1", site: "A1", file: "A1.jpg" } },
      "input",
    );
    assert.equal(settled.values, updated.values);
  });

  it("keeps the capture time when a field in a timestamped name changes", () => {
    const form = {
      fields: [
        { field: "site", widget: "text" as const },
        {
          field: "file",
          widget: "text" as const,
          defaultValue: "site || '_' || format_date(now(), 'HHmmss') || '.jpg'",
        },
      ],
    };
    const capturedAt = new Date(2026, 10, 11, 9, 30, 15);
    const context = { now: () => capturedAt };
    const captured = applyCaptureDefaults(
      form,
      { site: "A1" },
      {},
      {
        ...context,
        properties: { site: "A1" },
      },
    );
    assert.equal(captured.values.file, "A1_093015.jpg");
    const renamed = applyCaptureDefaults(
      form,
      { ...captured.values, site: "B2" },
      captured.autoFilled,
      { ...context, properties: { site: "B2", file: "A1_093015.jpg" } },
      "input",
    );
    assert.equal(renamed.values.file, "B2_093015.jpg");
  });

  it("leaves a default the user emptied empty", () => {
    const form = {
      fields: [
        { field: "site", widget: "text" as const },
        { field: "file", widget: "text" as const, defaultValue: "site || '.jpg'" },
      ],
    };
    const captured = applyCaptureDefaults(form, { site: "A1" }, {}, { properties: { site: "A1" } });
    assert.equal(captured.values.file, "A1.jpg");
    // The user clears the optional field, then edits something else.
    const cleared = { ...captured.values, file: "" };
    const first = applyCaptureDefaults(
      form,
      cleared,
      captured.autoFilled,
      { properties: { site: "A1" } },
      "input",
    );
    assert.equal(first.values, cleared);
    const second = applyCaptureDefaults(
      form,
      { ...cleared, site: "B2" },
      first.autoFilled,
      { properties: { site: "B2" } },
      "input",
    );
    assert.equal(second.values.file, "");
  });

  it("does not feed a cleared default back into the fields that read it", () => {
    const form = {
      fields: [
        {
          field: "accuracy",
          widget: "text" as const,
          defaultValue: "@position_horizontal_accuracy",
        },
        { field: "note", widget: "text" as const, defaultValue: "'Accuracy: ' || accuracy" },
      ],
    };
    const first = applyCaptureDefaults(
      form,
      {},
      {},
      {
        variables: captureExpressionVariables({ fix }),
      },
    );
    assert.deepEqual(first.values, { accuracy: "3.5", note: "Accuracy: 3.5" });
    // Repositioned on the map: no fix, so both defaults clear together.
    const second = applyCaptureDefaults(form, first.values, first.autoFilled, {
      variables: captureExpressionVariables({ fix: null }),
      properties: { accuracy: "3.5", note: "Accuracy: 3.5" },
    });
    assert.deepEqual(second.values, { accuracy: "", note: "" });
  });

  it("returns the same object when nothing changes", () => {
    const values = { note: "hello" };
    const result = applyCaptureDefaults(
      { fields: [{ field: "note", widget: "text" }] },
      values,
      {},
      {},
    );
    assert.equal(result.values, values);
  });
});
