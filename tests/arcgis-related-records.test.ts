import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Feature, FeatureCollection } from "geojson";
import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import {
  addArcGISRelatedRecord,
  arcGISRelatedEditSupport,
  arcGISRelatedFields,
  arcGISRelatedParentKey,
  arcGISRelatedParentObjectId,
  arcGISRelationships,
  deleteArcGISRelatedRecord,
  fetchArcGISRelatedTableInfo,
  queryArcGISRelatedRecords,
  updateArcGISRelatedRecord,
  type ArcGISRelatedTableInfo,
} from "../packages/plugins/src/plugins/arcgis-related-records";
import { addArcGISLayer, setArcGISFetch } from "../packages/plugins/src/plugins/arcgis-layer";
import {
  addArcGISAttachment,
  arcGISRelatedAttachmentSupport,
  listArcGISAttachments,
} from "../packages/plugins/src/plugins/arcgis-attachments";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";
import {
  relatedDisplayText,
  relatedInputValue,
  relatedValueOutsideDomain,
} from "../apps/geolibre-desktop/src/lib/arcgis-related-values";

const service = "https://example.com/arcgis/rest/services/Hydrants/FeatureServer";

/** The parent layer: keyed by AssetID (not the object ID) for both relationships. */
const hydrantInfo = {
  objectIdField: "OBJECTID",
  geometryType: "esriGeometryPoint",
  capabilities: "Query,Create,Update,Delete",
  fields: [
    { name: "OBJECTID", type: "esriFieldTypeOID", editable: false },
    { name: "AssetID", type: "esriFieldTypeString", length: 20 },
  ],
  relationships: [
    {
      id: 0,
      name: "Inspections",
      relatedTableId: 1,
      cardinality: "esriRelCardinalityOneToMany",
      role: "esriRelRoleOrigin",
      keyField: "AssetID",
      composite: false,
    },
    {
      id: 1,
      name: "Maintenance",
      relatedTableId: 2,
      cardinality: "esriRelCardinalityOneToMany",
      role: "esriRelRoleOrigin",
      keyField: "AssetID",
      composite: false,
    },
  ],
};

const inspectionInfo: ArcGISRelatedTableInfo = {
  name: "Inspections",
  type: "Table",
  objectIdField: "OBJECTID",
  globalIdField: "GlobalID",
  capabilities: "Query,Create,Update,Delete",
  maxRecordCount: 2,
  fields: [
    { name: "OBJECTID", type: "esriFieldTypeOID", editable: false },
    { name: "GlobalID", type: "esriFieldTypeGlobalID", editable: false },
    { name: "HydrantAssetID", type: "esriFieldTypeString", length: 20 },
    {
      name: "Status",
      type: "esriFieldTypeInteger",
      defaultValue: 1,
      domain: {
        type: "codedValue",
        name: "InspectionStatus",
        codedValues: [
          { name: "Pass", code: 1 },
          { name: "Fail", code: 2 },
          { name: "Needs repair", code: 3 },
        ],
      },
    },
    {
      name: "Pressure",
      type: "esriFieldTypeDouble",
      domain: { type: "range", name: "PressureRange", range: [0, 200] },
    },
    {
      name: "Inspector",
      type: "esriFieldTypeString",
      length: 40,
      nullable: false,
      defaultValue: "Field crew",
    },
    { name: "Notes", type: "esriFieldTypeString", length: 100, nullable: true },
    { name: "EditDate", type: "esriFieldTypeDate", editable: false },
  ],
  relationships: [
    {
      id: 0,
      name: "Hydrant",
      relatedTableId: 0,
      cardinality: "esriRelCardinalityOneToMany",
      role: "esriRelRoleDestination",
      keyField: "HydrantAssetID",
      composite: false,
    },
  ],
};

const hydrant = (id: number, asset: string | null): Feature => ({
  type: "Feature",
  id,
  properties: { OBJECTID: id, AssetID: asset },
  geometry: { type: "Point", coordinates: [-84, 35] },
});
const fc = (...features: Feature[]): FeatureCollection => ({ type: "FeatureCollection", features });

