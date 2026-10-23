import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_BASEMAP,
  applyProjectToStore,
  createEmptyProject,
  parseProject,
  projectFromStore,
  serializeProject,
} from "@geolibre/core";
import { MssqlWriteRejectedError } from "@geolibre/processing";
import { geojsonLayer } from "./helpers/layer-fixtures";
import type { Feature, FeatureCollection } from "geojson";
import {
  MssqlWriteUncertainError,
  mssqlWritePayload,
  reconcileMssqlWritebackMetadata,
  rememberMssqlLoadedRows,
  resetMssqlLoadedRows,
  runMssqlWriteRequest,
  writeMssqlAndRefresh,
} from "../apps/geolibre-desktop/src/lib/mssql-writeback";
import {
  getRefreshFailureLayerPatch,
  isRefreshableLayer,
  supportsAutoRefresh,
} from "../apps/geolibre-desktop/src/lib/layer-refresh";

function feature(id: number | undefined, name: string): Feature {
  return {
    type: "Feature",
    ...(id === undefined ? {} : { id }),
    geometry: { type: "Point", coordinates: [0, 0] },
    properties: { name },
  };
}

function tableFeatures(rows: Map<number, string>): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [...rows].map(([id, name]) => feature(id, name)),
  };
}

describe("SQL Server write-back refresh recovery", () => {
  it("blocks replayed inserts until a successful refresh restores generated keys", async () => {
    let rows = new Map<number, string>([[1, "existing"]]);
    let nextId = 2;
    let writeCalls = 0;
    let failRefresh = true;
    const inFlightLayerIds = new Set<string>();
    const editedFeatures: FeatureCollection = {
      type: "FeatureCollection",
      features: [feature(1, "edited existing"), feature(undefined, "new row")],
    };
    const source = geojsonLayer({
      id: "layer-1",
      name: "SQL Server layer",
      type: "geojson",
      source: {},
      metadata: {
        sourceKind: "mssql-table",
        mssqlConnectionId: "saved-profile",
        mssqlTable: "parcels",
        mssqlPrimaryKey: "id",
        mssqlBaselineKeys: [1],
      },
      geojson: editedFeatures,
    });
    let activeLayer = source;
    const refreshTable = async () => {
      if (failRefresh) {
        failRefresh = false;
        throw new Error("table read unavailable");
      }
      const geojson = tableFeatures(rows);
      return { geojson, feature_count: geojson.features.length };
    };
    const submit = () =>
      writeMssqlAndRefresh(
        {
          layerId: activeLayer.id,
          inFlightLayerIds,
          refreshRequired: activeLayer.mssqlWritebackPending === true,
          baselineKeys: activeLayer.metadata.mssqlBaselineKeys as number[],
          isCurrent: () => true,
        },
        async () => {
          writeCalls += 1;
          let inserted = 0;
          for (const item of (activeLayer.geojson ?? editedFeatures).features) {
            const id = typeof item.id === "number" ? item.id : undefined;
            if (id === undefined) {
              rows.set(nextId++, String(item.properties?.name));
              inserted += 1;
            } else {
              rows.set(id, String(item.properties?.name));
            }
          }
          return { inserted };
        },
        refreshTable,
      );

    const firstSave = await submit();
    assert.equal(firstSave.kind, "refresh-failed");
    if (firstSave.kind !== "refresh-failed") return;
    assert.deepEqual(firstSave.writeResult, { inserted: 1 });
    assert.equal(rows.size, 2, "the first write committed before the refresh failed");
    assert.deepEqual(
      activeLayer.metadata,
      source.metadata,
      "the failed reread leaves metadata untouched",
    );

    activeLayer = { ...activeLayer, mssqlWritebackPending: true };
    const project = projectFromStore({
      projectName: "SQL Server recovery",
      mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
      basemapStyleUrl: DEFAULT_BASEMAP,
      basemapVisible: true,
      basemapOpacity: 1,
      layers: [activeLayer],
      preferences: createEmptyProject().preferences,
      metadata: {},
    });
    activeLayer = applyProjectToStore(parseProject(serializeProject(project))).layers[0];
    assert.equal(isRefreshableLayer(activeLayer), true, "manual refresh remains available");
    assert.equal(supportsAutoRefresh(activeLayer), false, "reconciliation is never automatic");
    const clearOnFailureLayer = {
      ...activeLayer,
      connection: {
        layerId: activeLayer.id,
        interval: null,
        lastSyncedAt: null,
        lastError: null,
        onFailure: "clear" as const,
      },
    };
    const recoveryFailurePatch = getRefreshFailureLayerPatch(
      clearOnFailureLayer,
      "table read unavailable",
      true,
      false,
    );
    assert.equal(
      recoveryFailurePatch.connection?.lastError,
      "table read unavailable",
      "a failed recovery reread still records the connection error",
    );
    assert.equal(
      recoveryFailurePatch.geojson,
      undefined,
      "failed recovery refreshes preserve local features even when the old policy was clear",
    );
    const ordinaryFailurePatch = getRefreshFailureLayerPatch(
      clearOnFailureLayer,
      "refresh unavailable",
      false,
      false,
    );
    assert.deepEqual(
      ordinaryFailurePatch.geojson,
      { type: "FeatureCollection", features: [] },
      "non-recovery refreshes retain the existing clear-on-failure policy",
    );

    const retry = await submit();
    assert.deepEqual(retry, { kind: "blocked" });
    assert.equal(writeCalls, 1, "a retry must not issue another table write");
    assert.equal(rows.size, 2, "the blocked retry cannot insert a duplicate row");
    failRefresh = true;
    await assert.rejects(refreshTable(), /table read unavailable/);
    assert.deepEqual(await submit(), { kind: "blocked" });
    assert.deepEqual(activeLayer.metadata.mssqlBaselineKeys, [1]);

    const refreshed = await refreshTable();
    activeLayer = {
      ...activeLayer,
      geojson: refreshed.geojson,
      mssqlWritebackPending: undefined,
      metadata: reconcileMssqlWritebackMetadata(activeLayer.metadata, refreshed),
    };
    assert.deepEqual(activeLayer.metadata.mssqlBaselineKeys, [1, 2]);

    const afterRefresh = await submit();
    assert.equal(afterRefresh.kind, "reconciled");
    assert.equal(writeCalls, 2);
    assert.equal(
      rows.size,
      2,
      "the reconciled retry updates known keys instead of inserting again",
    );
  });

  it("blocks overlapping inserts through both the write and reread", async () => {
    const rows = new Map<number, string>();
    const inFlightLayerIds = new Set<string>();
    let finishWrite!: () => void;
    let finishRead!: () => void;
    let readStarted!: () => void;
    const writePending = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    const readPending = new Promise<void>((resolve) => {
      finishRead = resolve;
    });
    const reading = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    const submit = () =>
      writeMssqlAndRefresh(
        {
          layerId: "identity-layer",
          inFlightLayerIds,
          refreshRequired: false,
          baselineKeys: [],
          isCurrent: () => true,
        },
        async () => {
          rows.set(rows.size + 1, "new feature");
          await writePending;
          return { inserted: 1 };
        },
        async () => {
          readStarted();
          await readPending;
          return { geojson: tableFeatures(rows), feature_count: rows.size };
        },
      );
    const first = submit();
    assert.deepEqual(await submit(), { kind: "blocked" });
    assert.deepEqual([...rows], [[1, "new feature"]]);
    finishWrite();
    await reading;
    assert.deepEqual(await submit(), { kind: "blocked" });
    assert.deepEqual([...rows], [[1, "new feature"]]);
    finishRead();
    const result = await first;
    assert.equal(result.kind, "reconciled");
    if (result.kind !== "reconciled") return;
    assert.deepEqual(
      result.refreshed.geojson.features.map((item) => item.id),
      [1],
    );
    assert.equal(inFlightLayerIds.has("identity-layer"), false);
  });

  it("blocks replay after a write commits but its response is lost", async () => {
    const rows = new Map<number, string>();
    let features: FeatureCollection = {
      type: "FeatureCollection",
      features: [feature(undefined, "new row")],
    };
    let failResponse = true;
    let writeCalls = 0;
    let writebackPending = false;
    const inFlightLayerIds = new Set<string>();
    const failure = new MssqlWriteUncertainError("write response lost");
    const refreshTable = async () => ({
      geojson: tableFeatures(rows),
      feature_count: rows.size,
    });
    const submit = () =>
      writeMssqlAndRefresh(
        {
          layerId: "layer",
          inFlightLayerIds,
          refreshRequired: writebackPending,
          baselineKeys: [],
          isCurrent: () => true,
        },
        async () => {
          writeCalls += 1;
          for (const item of features.features) {
            rows.set(
              typeof item.id === "number" ? item.id : rows.size + 1,
              String(item.properties?.name),
            );
          }
          if (failResponse) {
            failResponse = false;
            throw failure;
          }
          return { updated: 1 };
        },
        refreshTable,
      );
    const first = await submit();
    assert.deepEqual(first, { kind: "write-failed", error: failure });
    assert.deepEqual([...rows], [[1, "new row"]], "the failed response follows a committed insert");
    writebackPending = true;
    assert.deepEqual(await submit(), { kind: "blocked" });
    assert.equal(writeCalls, 1);
    const refreshed = await refreshTable();
    features = refreshed.geojson;
    writebackPending = false;
    assert.equal((await submit()).kind, "reconciled");
    assert.equal(writeCalls, 2, "the in-flight lock was released");
    assert.deepEqual(
      [...rows],
      [[1, "new row"]],
      "retry uses the reread identity, not another insert",
    );
  });

  it("discards an old project's table reread when a replacement reuses the layer ID", async () => {
    let generation = 1;
    const requestGeneration = generation;
    let finishRead!: () => void;
    let readStarted!: () => void;
    const pending = new Promise<void>((resolve) => {
      finishRead = resolve;
    });
    const reading = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    const operation = writeMssqlAndRefresh(
      {
        layerId: "shared-layer-id",
        inFlightLayerIds: new Set(),
        refreshRequired: false,
        baselineKeys: [1],
        isCurrent: () => generation === requestGeneration,
      },
      async () => ({ updated: 1 }),
      async () => {
        readStarted();
        await pending;
        return { geojson: tableFeatures(new Map([[1, "old project row"]])), feature_count: 1 };
      },
    );
    await reading;
    generation = 2;
    finishRead();
    assert.deepEqual(await operation, { kind: "stale" });
  });

  it("rejects a missing baseline without writing, but accepts an explicitly empty read baseline", async () => {
    let writeCalls = 0;
    const request = {
      layerId: "layer",
      inFlightLayerIds: new Set<string>(),
      refreshRequired: false,
      baselineKeys: undefined as ReadonlyArray<string | number> | undefined,
      isCurrent: () => true,
    };
    const write = async () => {
      writeCalls += 1;
      return { inserted: 1 };
    };
    const refresh = async () => ({
      geojson: tableFeatures(new Map([[1, "new row"]])),
      feature_count: 1,
    });
    assert.deepEqual(await writeMssqlAndRefresh(request, write, refresh), {
      kind: "missing-baseline",
    });
    assert.equal(writeCalls, 0);
    request.baselineKeys = [];
    assert.equal((await writeMssqlAndRefresh(request, write, refresh)).kind, "reconciled");
    assert.equal(writeCalls, 1);
  });
});

