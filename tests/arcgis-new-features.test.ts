import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Feature, FeatureCollection } from "geojson";
import type { GeoLibreLayer } from "@geolibre/core";
import {
  ARCGIS_FEATURE_SOURCE_KIND,
  arcGISCopiedFeatureProperties,
  arcGISCreationTemplates,
  arcGISLayerCreationTemplates,
  arcGISNewFeatureProperties,
  arcGISServerManagedFields,
} from "../packages/plugins/src/plugins/arcgis-defaults";
import { planArcGISEdits, type ArcGISEditInfo } from "../packages/plugins/src/plugins/arcgis-edits";
import {
  GEOMETRY_EDIT_FID_PROPERTY,
  captureEditedFeatureIds,
  captureEditedGeometries,
  captureEditedProperties,
  reconcileEditedFeatures,
  tagFeatureKeys,
  type NewEditedFeatureKind,
} from "../packages/plugins/src/plugins/geo-editor-geometry";

const fields: NonNullable<ArcGISEditInfo["fields"]> = [
  { name: "OBJECTID", type: "esriFieldTypeOID", editable: false, nullable: false },
  { name: "GlobalID", type: "esriFieldTypeGlobalID", editable: false, nullable: false },
  { name: "created_user", type: "esriFieldTypeString", editable: false },
  { name: "ASSET_TYPE", type: "esriFieldTypeInteger", defaultValue: 2 },
  { name: "STATUS", type: "esriFieldTypeInteger", defaultValue: 1 },
  { name: "MANUFACTURER", type: "esriFieldTypeString" },
  { name: "PRESSURE", type: "esriFieldTypeInteger" },
  { name: "NOTES", type: "esriFieldTypeString", defaultValue: "none" },
];
const base: ArcGISEditInfo = {
  objectIdField: "OBJECTID",
  globalIdField: "GlobalID",
  geometryType: "esriGeometryPoint",
  capabilities: "Query,Create,Update,Delete",
  fields,
};