interface Row {
  OBJECTID: number;
  [key: string]: unknown;
}

afterEach(() => {
  setArcGISFetch(null);
  useAppStore.setState({ layers: [] });
});

/**
 * A layer backed by a fake service. Hydrant 7 (H-001) has three inspections,
 * hydrant 8 (H-002) none. `paging` toggles related-query pagination.
 */
async function load({
  paging = true,
  parentInfo = hydrantInfo as Record<string, unknown>,
}: { paging?: boolean; parentInfo?: Record<string, unknown> } = {}) {
  const rows: Row[] = [
    { OBJECTID: 1, HydrantAssetID: "H-001", Status: 1, Pressure: 62.5, Inspector: "A. Lee" },
    { OBJECTID: 2, HydrantAssetID: "H-001", Status: 9, Pressure: 41, Inspector: "B. Diaz" },
    { OBJECTID: 3, HydrantAssetID: "H-001", Status: 1, Pressure: 60, Inspector: "A. Lee" },
  ];
  let nextId = 4;
  const posts: Array<{ path: string; body: URLSearchParams }> = [];
  const gets: URL[] = [];
  let failNextPost: "throw" | "502" | undefined;
  const parent = {
    ...parentInfo,
    advancedQueryCapabilities: { supportsQueryRelatedPagination: paging },
  };
  setArcGISFetch(async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/arcgis/rest/services/Hydrants/FeatureServer", "");
    if ((init?.method ?? "GET") === "POST") {
      assert.equal(init?.redirect, "error");
      if (init?.body instanceof FormData) {
        // An attachment upload to a related row.
        posts.push({ path, body: new URLSearchParams() });
        assert.equal(init.body.get("token"), "secret");
        return Response.json({ addAttachmentResult: { objectId: 41, success: true } });
      }
      const body = new URLSearchParams(String(init?.body));
      posts.push({ path, body });
      if (failNextPost) {
        const failure = failNextPost;
        failNextPost = undefined;
        if (failure === "throw") throw new TypeError("network down");
        return new Response("<html>Proxy error</html>", { status: 502 });
      }
      assert.equal(path, "/1/applyEdits");
      assert.equal(body.get("rollbackOnFailure"), "true");
      if (body.has("adds")) {
        const [{ attributes }] = JSON.parse(body.get("adds")!);
        const id = nextId++;
        rows.push({ ...attributes, OBJECTID: id });
        return Response.json({ addResults: [{ objectId: id, success: true }] });
      }
      if (body.has("updates")) {
        const [{ attributes }] = JSON.parse(body.get("updates")!);
        const row = rows.find((r) => r.OBJECTID === attributes.OBJECTID)!;
        Object.assign(row, attributes);
        return Response.json({ updateResults: [{ objectId: row.OBJECTID, success: true }] });
      }
      const id = Number(body.get("deletes"));
      rows.splice(
        rows.findIndex((r) => r.OBJECTID === id),
        1,
      );
      return Response.json({ deleteResults: [{ objectId: id, success: true }] });
    }
    gets.push(url);
    if (path === "/0/query") return Response.json(fc(hydrant(7, "H-001"), hydrant(8, "H-002")));
    if (path === "/0" || path === "/0/") return Response.json(parent);
    if (path === "/1") return Response.json(inspectionInfo);
    if (path === "/2") return Response.json({ error: { code: 400, message: "Invalid URL" } });
    if (path === "/1/2/attachments")
      return Response.json({
        attachmentInfos: [{ id: 40, name: "gauge.jpg", contentType: "image/jpeg", size: 9 }],
      });
    if (path === "/0/queryRelatedRecords") {
      const oid = Number(url.searchParams.get("objectIds"));
      const asset = oid === 7 ? "H-001" : "H-002";
      const all = rows.filter((r) => r.HydrantAssetID === asset);
      const offset = Number(url.searchParams.get("resultOffset") ?? 0);
      // The server's own cap is two rows per page, whatever was asked for.
      const count = Math.min(Number(url.searchParams.get("resultRecordCount") ?? 2), 2);
      const page = all.slice(offset, offset + count);
      return Response.json({
        relatedRecordGroups: page.length
          ? [{ objectId: oid, relatedRecords: page.map((attributes) => ({ attributes })) }]
          : [],
        exceededTransferLimit: offset + count < all.length,
      });
    }
    return new Response("not found", { status: 404 });
  });
  const app = { getMap: () => null, fitBounds: () => undefined } as unknown as GeoLibreAppAPI;
  await addArcGISLayer(app, {
    layerType: "feature",
    sourceType: "url",
    url: `${service}/0`,
    token: "secret",
  });
  const layer = useAppStore.getState().layers[0];
  return {
    layer,
    rows,
    posts,
    gets,
    failNext: (mode: "throw" | "502") => (failNextPost = mode),
  };
}

