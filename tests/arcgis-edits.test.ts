import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Feature, FeatureCollection } from "geojson";
import { useAppStore } from "@geolibre/core";
import {
  arcGISGeometry,
  reconcileArcGISRefresh,
  planArcGISEdits,
  type ArcGISEditInfo,
} from "../packages/plugins/src/plugins/arcgis-edits";
import {
  addArcGISLayer,
  arcGISLayerHasPendingEdits,
  refreshArcGISFeatureLayer,
  saveArcGISLayerEdits,
  setArcGISFetch,
} from "../packages/plugins/src/plugins/arcgis-layer";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";
const info: ArcGISEditInfo = {
  objectIdField: "OBJECTID",
  geometryType: "esriGeometryPoint",
  capabilities: "Query,Create,Update,Delete",
  fields: [
    { name: "OBJECTID", type: "esriFieldTypeOID", editable: false },
    { name: "name", type: "esriFieldTypeString", length: 20 },
    {
      name: "status",
      type: "esriFieldTypeInteger",
      domain: { type: "codedValue", codedValues: [{ code: 1 }, { code: 2 }] },
    },
  ],
};
const feature = (id?: number, name = "before"): Feature => ({
  type: "Feature",
  ...(id === undefined ? {} : { id }),
  properties: { ...(id === undefined ? {} : { OBJECTID: id }), name },
  geometry: { type: "Point", coordinates: [-84, 35] },
});
const fc = (...features: Feature[]): FeatureCollection => ({ type: "FeatureCollection", features });
const url = "https://example.com/FeatureServer/0";
afterEach(() => {
  setArcGISFetch(null);
  useAppStore.setState({ layers: [] });
});

describe("ArcGIS edit validation", () => {
  it("sends only changed attributes and scopes deletes to the downloaded baseline", () => {
    const plan = planArcGISEdits(
      fc(feature(1), feature(2)),
      fc(feature(1, "after"), feature()),
      info,
    );
    assert.deepEqual(plan.updates[0].payload, { attributes: { OBJECTID: 1, name: "after" } });
    assert.deepEqual(plan.deletes, [2]);
    assert.equal(plan.adds.length, 1);
    assert.deepEqual(planArcGISEdits(fc(feature(1)), fc(), info).deletes, [1]);
  });
  it("validates permissions, IDs, domains, fields and geometry restrictions", () => {
    assert.throws(
      () =>
        planArcGISEdits(fc(feature(1)), fc(feature(1, "after")), {
          ...info,
          capabilities: "Query",
        }),
      /does not allow/,
    );
    assert.throws(() => planArcGISEdits(fc(feature(1)), fc(feature(9)), info), /IDs cannot/);
    assert.throws(
      () => planArcGISEdits(fc(feature(1)), fc(feature(1), feature(1)), info),
      /duplicated/,
    );
    const invalid = feature(1);
    invalid.properties!.status = 3;
    assert.throws(() => planArcGISEdits(fc(feature(1)), fc(invalid), info), /domain/);
    invalid.properties = { OBJECTID: 1, invented: true };
    assert.throws(() => planArcGISEdits(fc(feature(1)), fc(invalid), info), /not writable/);
    invalid.properties = { OBJECTID: 1, name: "before" };
    invalid.geometry = { type: "Point", coordinates: [1, 2] };
    assert.throws(
      () => planArcGISEdits(fc(feature(1)), fc(invalid), { ...info, allowGeometryUpdates: false }),
      /geometry updates/,
    );
  });
  it("tags WGS84 and orients polygon shells clockwise and holes counterclockwise", () => {
    const shell = [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 0],
    ];
    const hole = [
      [1, 1],
      [1, 2],
      [2, 2],
      [1, 1],
    ];
    assert.deepEqual(
      arcGISGeometry(
        { type: "Polygon", coordinates: [shell, hole] },
        { geometryType: "esriGeometryPolygon" },
      ),
      {
        rings: [[...shell].reverse(), [...hole].reverse()],
        hasZ: false,
        spatialReference: { wkid: 4326 },
      },
    );
    assert.throws(
      () => arcGISGeometry({ type: "Point", coordinates: [1, 2, 3] }, info),
      /dimensions/,
    );
  });
});

async function load(
  handler: (body: URLSearchParams) => unknown | Promise<unknown>,
  initial = fc(feature(1), feature(2)),
) {
  let postCount = 0;
  setArcGISFetch(async (input, init) => {
    const requestUrl = new URL(String(input));
    if (init?.method === "POST") {
      postCount++;
      assert.equal(requestUrl.pathname, "/FeatureServer/0/applyEdits");
      assert.equal(init.redirect, "error");
      return Response.json(await handler(new URLSearchParams(String(init.body))));
    }
    if (requestUrl.pathname.endsWith("/query")) {
      const ids = requestUrl.searchParams.get("objectIds");
      return Response.json(
        ids ? fc(...ids.split(",").map((id) => feature(Number(id), "server"))) : initial,
      );
    }
    return Response.json(info);
  });
  const id = await addArcGISLayer({ fitBounds() {} } as GeoLibreAppAPI, {
    layerType: "feature",
    sourceType: "url",
    url,
    token: "private-token",
  });
  return { id, posts: () => postCount };
}
const layer = (id: string) => useAppStore.getState().layers.find((l) => l.id === id)!;

