import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  arcGISContingencyChecks,
  arcGISContingentChoices,
  blocksArcGISEdit,
  loadArcGISContingentValues,
  normalizeArcGISContingentValues,
} from "../packages/plugins/src/plugins/arcgis-contingent-values";
import {
  arcGISEditAttributes,
  type ArcGISEditInfo,
} from "../packages/plugins/src/plugins/arcgis-edits";

// The fields and domains of a hosted ArcGIS Online test layer: integer coded
// STATUS, text coded ZONE whose codes "1", "01" and "0" differ only by
// zeros, and a range-domain PRESSURE.
const fields: NonNullable<ArcGISEditInfo["fields"]> = [
  { name: "OBJECTID", type: "esriFieldTypeOID", editable: false, nullable: false },
  {
    name: "STATUS",
    type: "esriFieldTypeInteger",
    domain: {
      type: "codedValue",
      name: "AssetStatus",
      codedValues: [
        { name: "Active", code: 1 },
        { name: "Retired", code: 2 },
      ],
    },
  },
  {
    name: "ZONE",
    type: "esriFieldTypeString",
    domain: {
      type: "codedValue",
      name: "Zone",
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
  { name: "NOTES", type: "esriFieldTypeString" },
];
const base: ArcGISEditInfo = {
  objectIdField: "OBJECTID",
  capabilities: "Query,Create,Update,Delete",
  geometryType: "esriGeometryPoint",
  hasContingentValuesDefinition: true,
  fields,
};

/**
 * The layer's `/0/contingentValues` response as ArcGIS Online returned it
 * (compact format): a text code is a position in `stringDicts`, Any and Null
 * take no value, a range is `{ range: [min, max] }`, and a layer without
 * subtypes lists its combinations on the group itself.
 */
function liveResponse() {
  return {
    typeCodes: ["Unknown", "Any", "Null", "Code", "Range"],
    stringDicts: [{ domain: "Zone", entries: ["1", "01", "0"] }],
    contingentValuesDefinition: {
      layerID: 0,
      layerName: "Assets",
      geometryType: "esriGeometryPoint",
      hasSubType: false,
      fieldGroups: [
        {
          name: "zone_status",
          restrictive: true,
          fields: [
            { id: 0, name: "STATUS", fieldType: "esriFieldTypeInteger" },
            { id: 1, name: "ZONE", fieldType: "esriFieldTypeString" },
          ],
          domains: { STATUS: "AssetStatus", ZONE: "Zone" },
          contingentValues: [
            { id: 1, types: [3, 3], values: [1, 0] },
            { id: 2, types: [3, 3], values: [2, 1] },
            { id: 3, types: [1, 3], values: [2] },
            { id: 4, retired: 1, types: [3, 3], values: [1, 1] },
          ],
        },
        {
          name: "zone_pressure",
          restrictive: false,
          fields: [
            { id: 1, name: "ZONE", fieldType: "esriFieldTypeString" },
            { id: 2, name: "PRESSURE", fieldType: "esriFieldTypeInteger" },
          ],
          domains: { ZONE: "Zone", PRESSURE: "Pressure" },
          contingentValues: [
            { id: 5, types: [3, 4], values: [0, { range: [0, 50] }] },
            { id: 6, types: [3, 4], values: [0, { range: [100, 150] }] },
            { id: 7, types: [3, 2], values: [1] },
          ],
        },
      ],
    },
  };
}

const live = (): ArcGISEditInfo => ({
  ...base,
  contingentValues: normalizeArcGISContingentValues(liveResponse(), base, 0),
});

describe("normalizeArcGISContingentValues", () => {
  it("decodes the hosted compact format into typed codes", () => {
    assert.deepEqual(normalizeArcGISContingentValues(liveResponse(), base, 0), {
      status: "ready",
      groups: [
        {
          name: "zone_status",
          restrictive: true,
          fields: ["STATUS", "ZONE"],
          lists: [
            {
              contingencies: [
                {
                  id: 1,
                  retired: false,
                  values: [
                    { kind: "code", code: 1 },
                    { kind: "code", code: "1" },
                  ],
                },
                {
                  id: 2,
                  retired: false,
                  values: [
                    { kind: "code", code: 2 },
                    { kind: "code", code: "01" },
                  ],
                },
                { id: 3, retired: false, values: [{ kind: "any" }, { kind: "code", code: "0" }] },
                {
                  id: 4,
                  retired: true,
                  values: [
                    { kind: "code", code: 1 },
                    { kind: "code", code: "01" },
                  ],
                },
              ],
            },
          ],
        },
        {
          name: "zone_pressure",
          restrictive: false,
          fields: ["ZONE", "PRESSURE"],
          lists: [
            {
              contingencies: [
                {
                  id: 5,
                  retired: false,
                  values: [
                    { kind: "code", code: "1" },
                    { kind: "range", min: 0, max: 50 },
                  ],
                },
                {
                  id: 6,
                  retired: false,
                  values: [
                    { kind: "code", code: "1" },
                    { kind: "range", min: 100, max: 150 },
                  ],
                },
                { id: 7, retired: false, values: [{ kind: "code", code: "01" }, { kind: "null" }] },
              ],
            },
          ],
        },
      ],
    });
  });

  it("decodes the same definition from a service-wide query response", () => {
    const { contingentValuesDefinition, ...rest } = liveResponse();
    const query = {
      ...rest,
      contingentValuesDefinitions: [
        { ...contingentValuesDefinition, layerID: 3 },
        contingentValuesDefinition,
      ],
    };
    assert.deepEqual(
      normalizeArcGISContingentValues(query, base, 0),
      normalizeArcGISContingentValues(liveResponse(), base, 0),
    );
  });

  it("decodes per-subtype combinations, with the dictionary order the response gives", () => {
    const info: ArcGISEditInfo = {
      ...base,
      subtypeField: "KIND",
      subtypes: [
        { code: 100, name: "Airplane" },
        { code: 200, name: "Automobile" },
      ],
      fields: [
        { name: "KIND", type: "esriFieldTypeInteger" },
        { name: "MAKE", type: "esriFieldTypeInteger" },
        { name: "RATING", type: "esriFieldTypeString" },
      ],
    };
    const response = {
      typeCodes: ["Unknown", "Any", "Null", "Code", "Range"],
      // Not the domain's own order: positions must be read from this list.
      stringDicts: [{ domain: "drating", entries: ["Good", "Excellent"] }],
      contingentValuesDefinitions: [
        {
          layerID: 0,
          hasSubType: true,
          fieldGroups: [
            {
              name: "make_rating",
              restrictive: true,
              fields: [
                { id: 0, name: "make", fieldType: "esriFieldTypeInteger" },
                { id: 1, name: "rating", fieldType: "esriFieldTypeString" },
              ],
              subTypes: [
                {
                  code: 100,
                  domains: { make: "dmakes", rating: "drating" },
                  contingentValues: [{ id: 1, types: [3, 3], values: [3, 1] }],
                },
              ],
            },
          ],
        },
      ],
    };
    const decoded = normalizeArcGISContingentValues(response, info, 0);
    assert.equal(decoded.status, "ready");
    assert.deepEqual(decoded.status === "ready" && decoded.groups[0], {
      name: "make_rating",
      restrictive: true,
      fields: ["MAKE", "RATING"],
      lists: [
        {
          subtype: 100,
          contingencies: [
            {
              id: 1,
              retired: false,
              values: [
                { kind: "code", code: 3 },
                { kind: "code", code: "Excellent" },
              ],
            },
          ],
        },
      ],
    });
  });

  it("reports what it cannot decode instead of guessing", () => {
    const status = (mutate: (json: ReturnType<typeof liveResponse>) => unknown) => {
      const json = liveResponse();
      const result = normalizeArcGISContingentValues(mutate(json) ?? json, base, 0);
      return result.status === "unsupported" ? result.reason : result.status;
    };
    // A text code whose dictionary is missing: the position is not the code.
    assert.equal(
      status((json) => {
        json.stringDicts = [];
      }),
      "format",
    );
    // A position past the dictionary's end.
    assert.equal(
      status((json) => {
        json.contingentValuesDefinition.fieldGroups[0].contingentValues[0].values = [1, 9];
      }),
      "format",
    );
    // A numeric code outside the field's domain.
    assert.equal(
      status((json) => {
        json.contingentValuesDefinition.fieldGroups[0].contingentValues[0].values = [7, 0];
      }),
      "format",
    );
    // The value count does not match the value types.
    assert.equal(
      status((json) => {
        json.contingentValuesDefinition.fieldGroups[0].contingentValues[2].values = [2, 0];
      }),
      "format",
    );
    // An unknown value type.
    assert.equal(
      status((json) => {
        json.contingentValuesDefinition.fieldGroups[0].contingentValues[0].types = [0, 3];
      }),
      "format",
    );
    // A field the layer does not have.
    assert.equal(
      status((json) => {
        json.contingentValuesDefinition.fieldGroups[0].fields[0].name = "GONE";
      }),
      "format",
    );
    // The nonhosted format, which carries no field groups.
    assert.equal(
      status(() => ({ contingentValuesDefinitions: [{ layerID: 0, contingentValues: [] }] })),
      "noFieldGroups",
    );
  });
});

describe("loadArcGISContingentValues", () => {
  it("reads the layer resource, else the service operation, else reports unavailable", async () => {
    const urls: string[] = [];
    const layerUrl = "https://example.com/arcgis/rest/services/S/FeatureServer/0";
    const ok = await loadArcGISContingentValues(layerUrl, base, async (url) => {
      urls.push(url);
      return liveResponse();
    });
    assert.equal(ok.status, "ready");
    assert.deepEqual(urls, [`${layerUrl}/contingentValues`]);

    urls.length = 0;
    const fallback = await loadArcGISContingentValues(layerUrl, base, async (url) => {
      urls.push(url);
      if (url.endsWith("/contingentValues")) throw new Error("Not found");
      return {
        ...liveResponse(),
        contingentValuesDefinition: undefined,
        contingentValuesDefinitions: [liveResponse().contingentValuesDefinition],
      };
    });
    assert.equal(fallback.status, "ready");
    assert.equal(
      urls[1],
      "https://example.com/arcgis/rest/services/S/FeatureServer/queryContingentValues?layers=0",
    );

    const failed = await loadArcGISContingentValues(layerUrl, base, async () => {
      throw new Error("Token expired");
    });
    assert.deepEqual(failed, { status: "unavailable", reason: "Token expired" });
  });

  it("rejects when aborted, rather than reporting the rules unavailable", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      loadArcGISContingentValues(
        "https://example.com/FeatureServer/0",
        base,
        async () => {
          throw new Error("aborted");
        },
        controller.signal,
      ),
    );
  });
});