describe("arcGISRelationships", () => {
  it("reads published relationships from the layer metadata", async () => {
    const { layer } = await load();
    const relationships = arcGISRelationships(layer);
    assert.deepEqual(
      relationships.map((r) => [r.id, r.name, r.relatedTableId, r.cardinality, r.role, r.keyField]),
      [
        [0, "Inspections", 1, "oneToMany", "origin", "AssetID"],
        [1, "Maintenance", 2, "oneToMany", "origin", "AssetID"],
      ],
    );
  });

  it("is empty for layers without relationships or that cannot be queried", async () => {
    const { layer } = await load();
    assert.deepEqual(
      arcGISRelationships({
        ...layer,
        metadata: { ...layer.metadata, arcgisEditInfo: { objectIdField: "OBJECTID" } },
      }),
      [],
    );
    assert.deepEqual(
      arcGISRelationships({ ...layer, capabilities: { query: false } } as GeoLibreLayer),
      [],
    );
    assert.deepEqual(arcGISRelationships(null), []);
  });
});

describe("related record edit support", () => {
  it("takes the foreign key from the related table's own relationship entry", async () => {
    const { layer } = await load();
    const [inspections] = arcGISRelationships(layer);
    assert.deepEqual(arcGISRelatedEditSupport(layer, inspections, inspectionInfo), {
      add: true,
      update: true,
      delete: true,
      foreignKeyField: "HydrantAssetID",
    });
    // The parent key is the published key field, never the object ID.
    assert.equal(arcGISRelatedParentKey(layer, inspections, hydrant(7, "H-001")), "H-001");
    assert.equal(arcGISRelatedParentKey(layer, inspections, hydrant(7, null)), undefined);
    assert.equal(arcGISRelatedParentObjectId(layer, hydrant(7, "H-001")), 7);
  });

  it("is read-only without the reverse entry, from the destination side, or for many-to-many", async () => {
    const { layer } = await load();
    const [inspections] = arcGISRelationships(layer);
    const none = { add: false, update: false, delete: false };
    assert.deepEqual(
      arcGISRelatedEditSupport(layer, inspections, { ...inspectionInfo, relationships: [] }),
      none,
    );
    assert.deepEqual(
      arcGISRelatedEditSupport(layer, { ...inspections, role: "destination" }, inspectionInfo),
      none,
    );
    assert.deepEqual(
      arcGISRelatedEditSupport(
        layer,
        { ...inspections, cardinality: "manyToMany" },
        inspectionInfo,
      ),
      none,
    );
    assert.deepEqual(
      arcGISRelatedEditSupport(layer, { ...inspections, relationshipTableId: 5 }, inspectionInfo),
      none,
    );
  });

  it("follows the related table's capabilities and adds only to tables", async () => {
    const { layer } = await load();
    const [inspections] = arcGISRelationships(layer);
    const queryOnly = arcGISRelatedEditSupport(layer, inspections, {
      ...inspectionInfo,
      capabilities: "Query",
    });
    assert.deepEqual([queryOnly.add, queryOnly.update, queryOnly.delete], [false, false, false]);
    const spatial = arcGISRelatedEditSupport(layer, inspections, {
      ...inspectionInfo,
      geometryType: "esriGeometryPoint",
    });
    assert.deepEqual([spatial.add, spatial.update, spatial.delete], [false, true, true]);
    const mapServer = {
      ...layer,
      source: {
        ...layer.source,
        arcgisQueryUrl: String(layer.source.arcgisQueryUrl).replace("FeatureServer", "MapServer"),
      },
    } as GeoLibreLayer;
    assert.equal(arcGISRelatedEditSupport(mapServer, inspections, inspectionInfo).update, false);
  });
});

