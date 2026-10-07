import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Feature, FeatureCollection } from "geojson";
import {
  coerceAttributeFormValue,
  mergeAttributeFormConfigs,
  validateAttributeFormValues,
  type AttributeFormConfig,
} from "@geolibre/core";
import {
  arcGISDomainDiagnostics,
  arcGISServiceAttributeForm,
  arcGISSubtypeField,
  resolveArcGISFieldDomain,
} from "../packages/plugins/src/plugins/arcgis-domains";
import { planArcGISEdits, type ArcGISEditInfo } from "../packages/plugins/src/plugins/arcgis-edits";

const hydrantMakers = {
  type: "codedValue",
  name: "HydrantManufacturer",
  codedValues: [
    { name: "Mueller", code: "MU" },
    { name: "Clow", code: "CL" },
  ],
};
const valveMakers = {
  type: "codedValue",
  name: "ValveManufacturer",
  codedValues: [
    { name: "Mueller", code: "MU" },
    { name: "AVK", code: "AV" },
  ],
};

const baseFields: NonNullable<ArcGISEditInfo["fields"]> = [
  { name: "OBJECTID", type: "esriFieldTypeOID", editable: false, nullable: false },
  { name: "ASSET_TYPE", type: "esriFieldTypeInteger", alias: "Asset type" },
  {
    name: "STATUS",
    type: "esriFieldTypeInteger",
    alias: "Status",
    nullable: false,
    domain: {
      type: "codedValue",
      name: "AssetStatus",
      codedValues: [
        { name: "Active", code: 1 },
        { name: "Retired", code: 2 },
      ],
    },
  },
  { name: "MANUFACTURER", type: "esriFieldTypeString", length: 4 },
  {
    name: "ZONE",
    type: "esriFieldTypeString",
    domain: {
      type: "codedValue",
      codedValues: [
        { name: "One", code: "1" },
        { name: "Zero one", code: "01" },
        { name: "Zero", code: "0" },
      ],
    },
  },
  {
    name: "PRESSURE",
    type: "esriFieldTypeInteger",
    domain: { type: "range", name: "Pressure", range: [0, 200] },
  },
  {
    name: "DIAMETER",
    type: "esriFieldTypeDouble",
    domain: { type: "range", range: [0.5, 48] },
  },
];

const editBits = {
  objectIdField: "OBJECTID",
  geometryType: "esriGeometryPoint",
  capabilities: "Query,Create,Update,Delete",
};

/** Esri's `typeIdField` / `types[]` representation. */
const typesInfo: ArcGISEditInfo = {
  ...editBits,
  fields: baseFields,
  typeIdField: "ASSET_TYPE",
  types: [
    {
      id: 1,
      name: "Hydrant",
      domains: { STATUS: { type: "inherited" }, MANUFACTURER: hydrantMakers },
    },
    {
      id: 2,
      name: "Valve",
      domains: {
        STATUS: { type: "inherited" },
        MANUFACTURER: valveMakers,
        PRESSURE: { type: "range", range: [0, 50] },
      },
    },
  ],
};

/** Esri's `subtypeField` / `subtypes[]` representation of the same model. */
const subtypesInfo: ArcGISEditInfo = {
  ...editBits,
  fields: baseFields,
  subtypeField: "ASSET_TYPE",
  subtypes: [
    { code: 1, name: "Hydrant", domains: { MANUFACTURER: hydrantMakers } },
    {
      code: 2,
      name: "Valve",
      domains: { MANUFACTURER: valveMakers, PRESSURE: { type: "range", range: [0, 50] } },
    },
  ],
};

const point = (id: number, properties: Record<string, unknown>): Feature => ({
  type: "Feature",
  id,
  properties: { OBJECTID: id, ...properties },
  geometry: { type: "Point", coordinates: [-84, 35] },
});
const fc = (...features: Feature[]): FeatureCollection => ({ type: "FeatureCollection", features });