describe("arcGISContingencyChecks", () => {
  const statuses = (
    candidate: Record<string, unknown>,
    baseline?: Record<string, unknown> | null,
  ) =>
    Object.fromEntries(
      arcGISContingencyChecks(live(), candidate, baseline).map((check) => [
        check.group,
        `${check.status}${check.affected ? "" : " (existing)"}`,
      ]),
    );

  it("accepts a whole combination and never mixes values across combinations", () => {
    assert.deepEqual(statuses({ STATUS: 1, ZONE: "1", PRESSURE: 40 }), {
      zone_status: "ok",
      zone_pressure: "ok",
    });
    // Retired (2) and "1" each appear in some combination, but not together.
    assert.equal(statuses({ STATUS: 2, ZONE: "1" }).zone_status, "violation");
  });

  it("keeps text codes that differ only by leading zeros apart", () => {
    assert.equal(statuses({ STATUS: 2, ZONE: "01" }).zone_status, "ok");
    assert.equal(statuses({ STATUS: 2, ZONE: "1" }).zone_status, "violation");
    assert.equal(statuses({ STATUS: 2, ZONE: "0" }).zone_status, "ok"); // Any + "0"
  });

  it("enforces both of two separate ranges, and the gap between them", () => {
    assert.equal(statuses({ ZONE: "1", PRESSURE: 50 }).zone_pressure, "ok");
    assert.equal(statuses({ ZONE: "1", PRESSURE: 100 }).zone_pressure, "ok");
    assert.equal(statuses({ ZONE: "1", PRESSURE: 80 }).zone_pressure, "violation");
  });

  it("treats Null as a required null and skips groups that are entirely empty", () => {
    assert.equal(statuses({ ZONE: "01", PRESSURE: null }).zone_pressure, "ok");
    assert.equal(statuses({ ZONE: "01", PRESSURE: 10 }).zone_pressure, "violation");
    // An empty ZONE is still a value of zone_status, which has no Null entry for it.
    assert.equal(statuses({ STATUS: 1, ZONE: null }).zone_status, "violation");
    assert.deepEqual(statuses({ NOTES: "x" }), {});
  });

  it("reads drafted numeric text as the number the field stores", () => {
    assert.equal(statuses({ STATUS: "1", ZONE: "1" }).zone_status, "ok");
  });

  it("keeps a retired combination on an existing record but not as a new one", () => {
    const stored = { STATUS: 1, ZONE: "01", NOTES: "a" };
    assert.equal(statuses({ ...stored, NOTES: "b" }, stored).zone_status, "retired (existing)");
    assert.equal(statuses({ STATUS: 1, ZONE: "01" }).zone_status, "retired");
    assert.equal(
      statuses({ STATUS: 1, ZONE: "01" }, { STATUS: 2, ZONE: "01" }).zone_status,
      "retired",
    );
  });

  it("only marks groups whose values the edit changed as affected", () => {
    const stored = { STATUS: 2, ZONE: "1", PRESSURE: 80 };
    const checks = arcGISContingencyChecks(live(), { ...stored, NOTES: "fixed" }, stored);
    assert.ok(checks.every((check) => !check.affected));
    assert.ok(!checks.some(blocksArcGISEdit));
  });

  it("follows the record's subtype, leaving unlisted subtypes unconstrained", () => {
    const info: ArcGISEditInfo = {
      ...base,
      subtypeField: "KIND",
      subtypes: [
        { code: 1, name: "A" },
        { code: 2, name: "B" },
      ],
      fields: [...fields, { name: "KIND", type: "esriFieldTypeInteger" }],
    };
    const response = liveResponse();
    const group = response.contingentValuesDefinition.fieldGroups[0];
    const definition = {
      ...response,
      contingentValuesDefinition: {
        ...response.contingentValuesDefinition,
        hasSubType: true,
        fieldGroups: [
          {
            ...group,
            subTypes: [
              { code: 1, domains: group.domains, contingentValues: group.contingentValues },
            ],
          },
        ],
      },
    };
    const withRules = {
      ...info,
      contingentValues: normalizeArcGISContingentValues(definition, info, 0),
    };
    const check = (candidate: Record<string, unknown>, baseline?: Record<string, unknown>) =>
      arcGISContingencyChecks(withRules, candidate, baseline);
    assert.equal(check({ KIND: 1, STATUS: 2, ZONE: "1" })[0].status, "violation");
    assert.deepEqual(check({ KIND: 2, STATUS: 2, ZONE: "1" }), []);
    // Changing only the subtype makes the group the edit's responsibility.
    assert.equal(
      check({ KIND: 1, STATUS: 1, ZONE: "01" }, { KIND: 2, STATUS: 1, ZONE: "01" })[0].affected,
      true,
    );
  });
});