describe("arcGISNewFeatureProperties", () => {
  it("fills field defaults on a layer without types", () => {
    assert.deepEqual(arcGISNewFeatureProperties(base, {}), {
      ASSET_TYPE: 2,
      STATUS: 1,
      NOTES: "none",
    });
  });

  it("treats an empty default as no default, as hosted services publish it", () => {
    const info: ArcGISEditInfo = {
      ...base,
      fields: [
        ...fields,
        { name: "INSPECTED", type: "esriFieldTypeDate", defaultValue: "" },
        { name: "DEPTH", type: "esriFieldTypeDouble", defaultValue: "" },
      ],
    };
    assert.deepEqual(arcGISNewFeatureProperties(info, {}), {
      ASSET_TYPE: 2,
      STATUS: 1,
      NOTES: "none",
    });
  });

  it("with keepGiven, never fills an attribute given as null (#3122)", () => {
    const templated: ArcGISEditInfo = {
      ...base,
      templates: [{ prototype: { attributes: { MANUFACTURER: "MU", ASSET_TYPE: 3 } } }],
    };
    // A placeholder null on a drawn feature is still filled.
    assert.equal(arcGISNewFeatureProperties(templated, { MANUFACTURER: null }).MANUFACTURER, "MU");
    assert.deepEqual(
      arcGISNewFeatureProperties(
        templated,
        { MANUFACTURER: null, status: null, ASSET_TYPE: null },
        { keepGiven: true },
      ),
      { MANUFACTURER: null, status: null, ASSET_TYPE: null, NOTES: "none" },
    );
  });

  it("never replaces a value already on the feature, and drops server-managed ones", () => {
    assert.deepEqual(
      arcGISNewFeatureProperties(base, {
        STATUS: 2,
        NOTES: "kept",
        OBJECTID: 9,
        created_user: "x",
      }),
      { STATUS: 2, NOTES: "kept", ASSET_TYPE: 2 },
    );
  });

  it("uses a layer's only template, but none when there are several", () => {
    const one = {
      ...base,
      templates: [
        { name: "Hydrant", prototype: { attributes: { manufacturer: "MU", STATUS: null } } },
      ],
    };
    assert.deepEqual(arcGISNewFeatureProperties(one, {}), {
      ASSET_TYPE: 2,
      STATUS: 1,
      MANUFACTURER: "MU",
      NOTES: "none",
    });
    const two = {
      ...base,
      templates: [
        { name: "A", prototype: { attributes: { MANUFACTURER: "MU" } } },
        { name: "B", prototype: { attributes: { MANUFACTURER: "CL" } } },
      ],
    };
    assert.equal(arcGISNewFeatureProperties(two, {}).MANUFACTURER, undefined);
  });

  describe("with types", () => {
    const typed: ArcGISEditInfo = {
      ...base,
      typeIdField: "ASSET_TYPE",
      types: [
        {
          id: 1,
          name: "Hydrant",
          templates: [
            { name: "Hydrant", prototype: { attributes: { ASSET_TYPE: 1, MANUFACTURER: "MU" } } },
          ],
        },
        {
          id: 2,
          name: "Valve",
          templates: [
            {
              name: "Valve (AVK)",
              prototype: { attributes: { ASSET_TYPE: 2, MANUFACTURER: "AV" } },
            },
            {
              name: "Valve (Mueller)",
              prototype: { attributes: { ASSET_TYPE: 2, MANUFACTURER: "MU" } },
            },
          ],
        },
      ],
    };

    it("does not pick between several templates, so the type's field default applies alone", () => {
      // Three templates in total, so none decides the type; ASSET_TYPE falls back
      // to its field default (2, Valve), which itself has two templates.
      const result = arcGISNewFeatureProperties(typed, {});
      assert.equal(result.ASSET_TYPE, 2);
      assert.equal(result.MANUFACTURER, undefined);
    });

    it("applies the selected type's only template", () => {
      assert.deepEqual(arcGISNewFeatureProperties(typed, { ASSET_TYPE: 1 }), {
        ASSET_TYPE: 1,
        STATUS: 1,
        MANUFACTURER: "MU",
        NOTES: "none",
      });
    });

    it("takes the type from the layer's only template", () => {
      const single = { ...typed, types: [typed.types![0], { id: 2, name: "Valve" }] };
      assert.equal(arcGISNewFeatureProperties(single, {}).ASSET_TYPE, 1);
      assert.equal(arcGISNewFeatureProperties(single, {}).MANUFACTURER, "MU");
    });

    describe("with a selected template (#3179)", () => {
      const [, avk, mueller] = arcGISCreationTemplates(typed);

      it("applies the selected template and the type it belongs to", () => {
        assert.deepEqual(arcGISNewFeatureProperties(typed, {}, { template: mueller.selection }), {
          ASSET_TYPE: 2,
          STATUS: 1,
          MANUFACTURER: "MU",
          NOTES: "none",
        });
        assert.equal(
          arcGISNewFeatureProperties(typed, {}, { template: avk.selection }).MANUFACTURER,
          "AV",
        );
      });

      it("never replaces values on the feature or refills a cleared one", () => {
        const template = mueller.selection;
        assert.equal(
          arcGISNewFeatureProperties(typed, { MANUFACTURER: "XX" }, { template }).MANUFACTURER,
          "XX",
        );
        const cleared = arcGISNewFeatureProperties(
          typed,
          { MANUFACTURER: null },
          { template, keepGiven: true },
        );
        assert.equal(cleared.MANUFACTURER, null);
        assert.equal(cleared.ASSET_TYPE, 2);
      });

      it("does not apply a template of another type than the feature already has", () => {
        const result = arcGISNewFeatureProperties(
          typed,
          { ASSET_TYPE: 1 },
          { template: avk.selection },
        );
        // Type 1's own (only) template applies instead.
        assert.equal(result.ASSET_TYPE, 1);
        assert.equal(result.MANUFACTURER, "MU");
      });

      it("finds the template again in reloaded metadata, by content not position", () => {
        const reordered: ArcGISEditInfo = {
          ...structuredClone(typed),
          types: [structuredClone(typed.types![1]), structuredClone(typed.types![0])],
        };
        assert.equal(
          arcGISNewFeatureProperties(reordered, {}, { template: mueller.selection }).MANUFACTURER,
          "MU",
        );
      });

      it("ignores a selection whose template changed, keeping the defaults", () => {
        const changed = structuredClone(typed);
        changed.types![1].templates![1].prototype!.attributes!.MANUFACTURER = "CL";
        const result = arcGISNewFeatureProperties(changed, {}, { template: mueller.selection });
        assert.equal(result.ASSET_TYPE, 2);
        assert.equal(result.MANUFACTURER, undefined);
      });

      it("does not fall back to the only template left when the selection is stale", () => {
        const shrunk: ArcGISEditInfo = {
          ...structuredClone(typed),
          types: [structuredClone(typed.types![0])],
        };
        const result = arcGISNewFeatureProperties(shrunk, {}, { template: mueller.selection });
        assert.equal(result.MANUFACTURER, undefined);
        assert.equal(
          arcGISNewFeatureProperties(
            shrunk,
            { ASSET_TYPE: 1 },
            {
              template: mueller.selection,
            },
          ).MANUFACTURER,
          undefined,
        );
      });

      it("never fills server-managed fields from a template", () => {
        const managed: ArcGISEditInfo = {
          ...typed,
          types: [
            {
              id: 3,
              name: "Meter",
              templates: [
                { name: "M1", prototype: { attributes: { created_user: "me", OBJECTID: 7 } } },
                { name: "M2", prototype: { attributes: {} } },
              ],
            },
          ],
        };
        const [m1] = arcGISCreationTemplates(managed);
        const result = arcGISNewFeatureProperties(managed, {}, { template: m1.selection });
        assert.equal(result.ASSET_TYPE, 3);
        assert.equal(result.created_user, undefined);
        assert.equal(result.OBJECTID, undefined);
      });
    });
  });

  describe("with subtypes", () => {
    const subtyped: ArcGISEditInfo = {
      ...base,
      subtypeField: "ASSET_TYPE",
      defaultSubtypeCode: 1,
      subtypes: [
        { code: 1, name: "Hydrant", defaultValues: { pressure: 120, STATUS: 2 } },
        { code: 2, name: "Valve", defaultValues: { PRESSURE: 40 } },
      ],
    };

    it("uses defaultSubtypeCode over the field default, then that subtype's defaults", () => {
      assert.deepEqual(arcGISNewFeatureProperties(subtyped, {}), {
        ASSET_TYPE: 1,
        STATUS: 2,
        PRESSURE: 120,
        NOTES: "none",
      });
    });

    it("follows a subtype already on the feature", () => {
      assert.deepEqual(arcGISNewFeatureProperties(subtyped, { ASSET_TYPE: 2 }), {
        ASSET_TYPE: 2,
        STATUS: 1,
        PRESSURE: 40,
        NOTES: "none",
      });
    });

    it("matches a subtype code reported as a string", () => {
      assert.equal(arcGISNewFeatureProperties(subtyped, { ASSET_TYPE: "2" }).PRESSURE, 40);
    });

    it("ranks a template prototype above subtype defaults", () => {
      const withTemplate: ArcGISEditInfo = {
        ...subtyped,
        typeIdField: "ASSET_TYPE",
        types: [
          { id: 1, name: "Hydrant", templates: [{ prototype: { attributes: { PRESSURE: 99 } } }] },
        ],
      };
      assert.equal(arcGISNewFeatureProperties(withTemplate, {}).PRESSURE, 99);
    });
  });
});