for (const [label, info] of [
  ["typeIdField/types[]", typesInfo],
  ["subtypeField/subtypes[]", subtypesInfo],
] as const) {
  describe(`ArcGIS domains (${label})`, () => {
    it("constrains the type/subtype field to its published codes", () => {
      assert.equal(arcGISSubtypeField(info), "ASSET_TYPE");
      assert.deepEqual(resolveArcGISFieldDomain(info, "ASSET_TYPE", {}), {
        kind: "codedValue",
        codedValues: [
          { code: 1, name: "Hydrant" },
          { code: 2, name: "Valve" },
        ],
      });
    });

    it("follows the record's type for dependent fields", () => {
      const hydrant = resolveArcGISFieldDomain(info, "MANUFACTURER", { ASSET_TYPE: 1 });
      const valve = resolveArcGISFieldDomain(info, "MANUFACTURER", { ASSET_TYPE: 2 });
      assert.deepEqual(hydrant, { kind: "codedValue", codedValues: hydrantMakers.codedValues });
      assert.deepEqual(valve, { kind: "codedValue", codedValues: valveMakers.codedValues });
      assert.deepEqual(resolveArcGISFieldDomain(info, "PRESSURE", { ASSET_TYPE: 2 }), {
        kind: "range",
        min: 0,
        max: 50,
      });
    });

    it("falls back to the field-level domain when inherited, absent, or no type is set", () => {
      const status = baseFields.find((f) => f.name === "STATUS")!.domain;
      for (const properties of [{ ASSET_TYPE: 1 }, { ASSET_TYPE: 2 }, {}, { ASSET_TYPE: null }])
        assert.deepEqual(resolveArcGISFieldDomain(info, "STATUS", properties), {
          kind: "codedValue",
          codedValues: status!.codedValues,
        });
      assert.deepEqual(resolveArcGISFieldDomain(info, "PRESSURE", { ASSET_TYPE: 1 }), {
        kind: "range",
        min: 0,
        max: 200,
      });
      assert.deepEqual(resolveArcGISFieldDomain(info, "MANUFACTURER", {}), { kind: "none" });
    });

    it("leaves dependent fields to the server for an unknown or mistyped type", () => {
      for (const ASSET_TYPE of [9, "1"])
        assert.deepEqual(resolveArcGISFieldDomain(info, "MANUFACTURER", { ASSET_TYPE }), {
          kind: "unresolved",
        });
    });

    it("rejects a value outside the selected type's domain at save", () => {
      const before = point(1, { ASSET_TYPE: 1, STATUS: 1, MANUFACTURER: "CL" });
      assert.throws(
        () =>
          planArcGISEdits(
            fc(before),
            fc({ ...before, properties: { ...before.properties, MANUFACTURER: "AV" } }),
            info,
          ),
        /MANUFACTURER is outside its coded value domain/,
      );
      // A subtype override accepts a value the field-level domain would not know.
      const plan = planArcGISEdits(
        fc(before),
        fc({ ...before, properties: { ...before.properties, MANUFACTURER: "MU" } }),
        info,
      );
      assert.deepEqual(plan.updates[0].payload, {
        attributes: { MANUFACTURER: "MU", OBJECTID: 1 },
      });
    });

    it("revalidates untouched dependent values when the type changes", () => {
      const keeps = point(1, { ASSET_TYPE: 1, STATUS: 1, MANUFACTURER: "MU" });
      const plan = planArcGISEdits(
        fc(keeps),
        fc({ ...keeps, properties: { ...keeps.properties, ASSET_TYPE: 2 } }),
        info,
      );
      assert.deepEqual(plan.updates[0].payload, { attributes: { ASSET_TYPE: 2, OBJECTID: 1 } });

      const invalidated = point(2, { ASSET_TYPE: 1, STATUS: 1, MANUFACTURER: "CL" });
      assert.throws(
        () =>
          planArcGISEdits(
            fc(invalidated),
            fc({ ...invalidated, properties: { ...invalidated.properties, ASSET_TYPE: 2 } }),
            info,
          ),
        /MANUFACTURER is outside its coded value domain\. It does not fit the new ASSET_TYPE value/,
      );
      // An unrelated edit does not require repairing a historical value:
      // "CL" is not a Valve manufacturer, but only STATUS changes.
      const historical = point(3, { ASSET_TYPE: 2, STATUS: 1, MANUFACTURER: "CL" });
      const plan2 = planArcGISEdits(
        fc(historical),
        fc({ ...historical, properties: { ...historical.properties, STATUS: 2 } }),
        info,
      );
      assert.deepEqual(plan2.updates[0].payload, { attributes: { STATUS: 2, OBJECTID: 3 } });
    });

    it("rejects an unknown type code at save", () => {
      const before = point(1, { ASSET_TYPE: 1 });
      assert.throws(
        () =>
          planArcGISEdits(
            fc(before),
            fc({ ...before, properties: { ...before.properties, ASSET_TYPE: 7 } }),
            info,
          ),
        /ASSET_TYPE is outside its coded value domain/,
      );
    });

    it("builds per-type form constraints with typed codes", () => {
      const hydrant = arcGISServiceAttributeForm(info, { ASSET_TYPE: 1 })!;
      const byField = new Map(hydrant.fields.map((f) => [f.field, f]));
      assert.deepEqual(byField.get("ASSET_TYPE"), {
        field: "ASSET_TYPE",
        valueType: "integer",
        alias: "Asset type",
        widget: "valueMap",
        valueMap: [
          { value: "1", label: "Hydrant" },
          { value: "2", label: "Valve" },
        ],
      });
      assert.deepEqual(byField.get("STATUS"), {
        field: "STATUS",
        valueType: "integer",
        alias: "Status",
        required: true,
        widget: "valueMap",
        valueMap: [
          { value: "1", label: "Active" },
          { value: "2", label: "Retired" },
        ],
      });
      assert.deepEqual(byField.get("MANUFACTURER")?.valueMap, [
        { value: "MU", label: "Mueller" },
        { value: "CL", label: "Clow" },
      ]);
      assert.deepEqual(byField.get("PRESSURE"), {
        field: "PRESSURE",
        valueType: "integer",
        widget: "number",
        min: 0,
        max: 200,
      });
      assert.equal(byField.has("OBJECTID"), false);
      assert.equal(
        arcGISServiceAttributeForm(info, { ASSET_TYPE: 2 })!.fields.find(
          (f) => f.field === "PRESSURE",
        )?.max,
        50,
      );
      // Memoized per type value, so per-cell lookups are cheap.
      assert.equal(arcGISServiceAttributeForm(info, { ASSET_TYPE: 1, STATUS: 2 }), hydrant);
    });
  });
}