describe("arcGISContingentChoices", () => {
  it("lists the values that complete an active combination", () => {
    const fits = arcGISContingentChoices(live(), { STATUS: 2, ZONE: null }, "ZONE")!;
    // zone_status allows "01" and "0" with Retired; the advisory zone_pressure
    // recommends no combination with "0", so only "01" fits both.
    assert.deepEqual(
      ["1", "01", "0"].filter((code) => fits(code)),
      ["01"],
    );
    // With nothing else entered, every non-retired combination is a completion.
    const open = arcGISContingentChoices(live(), {}, "STATUS")!;
    assert.deepEqual(
      [1, 2].filter((code) => open(code)),
      [1, 2],
    );
  });

  it("does not offer a retired combination", () => {
    const fits = arcGISContingentChoices(live(), { ZONE: "01" }, "STATUS")!;
    // Active with "01" is retired; Retired with "01" is active.
    assert.equal(fits(1), false);
    assert.equal(fits(2), true);
  });

  it("satisfies every group a field belongs to", () => {
    // ZONE "1" fits STATUS Active, but PRESSURE 80 is in no "1" range.
    const fits = arcGISContingentChoices(live(), { STATUS: 1, PRESSURE: 80 }, "ZONE")!;
    assert.equal(fits("1"), false);
  });

  it("returns undefined for a field no group governs", () => {
    assert.equal(arcGISContingentChoices(live(), {}, "NOTES"), undefined);
  });
});

