import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Feature, FeatureCollection } from "geojson";
import {
  arcGISCopiedFeatureProperties,
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
      "GlobalID",
      "OBJECTID",
      "created_user",
    ]);
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