describe("ArcGIS typed codes", () => {
  const form = arcGISServiceAttributeForm(typesInfo, {})!;
  const config = (field: string) => form.fields.find((f) => f.field === field)!;

  it("keeps integer codes numeric and string codes as strings", () => {
    assert.equal(coerceAttributeFormValue(config("STATUS"), "1"), 1);
    assert.equal(coerceAttributeFormValue(config("ZONE"), "1"), "1");
    assert.equal(coerceAttributeFormValue(config("ZONE"), "01"), "01");
    assert.equal(coerceAttributeFormValue(config("ZONE"), "0"), "0");
    assert.equal(coerceAttributeFormValue(config("ZONE"), ""), null);
  });

  it("enforces integer and decimal rules with inclusive bounds", () => {
    const check = (properties: Record<string, unknown>) =>
      validateAttributeFormValues(form, properties).errors;
    assert.deepEqual(check({ STATUS: 1, PRESSURE: 200, DIAMETER: 0.5 }), {});
    assert.deepEqual(check({ STATUS: 1, PRESSURE: 2.5 }).PRESSURE, { code: "integer" });
    assert.deepEqual(check({ STATUS: 1, PRESSURE: 201 }).PRESSURE, {
      code: "range",
      min: 0,
      max: 200,
    });
    assert.deepEqual(check({ STATUS: 1, DIAMETER: 12.75 }), {});
    assert.deepEqual(check({ STATUS: 1, ZONE: 1 }).ZONE, { code: "text" });
    assert.deepEqual(check({ STATUS: 3 }).STATUS, { code: "valueMap" });
    assert.deepEqual(check({ STATUS: null }).STATUS, { code: "required" });
  });

  it("validates string codes exactly and integer codes by type at save", () => {
    const before = point(1, { STATUS: 1, ZONE: "1" });
    const edit = (properties: Record<string, unknown>) =>
      planArcGISEdits(
        fc(before),
        fc({ ...before, properties: { ...before.properties, ...properties } }),
        typesInfo,
      );
    assert.equal(edit({ ZONE: "01" }).updates.length, 1);
    assert.throws(() => edit({ ZONE: 1 }), /ZONE requires text/);
    assert.throws(() => edit({ ZONE: "001" }), /ZONE is outside its coded value domain/);
    assert.throws(() => edit({ STATUS: "1" }), /STATUS requires a number/);
  });
});