describe("arcGISEditAttributes with contingent values", () => {
  it("refuses a new feature in a restrictive violation, and allows an advisory one", () => {
    assert.throws(
      () => arcGISEditAttributes({ properties: { STATUS: 2, ZONE: "1" } }, undefined, live()),
      /not an allowed combination in field group zone_status/,
    );
    // zone_pressure is advisory: 80 is in neither range, but the save goes ahead.
    assert.deepEqual(
      arcGISEditAttributes(
        { properties: { STATUS: 1, ZONE: "1", PRESSURE: 80 } },
        undefined,
        live(),
      ),
      { STATUS: 1, ZONE: "1", PRESSURE: 80 },
    );
  });

  it("refuses an edit that introduces a retired combination", () => {
    assert.throws(
      () =>
        arcGISEditAttributes(
          { properties: { OBJECTID: 1, STATUS: 1, ZONE: "01" } },
          { properties: { OBJECTID: 1, STATUS: 2, ZONE: "01" } },
          live(),
        ),
      /retired combination/,
    );
  });

  it("sends only changed fields, without repairing an unrelated historical violation", () => {
    const stored = { OBJECTID: 2, STATUS: 2, ZONE: "1", NOTES: "a" };
    assert.deepEqual(
      arcGISEditAttributes(
        { properties: { ...stored, NOTES: "b" } },
        { properties: stored },
        live(),
      ),
      { NOTES: "b" },
    );
  });

  it("validates a group change against the unchanged fields too", () => {
    const stored = { OBJECTID: 1, STATUS: 1, ZONE: "1" };
    assert.throws(
      () =>
        arcGISEditAttributes(
          { properties: { ...stored, STATUS: 2 } },
          { properties: stored },
          live(),
        ),
      /zone_status/,
    );
    assert.deepEqual(
      arcGISEditAttributes(
        { properties: { ...stored, STATUS: 2, ZONE: "01" } },
        { properties: stored },
        live(),
      ),
      { STATUS: 2, ZONE: "01" },
    );
  });

  it("holds new features and attribute changes while the rules are unavailable", () => {
    const info: ArcGISEditInfo = {
      ...base,
      contingentValues: { status: "unavailable", reason: "HTTP 500" },
    };
    assert.throws(
      () => arcGISEditAttributes({ properties: { STATUS: 1 } }, undefined, info),
      /could not be loaded \(HTTP 500\)/,
    );
    const stored = { properties: { OBJECTID: 1, STATUS: 1 } };
    assert.throws(
      () => arcGISEditAttributes({ properties: { OBJECTID: 1, STATUS: 2 } }, stored, info),
      /could not be loaded/,
    );
    // Nothing changed in the attributes: a shape-only update still goes through.
    assert.deepEqual(arcGISEditAttributes(stored, stored, info), {});
  });

  it("leaves an unsupported definition to the server", () => {
    const info: ArcGISEditInfo = {
      ...base,
      contingentValues: { status: "unsupported", reason: "noFieldGroups" },
    };
    assert.deepEqual(
      arcGISEditAttributes({ properties: { STATUS: 2, ZONE: "1" } }, undefined, info),
      {
        STATUS: 2,
        ZONE: "1",
      },
    );
  });
});