describe("arcGISCreationTemplates", () => {
  const info: ArcGISEditInfo = {
    ...base,
    typeIdField: "ASSET_TYPE",
    types: [
      {
        id: 1,
        name: "Hydrant",
        templates: [
          { name: " Standard ", description: "Permanent install", prototype: { attributes: {} } },
          { name: "Standard", prototype: { attributes: { STATUS: 2 } } },
          // Listed under type 1 but its prototype says type 2: not offered.
          { name: "Broken", prototype: { attributes: { asset_type: 2 } } },
        ],
      },
    ],
    templates: [{ prototype: { attributes: { MANUFACTURER: "MU" } } }],
  };

  it("lists type and layer templates in metadata order, minus contradictory ones", () => {
    const templates = arcGISCreationTemplates(info);
    assert.deepEqual(
      templates.map(({ name, description, typeName, typeValue }) => ({
        name,
        description,
        typeName,
        typeValue,
      })),
      [
        { name: "Standard", description: "Permanent install", typeName: "Hydrant", typeValue: 1 },
        { name: "Standard", description: undefined, typeName: "Hydrant", typeValue: 1 },
        { name: "", description: undefined, typeName: undefined, typeValue: undefined },
      ],
    );
    assert.deepEqual(
      templates.map((template) => template.selection.index),
      [0, 1, 3],
    );
    // Same names, different templates: the selections stay distinct.
    assert.notEqual(templates[0].selection.fingerprint, templates[1].selection.fingerprint);
  });

  it("tolerates names and descriptions that are not text", () => {
    const odd = {
      ...base,
      templates: [
        { name: 7, description: { html: "x" }, prototype: { attributes: {} } },
        { name: null, prototype: { attributes: {} } },
      ],
    } as unknown as ArcGISEditInfo;
    assert.deepEqual(
      arcGISCreationTemplates(odd).map(({ name, description }) => ({ name, description })),
      [
        { name: "", description: undefined },
        { name: "", description: undefined },
      ],
    );
  });

  it("asks for a choice only on a creatable ArcGIS layer with several templates", () => {
    const layer = (metadata: Record<string, unknown>) => ({ metadata }) as unknown as GeoLibreLayer;
    const arcgis = { sourceKind: ARCGIS_FEATURE_SOURCE_KIND };
    assert.equal(
      arcGISLayerCreationTemplates(layer({ ...arcgis, arcgisEditInfo: info })).length,
      3,
    );
    assert.deepEqual(arcGISLayerCreationTemplates(layer({ arcgisEditInfo: info })), []);
    assert.deepEqual(
      arcGISLayerCreationTemplates(
        layer({ ...arcgis, arcgisEditInfo: { ...info, capabilities: "Query,Update" } }),
      ),
      [],
    );
    const single = { ...info, types: [], templates: info.templates };
    assert.deepEqual(
      arcGISLayerCreationTemplates(layer({ ...arcgis, arcgisEditInfo: single })),
      [],
    );
  });
});