describe("queryArcGISRelatedRecords", () => {
  it("pages through every related row in object ID order", async () => {
    const { layer, gets } = await load();
    const [inspections] = arcGISRelationships(layer);
    const result = await queryArcGISRelatedRecords(layer.id, 7, inspections, inspectionInfo);
    assert.equal(result.complete, true);
    assert.deepEqual(
      result.records.map((r) => r.objectId),
      [1, 2, 3],
    );
    const queries = gets.filter((url) => url.pathname.endsWith("/queryRelatedRecords"));
    assert.equal(queries.length, 2);
    assert.equal(queries[0].searchParams.get("relationshipId"), "0");
    assert.equal(queries[0].searchParams.get("returnGeometry"), "false");
    assert.equal(queries[0].searchParams.get("orderByFields"), "OBJECTID ASC");
    assert.equal(queries[1].searchParams.get("resultOffset"), "2");
    assert.equal(queries[0].searchParams.get("token"), "secret");
  });

  it("advances by the rows received when the server caps pages below the size asked", async () => {
    const { layer, gets } = await load();
    const [inspections] = arcGISRelationships(layer);
    // The service serves one row per page although two were asked for.
    const result = await queryArcGISRelatedRecords(layer.id, 7, inspections, {
      ...inspectionInfo,
      maxRecordCount: 3,
    });
    assert.deepEqual(
      result.records.map((r) => r.objectId),
      [1, 2, 3],
    );
    assert.equal(result.complete, true);
    const offsets = gets
      .filter((url) => url.pathname.endsWith("/queryRelatedRecords"))
      .map((url) => url.searchParams.get("resultOffset"));
    assert.deepEqual(offsets, ["0", "2"]);
  });

  it("reports a capped result as incomplete when the service cannot page", async () => {
    const { layer } = await load({ paging: false });
    const [inspections] = arcGISRelationships(layer);
    const result = await queryArcGISRelatedRecords(layer.id, 7, inspections, inspectionInfo);
    assert.equal(result.complete, false);
    assert.equal(result.records.length, 2);
  });

  it("returns an empty list for a parent without related rows", async () => {
    const { layer } = await load();
    const [inspections] = arcGISRelationships(layer);
    const result = await queryArcGISRelatedRecords(layer.id, 8, inspections, inspectionInfo);
    assert.deepEqual(result, { records: [], complete: true });
  });

  it("rejects rows reported under another parent", async () => {
    const { layer } = await load();
    const [inspections] = arcGISRelationships(layer);
    setArcGISFetch(async () =>
      Response.json({
        relatedRecordGroups: [{ objectId: 8, relatedRecords: [{ attributes: { OBJECTID: 1 } }] }],
      }),
    );
    await assert.rejects(
      queryArcGISRelatedRecords(layer.id, 7, inspections, inspectionInfo),
      /unexpected related records response/,
    );
  });

  it("explains a related table the service does not serve", async () => {
    const { layer } = await load();
    const [, maintenance] = arcGISRelationships(layer);
    await assert.rejects(
      fetchArcGISRelatedTableInfo(layer.id, maintenance),
      /related table 2 is not available/,
    );
    assert.equal(
      (await fetchArcGISRelatedTableInfo(layer.id, { relatedTableId: 1 })).name,
      "Inspections",
    );
  });
});