it("reconciles partial results and server IDs; retry does not repeat successful inserts", async () => {
  const connection = await load((body) => {
    assert.equal(body.get("token"), "private-token");
    if (body.has("adds"))
      return {
        addResults: [{ success: true, objectId: 3 }],
        updateResults: [{ success: false, error: { description: "Locked" } }],
        deleteResults: [{ success: true, objectId: 2 }],
      };
    return { updateResults: [{ success: true, objectId: 1 }] };
  });
  useAppStore
    .getState()
    .updateLayer(connection.id, { geojson: fc(feature(1, "after"), feature()) });
  const result = await saveArcGISLayerEdits(connection.id);
  assert.equal(result.inserted, 1);
  assert.equal(result.deleted, 1);
  assert.match(result.errors[0], /Locked/);
  assert.equal(layer(connection.id).geojson!.features[1].properties!.OBJECTID, 3);
  assert.equal(layer(connection.id).geojson!.features[1].properties!.name, "server");
  assert.equal(JSON.stringify(layer(connection.id)).includes("private-token"), false);
  assert.equal(arcGISLayerHasPendingEdits(connection.id), true);
  await saveArcGISLayerEdits(connection.id);
  assert.equal(arcGISLayerHasPendingEdits(connection.id), false);
  await saveArcGISLayerEdits(connection.id);
  assert.equal(connection.posts(), 2);
});

it("never writes back geometry that was loaded generalized", async () => {
  const { id, posts } = await load(
    (body) => {
      assert.equal(body.has("adds"), false);
      const [update] = JSON.parse(body.get("updates")!);
      assert.equal(update.geometry, undefined, "an attribute edit leaves geometry out");
      return { updateResults: [{ success: true, objectId: 1 }] };
    },
    fc(feature(1)),
  );
  // As the viewport loader leaves a layer whose shapes it loaded simplified.
  const markGeneralized = () =>
    useAppStore.getState().updateLayer(id, {
      metadata: {
        ...layer(id).metadata,
        arcgisEditInfo: { ...info, geometryGeneralized: true },
      },
    });
  markGeneralized();
  const moved = feature(1);
  moved.geometry = { type: "Point", coordinates: [-83, 36] };
  useAppStore.getState().updateLayer(id, { geojson: fc(moved) });
  await assert.rejects(saveArcGISLayerEdits(id), /Zoom in to edit/);
  assert.equal(posts(), 0);

  useAppStore.getState().updateLayer(id, { geojson: fc(feature(1, "after")) });
  assert.equal((await saveArcGISLayerEdits(id)).updated, 1);
  assert.equal(posts(), 1);
  assert.equal(
    (layer(id).metadata.arcgisEditInfo as ArcGISEditInfo).geometryGeneralized,
    true,
    "the save keeps the marker for the shapes still loaded",
  );
});

it("supports deleting the last feature", async () => {
  const { id } = await load(
    (body) => {
      assert.equal(body.get("deletes"), "1");
      return { deleteResults: [{ success: true, objectId: 1 }] };
    },
    fc(feature(1)),
  );
  useAppStore.getState().updateLayer(id, { geojson: fc() });
  assert.equal((await saveArcGISLayerEdits(id)).deleted, 1);
  assert.equal(arcGISLayerHasPendingEdits(id), false);
});

it("preserves pending edits on refresh and blocks retry after an unknown write outcome", async () => {
  const { id, posts } = await load(() => {
    throw new Error("Connection lost");
  });
  const edited = fc(feature(1, "pending"));
  useAppStore.getState().updateLayer(id, { geojson: edited });
  assert.deepEqual(
    await refreshArcGISFeatureLayer({ layerId: id, queryUrl: `${url}/query` }),
    edited,
  );
  await assert.rejects(saveArcGISLayerEdits(id), /could not be confirmed/);
  await assert.rejects(saveArcGISLayerEdits(id), /previous save/);
  assert.equal(posts(), 1);
  assert.equal(layer(id).metadata.arcgisSaveUncertain, true);
});

it("keeps concurrent changes pending after a successful update", async () => {
  let id: string;
  ({ id } = await load(() => {
    useAppStore.getState().updateLayer(id, { geojson: fc(feature(1, "concurrent"), feature(2)) });
    return { updateResults: [{ success: true, objectId: 1 }] };
  }));
  useAppStore.getState().updateLayer(id, { geojson: fc(feature(1, "submitted"), feature(2)) });
  await saveArcGISLayerEdits(id);
  assert.equal(layer(id).geojson!.features[0].properties!.name, "concurrent");
  assert.equal(arcGISLayerHasPendingEdits(id), true);
});