describe("arcGISCopiedFeatureProperties", () => {
  it("keeps copied attributes but drops values the service assigns", () => {
    assert.deepEqual(
      arcGISCopiedFeatureProperties(base, {
        OBJECTID: 4,
        GlobalID: "{abc}",
        created_user: "someone",
        STATUS: 2,
        MANUFACTURER: "CL",
      }),
      { STATUS: 2, MANUFACTURER: "CL" },
    );
    assert.deepEqual([...arcGISServerManagedFields(base)].sort(), [
      "created_user",
      "globalid",
      "objectid",
    ]);
  });

  it("matches server-managed fields case-insensitively", () => {
    assert.deepEqual(
      arcGISCopiedFeatureProperties(base, { objectid: 4, globalId: "{abc}", STATUS: 2 }),
      { STATUS: 2 },
    );
  });
});

describe("geometry session write-back for ArcGIS layers", () => {
  const point = (id: number, x: number, properties: Record<string, unknown>): Feature => ({
    type: "Feature",
    id,
    properties: { OBJECTID: id, ...properties },
    geometry: { type: "Point", coordinates: [x, 0] },
  });
  const baseline: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      point(1, 0, { STATUS: 1, MANUFACTURER: "MU" }),
      point(2, 1, { STATUS: 2, MANUFACTURER: "CL" }),
    ],
  };
  const prepare = (properties: Record<string, unknown> | null, kind: NewEditedFeatureKind) =>
    kind === "copied"
      ? arcGISCopiedFeatureProperties(base, properties)
      : arcGISNewFeatureProperties(base, properties);

  /** Simulate a session: tag, let `edit` change the editor's features, reconcile. */
  const session = (edit: (features: Feature[]) => Feature[]) => {
    const tagged = tagFeatureKeys(baseline);
    const edited = edit(structuredClone(tagged.features));
    return reconcileEditedFeatures(
      { type: "FeatureCollection", features: edited },
      captureEditedProperties(tagged, baseline),
      undefined,
      {
        originalIds: captureEditedFeatureIds(tagged, baseline),
        originalGeometries: captureEditedGeometries(tagged),
        prepareNewFeature: prepare,
      },
    );
  };

  it("restores numeric object IDs, so an unchanged session has nothing to save", () => {
    const result = session((features) => features);
    assert.deepEqual(
      result.features.map((f) => f.id),
      [1, 2],
    );
    const plan = planArcGISEdits(baseline, result, base);
    assert.deepEqual([plan.adds.length, plan.updates.length, plan.deletes.length], [0, 0, 0]);
  });

  it("saves a moved feature as a geometry update", () => {
    const result = session((features) => {
      features[1].geometry = { type: "Point", coordinates: [5, 5] };
      return features;
    });
    const plan = planArcGISEdits(baseline, result, base);
    assert.equal(plan.updates.length, 1);
    assert.equal(plan.updates[0].objectId, 2);
    assert.equal(plan.adds.length, 0);
  });

  it("saves a copy as a new feature with the copied attributes, whichever comes first", () => {
    const result = session((features) => {
      const copy = structuredClone(features[0]);
      copy.geometry = { type: "Point", coordinates: [9, 9] };
      return [copy, ...features]; // Geoman may list the copy before its source.
    });
    assert.deepEqual(result.features.map((f) => f.id).slice(1), [1, 2]);
    const plan = planArcGISEdits(baseline, result, base);
    assert.deepEqual([plan.adds.length, plan.updates.length, plan.deletes.length], [1, 0, 0]);
    assert.deepEqual((plan.adds[0].payload as { attributes: unknown }).attributes, {
      STATUS: 1,
      MANUFACTURER: "MU",
    });
  });

  it("saves a drawn feature with the service's creation defaults", () => {
    const result = session((features) => [
      ...features,
      {
        type: "Feature",
        properties: { __gm_shape: "marker" },
        geometry: { type: "Point", coordinates: [3, 3] },
      },
    ]);
    const plan = planArcGISEdits(baseline, result, base);
    assert.equal(plan.adds.length, 1);
    assert.deepEqual((plan.adds[0].payload as { attributes: unknown }).attributes, {
      ASSET_TYPE: 2,
      STATUS: 1,
      NOTES: "none",
    });
    assert.equal(result.features[2].properties?.[GEOMETRY_EDIT_FID_PROPERTY], undefined);
  });

  it("keeps the identity on the moved piece when a split changes both", () => {
    const result = session((features) => {
      const pieceA = structuredClone(features[0]);
      const pieceB = structuredClone(features[0]);
      pieceA.geometry = { type: "Point", coordinates: [0.1, 0] };
      pieceB.geometry = { type: "Point", coordinates: [0.2, 0] };
      return [pieceA, pieceB, features[1]];
    });
    const plan = planArcGISEdits(baseline, result, base);
    assert.equal(plan.updates[0].objectId, 1);
    assert.equal(plan.adds.length, 1);
  });
});