describe("related record writes", () => {
  it("adds a row with the table's defaults and the parent's key", async () => {
    const { layer, rows, posts } = await load();
    const [inspections] = arcGISRelationships(layer);
    const support = arcGISRelatedEditSupport(layer, inspections, inspectionInfo);
    const id = await addArcGISRelatedRecord(
      layer.id,
      inspections,
      inspectionInfo,
      support,
      "H-002",
      { Pressure: 55, HydrantAssetID: "H-999", OBJECTID: 99, GlobalID: "{X}" },
    );
    assert.equal(id, 4);
    const sent = JSON.parse(posts[0].body.get("adds")!)[0].attributes;
    // Defaults fill empty fields; the foreign key comes from the parent and
    // cannot be overridden; server-managed values are left to the service.
    assert.deepEqual(sent, {
      Pressure: 55,
      HydrantAssetID: "H-002",
      Status: 1,
      Inspector: "Field crew",
    });
    assert.equal(posts[0].body.get("token"), "secret");
    assert.equal(rows.at(-1)?.HydrantAssetID, "H-002");
  });

  it("validates against the related table's domains before sending", async () => {
    const { layer, posts } = await load();
    const [inspections] = arcGISRelationships(layer);
    const support = arcGISRelatedEditSupport(layer, inspections, inspectionInfo);
    await assert.rejects(
      addArcGISRelatedRecord(layer.id, inspections, inspectionInfo, support, "H-001", {
        Pressure: 500,
      }),
      /outside its allowed range/,
    );
    await assert.rejects(
      addArcGISRelatedRecord(layer.id, inspections, inspectionInfo, support, "H-001", {
        Status: 7,
      }),
      /outside its coded value domain/,
    );
    await assert.rejects(
      addArcGISRelatedRecord(layer.id, inspections, inspectionInfo, support, "H-001", {
        Notes: "x".repeat(101),
      }),
      /exceeds its maximum length/,
    );
    assert.equal(posts.length, 0);
  });

  it("updates only changed attributes and keeps an untouched historical value", async () => {
    const { layer, posts, rows } = await load();
    const [inspections] = arcGISRelationships(layer);
    const support = arcGISRelatedEditSupport(layer, inspections, inspectionInfo);
    // Row 2 holds Status 9, outside the domain; editing Notes must still save.
    const record = { objectId: 2, attributes: { ...rows[1] } };
    assert.equal(
      await updateArcGISRelatedRecord(layer.id, inspections, inspectionInfo, support, record, {
        Notes: "Cap replaced",
      }),
      true,
    );
    assert.deepEqual(JSON.parse(posts[0].body.get("updates")!), [
      { attributes: { Notes: "Cap replaced", OBJECTID: 2 } },
    ]);
    assert.equal(rows[1].Status, 9);
    assert.equal(
      await updateArcGISRelatedRecord(layer.id, inspections, inspectionInfo, support, record, {
        Pressure: 41,
      }),
      false,
    );
    assert.equal(posts.length, 1);
  });

  it("refuses to move a row to another parent", async () => {
    const { layer, posts, rows } = await load();
    const [inspections] = arcGISRelationships(layer);
    const support = arcGISRelatedEditSupport(layer, inspections, inspectionInfo);
    await assert.rejects(
      updateArcGISRelatedRecord(
        layer.id,
        inspections,
        inspectionInfo,
        support,
        { objectId: 1, attributes: { ...rows[0] } },
        { HydrantAssetID: "H-002" },
      ),
      /relationship key of a related record cannot be changed/,
    );
    assert.equal(posts.length, 0);
  });

  it("deletes one row by its object ID", async () => {
    const { layer, posts, rows } = await load();
    const [inspections] = arcGISRelationships(layer);
    const support = arcGISRelatedEditSupport(layer, inspections, inspectionInfo);
    await deleteArcGISRelatedRecord(layer.id, inspections, support, 3);
    assert.equal(posts[0].body.get("deletes"), "3");
    assert.deepEqual(
      rows.map((r) => r.OBJECTID),
      [1, 2],
    );
  });

  it("reports a lost response as unconfirmed and a refusal with the service's message", async () => {
    const { layer, failNext } = await load();
    const [inspections] = arcGISRelationships(layer);
    const support = arcGISRelatedEditSupport(layer, inspections, inspectionInfo);
    const add = () =>
      addArcGISRelatedRecord(layer.id, inspections, inspectionInfo, support, "H-001", {});
    failNext("throw");
    await assert.rejects(add(), /could not be confirmed/);
    failNext("502");
    await assert.rejects(add(), /could not be confirmed/);
    setArcGISFetch(async () =>
      Response.json({
        addResults: [{ success: false, error: { code: 1000, description: "Rejected by rule" } }],
      }),
    );
    await assert.rejects(add(), /Rejected by rule/);
    setArcGISFetch(async () => Response.json({ error: { code: 403, message: "nope" } }));
    await assert.rejects(add(), /do not have permission/);
  });
});