it("merges server-calculated fields into a concurrently edited feature", () => {
  const submitted = feature(1, "submitted");
  submitted.properties!.calculated = 10;
  const current = structuredClone(submitted);
  current.properties!.name = "concurrent";
  const fresh = structuredClone(submitted);
  fresh.properties!.calculated = 20;
  assert.deepEqual(reconcileArcGISRefresh(current, submitted, fresh).properties, {
    OBJECTID: 1,
    name: "concurrent",
    calculated: 20,
  });
});

it("rejects copied object IDs on new features instead of updating a remote record", () => {
  const baseline = fc(feature(1));
  for (const localId of [undefined, "new-drawing"]) {
    const copy = feature(1, "unrelated");
    copy.id = localId;
    assert.throws(() => planArcGISEdits(baseline, fc(copy), info), /object IDs cannot/);
  }
});

it("a reorder is not a pending edit and no-op save does not pin the viewport", async () => {
  const { id, posts } = await load(() => assert.fail("No writes for a reorder"));
  useAppStore.getState().updateLayer(id, { geojson: fc(feature(2), feature(1)) });
  assert.equal(arcGISLayerHasPendingEdits(id), false);
  await saveArcGISLayerEdits(id);
  assert.equal(posts(), 0);
  assert.equal(arcGISLayerHasPendingEdits(id), false);
});

it("assigns an identity to server records missing GeoJSON ids", async () => {
  const downloaded = feature(1);
  delete downloaded.id;
  const { id } = await load(
    () => ({ updateResults: [{ success: true, objectId: 1 }] }),
    fc(downloaded),
  );
  const edited = structuredClone(layer(id).geojson!);
  assert.equal(edited.features[0].id, 1);
  edited.features[0].properties!.name = "edited";
  useAppStore.getState().updateLayer(id, { geojson: edited });
  assert.equal((await saveArcGISLayerEdits(id)).updated, 1);
});

it("keeps inserted feature identity consistent with its refreshed baseline", async () => {
  let writes = 0;
  const { id } = await load(
    () =>
      ++writes === 1
        ? { addResults: [{ success: true, objectId: 3 }] }
        : { updateResults: [{ success: true, objectId: 3 }] },
    fc(),
  );
  useAppStore.getState().updateLayer(id, { geojson: fc(feature()) });
  await saveArcGISLayerEdits(id);
  assert.equal(arcGISLayerHasPendingEdits(id), false);
  const edited = structuredClone(layer(id).geojson!);
  edited.features[0].properties!.name = "edited again";
  useAppStore.getState().updateLayer(id, { geojson: edited });
  assert.equal((await saveArcGISLayerEdits(id)).updated, 1);
  assert.equal(arcGISLayerHasPendingEdits(id), false);
});

it("fills missing Z only from an explicitly enabled finite service default", () => {
  const point = { type: "Point" as const, coordinates: [1, 2] };
  const zInfo = { ...info, hasZ: true, enableZDefaults: true, zDefault: 12 };
  assert.deepEqual(arcGISGeometry(point, zInfo), {
    x: 1,
    y: 2,
    z: 12,
    spatialReference: { wkid: 4326 },
  });
  assert.deepEqual(point.coordinates, [1, 2]);
  assert.deepEqual(
    arcGISGeometry(
      {
        type: "MultiLineString",
        coordinates: [
          [
            [1, 2],
            [3, 4, 9],
          ],
        ],
      },
      { ...zInfo, geometryType: "esriGeometryPolyline" },
    ),
    {
      paths: [
        [
          [1, 2, 12],
          [3, 4, 9],
        ],
      ],
      hasZ: true,
      spatialReference: { wkid: 4326 },
    },
  );
  for (const settings of [
    {},
    { enableZDefaults: false, zDefault: 12 },
    { enableZDefaults: true },
    { enableZDefaults: true, zDefault: Infinity },
  ]) {
    assert.throws(
      () => arcGISGeometry(point, { ...info, hasZ: true, ...settings }),
      /requires a finite Z/,
    );
  }
  assert.deepEqual(
    arcGISGeometry({ type: "Point", coordinates: [1, 2, 7] }, { ...info, hasZ: true }),
    { x: 1, y: 2, z: 7, spatialReference: { wkid: 4326 } },
  );
  assert.throws(
    () => arcGISGeometry({ type: "Point", coordinates: [1, 2, NaN] }, zInfo),
    /dimensions/,
  );
  assert.throws(
    () => arcGISGeometry({ type: "Point", coordinates: [1, 2, 3, 4] }, zInfo),
    /dimensions/,
  );
  const baseline = feature(1);
  const edited = feature(1, "attribute only");
  assert.deepEqual(
    planArcGISEdits(fc(baseline), fc(edited), { ...info, hasZ: true }).updates[0].payload,
    { attributes: { OBJECTID: 1, name: "attribute only" } },
  );
});

it("reports malformed service URLs before attempting a save", async () => {
  const { id, posts } = await load(() => assert.fail("Malformed URL must not write"));
  useAppStore
    .getState()
    .updateLayer(id, { source: { ...layer(id).source, arcgisQueryUrl: "not a URL/query" } });
  await assert.rejects(saveArcGISLayerEdits(id), /Invalid ArcGIS service URL/);
  assert.equal(posts(), 0);
});