describe("ArcGIS domain metadata edge cases", () => {
  it("treats conflicting types[] and subtypes[] as unresolved, not merged", () => {
    const info: ArcGISEditInfo = {
      ...editBits,
      fields: baseFields,
      typeIdField: "ASSET_TYPE",
      types: typesInfo.types,
      subtypeField: "ASSET_TYPE",
      subtypes: [{ code: 1, name: "Hydrant", domains: { MANUFACTURER: valveMakers } }],
    };
    assert.deepEqual(arcGISDomainDiagnostics(info), [
      { code: "subtypeConflict", field: "ASSET_TYPE" },
    ]);
    assert.equal(arcGISSubtypeField(info), undefined);
    assert.deepEqual(resolveArcGISFieldDomain(info, "MANUFACTURER", { ASSET_TYPE: 1 }), {
      kind: "unresolved",
    });
    // A field whose domain no type overrides is still enforced.
    assert.equal(resolveArcGISFieldDomain(info, "ZONE", {}).kind, "codedValue");
  });

  it("treats an absent type entry and inherited as the same fallback", () => {
    const info: ArcGISEditInfo = {
      ...editBits,
      fields: baseFields,
      typeIdField: "ASSET_TYPE",
      types: typesInfo.types,
      subtypeField: "ASSET_TYPE",
      subtypes: subtypesInfo.subtypes,
    };
    assert.deepEqual(arcGISDomainDiagnostics(info), []);
    assert.equal(arcGISSubtypeField(info), "ASSET_TYPE");
  });

  it("matches domain override keys to fields case-insensitively", () => {
    const info: ArcGISEditInfo = {
      ...editBits,
      fields: baseFields,
      subtypeField: "ASSET_TYPE",
      subtypes: [{ code: 1, name: "Hydrant", domains: { manufacturer: hydrantMakers } }],
    };
    assert.deepEqual(resolveArcGISFieldDomain(info, "MANUFACTURER", { ASSET_TYPE: 1 }), {
      kind: "codedValue",
      codedValues: hydrantMakers.codedValues,
    });
  });

  it("reconciles agreeing types[] and subtypes[] into one selector", () => {
    const info: ArcGISEditInfo = {
      ...editBits,
      fields: baseFields,
      typeIdField: "asset_type",
      types: [{ id: 1, name: "Hydrant", domains: { MANUFACTURER: hydrantMakers } }],
      subtypeField: "ASSET_TYPE",
      subtypes: subtypesInfo.subtypes,
    };
    assert.deepEqual(arcGISDomainDiagnostics(info), []);
    assert.equal(arcGISSubtypeField(info), "ASSET_TYPE");
    const selector = arcGISServiceAttributeForm(info, {})!.fields.find(
      (f) => f.field === "ASSET_TYPE",
    );
    assert.equal(selector?.valueMap?.length, 2);
  });

  it("does not enforce a domain the service only names, or an explicit null override", () => {
    const info: ArcGISEditInfo = {
      ...editBits,
      fields: [
        ...baseFields.filter((f) => f.name !== "ZONE"),
        {
          name: "ZONE",
          type: "esriFieldTypeString",
          domain: { type: "codedValue", name: "Zones" },
        },
      ],
      subtypeField: "ASSET_TYPE",
      subtypes: [{ code: 1, name: "Hydrant", domains: { STATUS: null } }],
    };
    assert.deepEqual(arcGISDomainDiagnostics(info), [
      { code: "unresolvedDomain", field: "ZONE", domain: "Zones" },
    ]);
    assert.deepEqual(resolveArcGISFieldDomain(info, "ZONE", {}), { kind: "unresolved" });
    assert.deepEqual(resolveArcGISFieldDomain(info, "STATUS", { ASSET_TYPE: 1 }), {
      kind: "unresolved",
    });
    const form = arcGISServiceAttributeForm(info, { ASSET_TYPE: 1 })!;
    assert.equal(
      form.fields.some((f) => f.field === "ZONE" || f.field === "STATUS"),
      false,
    );
  });

  it("reports a subtype field that is not in the field list", () => {
    const info: ArcGISEditInfo = {
      ...editBits,
      fields: baseFields,
      subtypeField: "KIND",
      subtypes: subtypesInfo.subtypes,
    };
    assert.deepEqual(arcGISDomainDiagnostics(info), [
      { code: "subtypeFieldMissing", field: "KIND" },
    ]);
    assert.deepEqual(resolveArcGISFieldDomain(info, "MANUFACTURER", { KIND: 1 }), {
      kind: "unresolved",
    });
  });

  it("produces no constraints for a service without domains", () => {
    const info: ArcGISEditInfo = {
      ...editBits,
      fields: [
        { name: "OBJECTID", type: "esriFieldTypeOID", editable: false },
        { name: "name", type: "esriFieldTypeString" },
      ],
    };
    assert.equal(arcGISServiceAttributeForm(info, {}), undefined);
    assert.deepEqual(arcGISDomainDiagnostics(info), []);
  });
});