describe("attachments of related rows", () => {
  it("follow the related table's metadata and the parent's permissions", async () => {
    const { layer } = await load();
    assert.equal(arcGISRelatedAttachmentSupport(layer, inspectionInfo), undefined);
    const withFiles = { ...inspectionInfo, hasAttachments: true };
    assert.deepEqual(arcGISRelatedAttachmentSupport(layer, withFiles), {
      list: true,
      add: true,
      update: true,
      delete: true,
    });
    assert.deepEqual(
      arcGISRelatedAttachmentSupport(layer, { ...withFiles, capabilities: "Query" }),
      { list: true, add: false, update: false, delete: false },
    );
    const readOnly = { ...layer, capabilities: { update: false, create: false } } as GeoLibreLayer;
    assert.equal(arcGISRelatedAttachmentSupport(readOnly, withFiles)?.add, false);
  });

  it("are listed and added under the related table, not the parent layer", async () => {
    const { layer, gets, posts } = await load();
    const source = { layerId: layer.id, tableId: 1 };
    const list = await listArcGISAttachments(source, 2);
    assert.deepEqual(
      list.map((a) => [a.id, a.name]),
      [[40, "gauge.jpg"]],
    );
    assert.ok(gets.some((url) => url.pathname.endsWith("/FeatureServer/1/2/attachments")));
    const id = await addArcGISAttachment(source, 2, new Blob(["x"]), "note.txt");
    assert.equal(id, 41);
    assert.equal(posts.at(-1)?.path, "/1/2/addAttachment");
    await assert.rejects(listArcGISAttachments({ layerId: layer.id, tableId: -1 }, 2), /table ID/);
  });
});

describe("related field model", () => {
  it("follows the related table's own fields and domains", () => {
    const fields = arcGISRelatedFields(inspectionInfo, { foreignKeyField: "HydrantAssetID" }, null);
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
    assert.equal(byName.OBJECTID.editable, false);
    assert.equal(byName.GlobalID.editable, false);
    assert.equal(byName.EditDate.editable, false);
    assert.equal(byName.HydrantAssetID.editable, false);
    assert.equal(byName.HydrantAssetID.managedKey, true);
    assert.deepEqual(
      byName.Status.codedValues?.map((c) => c.code),
      [1, 2, 3],
    );
    assert.deepEqual([byName.Pressure.min, byName.Pressure.max], [0, 200]);
    assert.equal(byName.Inspector.required, true);
    assert.equal(byName.Notes.maxLength, 100);
    assert.equal(byName.EditDate.kind, "date");
  });

  it("converts input to stored values and flags historical values", () => {
    const [status] = arcGISRelatedFields(inspectionInfo, {}, null).filter(
      (f) => f.name === "Status",
    );
    const [pressure] = arcGISRelatedFields(inspectionInfo, {}, null).filter(
      (f) => f.name === "Pressure",
    );
    assert.equal(relatedInputValue(status, "2"), 2);
    assert.equal(relatedInputValue(status, ""), null);
    assert.equal(relatedInputValue(pressure, "41.5"), 41.5);
    assert.equal(relatedInputValue(pressure, "abc"), "abc");
    assert.equal(relatedValueOutsideDomain(status, 9), true);
    assert.equal(relatedValueOutsideDomain(status, 3), false);
    assert.equal(relatedValueOutsideDomain(pressure, 250), true);
    assert.equal(relatedDisplayText(status, 3, "en"), "Needs repair");
    assert.equal(relatedDisplayText(status, 9, "en"), "9");
  });
});