describe("SQL Server write payload baselines", () => {
  it("lists edited columns per loaded row and marks unchanged geometry for omission", () => {
    resetMssqlLoadedRows();
    const loaded: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: 1,
          geometry: { type: "Point", coordinates: [0, 0] },
          properties: { id: 1, name: "North", pop: 10 },
        },
      ],
    };
    rememberMssqlLoadedRows("layer", 4, "id", loaded);
    loaded.features[0].properties!.name = "mutated after remember";
    const edited: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          ...loaded.features[0],
          geometry: { type: "Point", coordinates: [0, 0] },
          properties: { id: 1, name: "North", pop: 11 },
        },
      ],
    };

    const payload = mssqlWritePayload("layer", 4, edited);

    assert.deepEqual(payload.changedColumns, [{ key: 1, columns: ["pop"] }]);
    assert.deepEqual(payload.unchangedGeometryKeys, [1]);

    const reopenedProjectPayload = mssqlWritePayload("layer", 5, edited);
    assert.deepEqual(reopenedProjectPayload, {});
    resetMssqlLoadedRows();
  });

  it("drops the baseline of a layer that is no longer in the project", () => {
    resetMssqlLoadedRows();
    const loaded: FeatureCollection = {
      type: "FeatureCollection",
      features: [feature(1, "North")],
    };
    const edited: FeatureCollection = {
      type: "FeatureCollection",
      features: [{ ...feature(1, "North"), properties: { id: 1, name: "South" } }],
    };
    rememberMssqlLoadedRows("removed-layer", 4, "id", loaded);
    assert.ok(mssqlWritePayload("removed-layer", 4, edited).changedColumns);

    // No layer with that id is in the store, so recording another baseline
    // releases it; a later save falls back to sending the full rows.
    rememberMssqlLoadedRows("layer", 4, "id", loaded);

    assert.deepEqual(mssqlWritePayload("removed-layer", 4, edited), {});
    assert.ok(mssqlWritePayload("layer", 4, edited).changedColumns);
    resetMssqlLoadedRows();
  });
});
describe("SQL Server write failure certainty", () => {
  it("keeps a confirmed rejection separate from an uncertain write", async () => {
    const request = {
      layerId: "layer",
      inFlightLayerIds: new Set<string>(),
      refreshRequired: false,
      baselineKeys: [] as Array<string | number>,
      isCurrent: () => true,
    };
    const refresh = async () => ({ geojson: tableFeatures(new Map()), feature_count: 0 });
    const rejected = new MssqlWriteRejectedError("write was rolled back");
    const rejectedOutcome = await writeMssqlAndRefresh(
      request,
      () =>
        runMssqlWriteRequest(async () => {
          throw rejected;
        }),
      refresh,
    );
    assert.equal(rejectedOutcome.kind, "write-rejected");
    if (rejectedOutcome.kind !== "write-rejected") return;
    assert.equal(rejectedOutcome.error, rejected);

    const uncertainOutcome = await writeMssqlAndRefresh(
      request,
      () =>
        runMssqlWriteRequest(async () => {
          throw new TypeError("connection dropped");
        }),
      refresh,
    );
    assert.equal(uncertainOutcome.kind, "write-failed");
    if (uncertainOutcome.kind !== "write-failed") return;
    assert.ok(uncertainOutcome.error instanceof MssqlWriteUncertainError);
    assert.equal(uncertainOutcome.error.message, "connection dropped");
  });
});