describe("mergeAttributeFormConfigs", () => {
  const service: AttributeFormConfig = arcGISServiceAttributeForm(typesInfo, { ASSET_TYPE: 1 })!;

  it("returns the designer form unchanged without service constraints", () => {
    const form: AttributeFormConfig = { fields: [{ field: "a", widget: "text" }] };
    assert.equal(mergeAttributeFormConfigs(form, undefined), form);
  });

  it("keeps author presentation but never widens the service domain", () => {
    const merged = mergeAttributeFormConfigs(
      {
        fields: [
          {
            field: "STATUS",
            widget: "valueMap",
            alias: "Lifecycle",
            visibilityExpression: '["==", ["get", "ASSET_TYPE"], 1]',
            valueMap: [{ value: "1", label: "In service" }, { value: "9" }],
          },
          { field: "PRESSURE", widget: "range", min: 10, max: 500, step: 5 },
          { field: "MANUFACTURER", widget: "text", required: true },
          { field: "notes", widget: "text" },
        ],
      },
      service,
    )!;
    const byField = new Map(merged.fields.map((f) => [f.field, f]));
    assert.deepEqual(byField.get("STATUS"), {
      field: "STATUS",
      widget: "valueMap",
      alias: "Lifecycle",
      visibilityExpression: '["==", ["get", "ASSET_TYPE"], 1]',
      valueMap: [{ value: "1", label: "In service" }],
      required: true,
      valueType: "integer",
    });
    assert.deepEqual(byField.get("PRESSURE"), {
      field: "PRESSURE",
      widget: "range",
      min: 10,
      max: 200,
      step: 5,
      valueType: "integer",
    });
    assert.equal(byField.get("MANUFACTURER")?.widget, "valueMap");
    assert.equal(byField.get("MANUFACTURER")?.required, true);
    assert.deepEqual(byField.get("notes"), { field: "notes", widget: "text" });
    assert.ok(byField.has("ASSET_TYPE"));
  });

  it("still checks a hidden field against the service domain", () => {
    const merged = mergeAttributeFormConfigs(
      { fields: [{ field: "STATUS", widget: "valueMap", visibilityExpression: '["==", 1, 2]' }] },
      service,
    );
    const hidden = validateAttributeFormValues(merged, { STATUS: 7 });
    assert.equal(hidden.errors.STATUS, undefined);
    const enforced = validateAttributeFormValues(merged, { STATUS: 7 }, { serviceForm: service });
    assert.deepEqual(enforced.errors.STATUS, { code: "valueMap" });
  });
});
