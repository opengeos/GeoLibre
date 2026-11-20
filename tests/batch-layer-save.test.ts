import { useAppStore } from "./helpers/dom";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { CollaborationState, GeoLibreLayer } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import type { TFunction } from "i18next";

const {
  applyExternalCopyReferences,
  canCollaboratorEditLayer,
  clearLayerGeometryEditedFlag,
  defaultSelectedWritableLayerIds,
  listWritableLayerCandidates,
  saveGeojsonCopiesToDirectory,
  saveLayerEditsBatch,
  writableLayerDestinationLabel,
  writableLayerSourceKind,
  writeLayerEditsToSource,
} = await import("../apps/geolibre-desktop/src/lib/batch-layer-save");

const t = ((key: string, params?: Record<string, unknown>) =>
  params ? `${key}:${JSON.stringify(params)}` : key) as unknown as TFunction;

const sampleFeatureCollection: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [10, 20] },
      properties: { title: "Town" },
    },
  ],
};

function makeLayer(
  id: string,
  name: string,
  overrides: Partial<GeoLibreLayer> = {},
): GeoLibreLayer {
  return {
    id,
    name,
    type: "geojson",
    visible: true,
    opacity: 1,
    source: {},
    style: {},
    sourcePath: `/data/${id}.geojson`,
    geojson: structuredClone(sampleFeatureCollection),
    metadata: {},
    ...overrides,
  } as GeoLibreLayer;
}

describe("writable layer classification and listing", () => {
  it("classifies local GeoJSON, GeoPackage, PostGIS, and SQL Server sources", () => {
    assert.equal(writableLayerSourceKind(makeLayer("a", "A")), "geojson");
    assert.equal(
      writableLayerSourceKind(makeLayer("b", "B", { sourcePath: "/data/map.gpkg" })),
      "geopackage",
    );
    assert.equal(
      writableLayerSourceKind(
        makeLayer("c", "C", {
          sourcePath: undefined,
          metadata: {
            sourceKind: "postgis-table",
            postgisSchema: "world",
            postgisTable: "rivers",
            postgisPrimaryKey: "id",
          },
        }),
      ),
      "postgis",
    );
    assert.equal(
      writableLayerSourceKind(
        makeLayer("d", "D", {
          sourcePath: undefined,
          metadata: {
            sourceKind: "mssql-table",
            mssqlSchema: "geo",
            mssqlTable: "borders",
            mssqlPrimaryKey: "id",
            mssqlConnectionId: "conn-1",
          },
        }),
      ),
      "mssql",
    );
    assert.equal(writableLayerSourceKind(makeLayer("e", "E", { sourcePath: "/data/a.shp" })), null);
  });

  it("formats human-readable destination labels", () => {
    assert.equal(writableLayerDestinationLabel(makeLayer("a", "A"), "geojson"), "/data/a.geojson");
    assert.equal(
      writableLayerDestinationLabel(
        makeLayer("c", "C", {
          metadata: { sourceKind: "postgis-table", postgisSchema: "world", postgisTable: "rivers" },
        }),
        "postgis",
      ),
      "world.rivers",
    );
    assert.equal(
      writableLayerDestinationLabel(
        makeLayer("d", "D", {
          metadata: { sourceKind: "mssql-table", mssqlTable: "borders" },
        }),
        "mssql",
      ),
      "dbo.borders",
    );
  });

  it("lists writable candidates with pending edit flags and blockers", () => {
    const edited = makeLayer("edited", "Edited", { metadata: { geometryEdited: true } });
    const draftOnly = makeLayer("draft", "Draft");
    const untouched = makeLayer("clean", "Clean");
    const geomBusy = makeLayer("busy", "Editing Geometry");
    const readOnlyCap = makeLayer("ro", "Read Only", {
      capabilities: { create: false, update: false, delete: false },
    });
    const mssqlPending = makeLayer("ms", "MSSQL Pending", {
      sourcePath: undefined,
      mssqlWritebackPending: true,
      metadata: {
        sourceKind: "mssql-table",
        mssqlTable: "parcels",
        mssqlPrimaryKey: "id",
        mssqlConnectionId: "conn-1",
      },
    });

    const candidates = listWritableLayerCandidates(
      [edited, draftOnly, untouched, geomBusy, readOnlyCap, mssqlPending],
      {
        geometryEditLayerId: "busy",
        attributeTableDrafts: { draft: { dirty: true } },
        canWriteSource: () => true,
      },
    );

    assert.deepEqual(
      candidates.map((c) => c.layer.id),
      ["edited", "draft", "clean", "busy", "ms"],
    );
    assert.equal(candidates[0].hasPendingEdits, true);
    assert.equal(candidates[1].hasPendingEdits, true);
    assert.equal(candidates[2].hasPendingEdits, false);
    assert.equal(candidates[3].disabledReason, "geometryEditActive");
    assert.equal(candidates[4].disabledReason, "mssqlRefreshRequired");

    // Pre-selects only enabled edited layers when any have pending edits.
    assert.deepEqual(defaultSelectedWritableLayerIds(candidates), ["edited", "draft"]);
    // Falls back to all enabled layers when none are marked edited.
    const cleanOnly = candidates.filter((c) => !c.hasPendingEdits);
    assert.deepEqual(defaultSelectedWritableLayerIds(cleanOnly), ["clean"]);
  });

  it("respects collaboration viewer/lock permissions", () => {
    const collab: CollaborationState = {
      ...useAppStore.getState().collaboration,
      isActive: true,
      sessionId: "s1",
      role: "guest",
      mode: "co-edit",
      clientId: "me",
      participants: [
        {
          clientId: "me",
          displayName: "Me",
          color: "#000",
          role: "guest",
          editOverride: null,
        },
      ],
      lockedLayerIds: ["locked"],
    };

    assert.equal(canCollaboratorEditLayer(collab, "locked"), false);
    assert.equal(canCollaboratorEditLayer(collab, "open"), true);
    assert.equal(canCollaboratorEditLayer(undefined, "locked"), true);
  });
});

describe("clearLayerGeometryEditedFlag", () => {
  beforeEach(() => {
    useAppStore.setState({
      projectGeneration: 5,
      layers: [makeLayer("a", "A", { metadata: { geometryEdited: true, custom: 1 } })],
    });
  });

  it("removes geometryEdited only when generation and saved geojson revision match", () => {
    const savedGeojson = useAppStore.getState().layers[0].geojson!;
    clearLayerGeometryEditedFlag("a", 4, savedGeojson);
    assert.equal(useAppStore.getState().layers[0].metadata.geometryEdited, true);

    const newerGeojson: FeatureCollection = { type: "FeatureCollection", features: [] };
    clearLayerGeometryEditedFlag("a", 5, newerGeojson);
    assert.equal(useAppStore.getState().layers[0].metadata.geometryEdited, true);

    clearLayerGeometryEditedFlag("a", 5, savedGeojson);
    assert.equal(useAppStore.getState().layers[0].metadata.geometryEdited, undefined);
    assert.equal(useAppStore.getState().layers[0].metadata.custom, 1);
  });
});

describe("writeLayerEditsToSource and saveLayerEditsBatch", () => {
  it("writes local GeoJSON directly on desktop and clears geometryEdited", async () => {
    const written: Array<{ path: string; count: number }> = [];
    const cleared: string[] = [];
    const layer = makeLayer("roads", "Roads", { metadata: { geometryEdited: true } });

    const res = await writeLayerEditsToSource(layer, {
      map: undefined,
      t,
      canEditLayer: () => true,
      deps: {
        isDesktop: () => true,
        commitDrafts: () => "none",
        readLatestLayer: () => layer,
        readProjectGeneration: () => 1,
        resolveGeojson: async () => layer.geojson!,
        writeLocalGeojson: async (path, geojson) => {
          written.push({ path, count: geojson.features.length });
        },
        clearGeometryEdited: (id) => cleared.push(id),
      },
    });

    assert.equal(res.status, "success");
    assert.deepEqual(written, [{ path: "/data/roads.geojson", count: 1 }]);
    assert.deepEqual(cleared, ["roads"]);
  });

  it("routes GeoPackage files through the sidecar and clears geometryEdited", async () => {
    let sidecarStarted = false;
    const layer = makeLayer("parcels", "Parcels", { sourcePath: "/data/parcels.gpkg" });

    const res = await writeLayerEditsToSource(layer, {
      map: undefined,
      t,
      canEditLayer: () => true,
      deps: {
        isDesktop: () => true,
        commitDrafts: () => "none",
        readLatestLayer: () => layer,
        readProjectGeneration: () => 2,
        resolveGeojson: async () => layer.geojson!,
        startSidecar: async () => {
          sidecarStarted = true;
        },
        writeVectorSource: async () => ({
          feature_count: 1,
          path: "/data/parcels.gpkg",
          layer: null,
          messages: [],
        }),
        clearGeometryEdited: () => {},
      },
    });

    assert.equal(sidecarStarted, true);
    assert.equal(res.status, "success");
  });

  it("reports blocked drafts and empty collections without writing", async () => {
    const layer = makeLayer("a", "A");
    const blocked = await writeLayerEditsToSource(layer, {
      map: undefined,
      t,
      canEditLayer: () => true,
      deps: {
        commitDrafts: () => "blocked",
        readLatestLayer: () => layer,
        readProjectGeneration: () => 1,
      },
    });
    assert.equal(blocked.status, "error");
    assert.equal(blocked.message, "layers.pendingTableDraftsBlocked");

    const emptyLayer = makeLayer("b", "B", {
      geojson: { type: "FeatureCollection", features: [] },
    });
    const empty = await writeLayerEditsToSource(emptyLayer, {
      map: undefined,
      t,
      canEditLayer: () => true,
      deps: {
        isDesktop: () => true,
        commitDrafts: () => "none",
        readLatestLayer: () => emptyLayer,
        readProjectGeneration: () => 1,
        resolveGeojson: async () => emptyLayer.geojson!,
      },
    });
    assert.equal(empty.status, "error");
    assert.equal(empty.message, "layers.saveEditsNoFeatures");
  });

  it("runs batch saves sequentially, tracks per-layer outcomes, and aborts on project switch", async () => {
    const l1 = makeLayer("l1", "Layer 1");
    const l2 = makeLayer("l2", "Layer 2");
    const l3 = makeLayer("l3", "Layer 3");
    let generation = 10;
    const started: string[] = [];

    const summary = await saveLayerEditsBatch([l1, l2, l3], {
      map: undefined,
      t,
      projectGeneration: 10,
      canEditLayer: () => true,
      onLayerStart: (id) => started.push(id),
      deps: {
        isDesktop: () => true,
        commitDrafts: () => "none",
        readLatestLayer: (id) => [l1, l2, l3].find((l) => l.id === id),
        readProjectGeneration: () => generation,
        resolveGeojson: async (layer) => layer.geojson!,
        writeLocalGeojson: async (path) => {
          if (path.includes("l2")) {
            generation = 11; // simulate project switch before l3
            throw new Error("disk full");
          }
        },
        clearGeometryEdited: () => {},
      },
    });

    assert.deepEqual(started, ["l1", "l2"]);
    assert.equal(summary.succeeded, 1);
    assert.equal(summary.failed, 0);
    assert.equal(summary.aborted, true);
    assert.equal(summary.results.length, 1);
  });

  it("skips removed layers during a batch run and does not overwrite existing copy files", async () => {
    const l1 = makeLayer("l1", "Layer 1");
    const l2 = makeLayer("l2", "Layer 2");
    const live = new Map<string, GeoLibreLayer>([
      ["l1", l1],
      ["l2", l2],
    ]);
    const writtenPaths: string[] = [];

    const summary = await saveLayerEditsBatch([l1, l2], {
      map: undefined,
      t,
      projectGeneration: 1,
      canEditLayer: () => true,
      deps: {
        isDesktop: () => true,
        commitDrafts: () => "none",
        readLatestLayer: (id) => live.get(id),
        readProjectGeneration: () => 1,
        resolveGeojson: async (layer) => layer.geojson!,
        writeLocalGeojson: async (path) => {
          writtenPaths.push(path);
          live.delete("l2"); // remove l2 while l1 writes
        },
        clearGeometryEdited: () => {},
      },
    });
    assert.deepEqual(writtenPaths, ["/data/l1.geojson"]);
    assert.equal(summary.results.length, 1);

    // Exclusive copy creation retries with suffix when destination already exists.
    const existing = new Set<string>(["/data/Layer-1.geojson"]);
    const copyRes = await saveGeojsonCopiesToDirectory([l1], "/data", {
      map: undefined,
      projectGeneration: 1,
      deps: {
        readProjectGeneration: () => 1,
        commitDrafts: () => "none",
        readLatestLayer: () => l1,
        resolveGeojson: async () => l1.geojson!,
        writeTextFile: async (path) => {
          if (existing.has(path)) {
            throw new Error("File exists (os error 17)");
          }
          existing.add(path);
        },
      },
    });
    assert.equal(copyRes.errors.length, 0);
    assert.equal(copyRes.written[0].path, "/data/Layer-1-2.geojson");
    assert.equal(copyRes.written[0].capturedGeojson, l1.geojson);

    // applyExternalCopyReferences embeds instead of repointing when live geojson changed,
    // even if the live layer mutated during async resolution before the copy finished.
    const mutatedGeojson: FeatureCollection = { type: "FeatureCollection", features: [] };
    const mutated = {
      ...l1,
      metadata: { geometryEdited: true },
      geojson: mutatedGeojson,
    };
    let liveLayer: GeoLibreLayer = l1;
    const raceCopy = await saveGeojsonCopiesToDirectory([l1], "/data", {
      map: undefined,
      projectGeneration: 1,
      deps: {
        readProjectGeneration: () => 1,
        commitDrafts: () => "none",
        readLatestLayer: () => liveLayer,
        resolveGeojson: async (layer) => {
          const resolved = layer.geojson!;
          liveLayer = mutated; // mutate live layer while resolution is in flight
          return resolved;
        },
        writeTextFile: async () => {},
      },
    });
    assert.equal(raceCopy.written[0].capturedGeojson, l1.geojson);
    const [afterMutate] = applyExternalCopyReferences(
      [mutated],
      new Map([
        [
          "l1",
          {
            path: raceCopy.written[0].path,
            capturedGeojson: raceCopy.written[0].capturedGeojson,
          },
        ],
      ]),
    );
    assert.equal(afterMutate.sourcePath, "/data/l1.geojson");
    assert.equal(afterMutate.metadata.localFileReloadable, undefined);
    assert.equal(afterMutate.metadata.geometryEdited, undefined);
  });
});

describe("saveGeojsonCopiesToDirectory and applyExternalCopyReferences", () => {
  it("writes deduplicated GeoJSON copies into the chosen folder", async () => {
    const l1 = makeLayer("1", "Borders");
    const l2 = makeLayer("2", "Borders");
    const files = new Map<string, string>();

    const result = await saveGeojsonCopiesToDirectory([l1, l2], "/exports/v2", {
      map: undefined,
      deps: {
        commitDrafts: () => "none",
        readLatestLayer: (id) => [l1, l2].find((l) => l.id === id),
        resolveGeojson: async (layer) => layer.geojson!,
        writeTextFile: async (path, content) => {
          files.set(path, content);
        },
      },
    });

    assert.equal(result.errors.length, 0);
    assert.deepEqual(
      result.written.map((w) => w.path),
      ["/exports/v2/Borders.geojson", "/exports/v2/Borders-2.geojson"],
    );
    assert.equal(files.size, 2);
    assert.deepEqual(
      JSON.parse(files.get("/exports/v2/Borders.geojson")!),
      sampleFeatureCollection,
    );
  });

  it("repoints plain local layers to their new copies and embeds non-plain edited layers", () => {
    const plain = makeLayer("p", "Plain", {
      sourcePath: "/orig/plain.gpkg",
      metadata: { geometryEdited: true, sourceLayer: "tbl" },
    });
    const wfs = makeLayer("w", "WFS", {
      sourcePath: undefined,
      source: { url: "https://example.com/wfs" },
      metadata: { sourceKind: "wfs-getfeature", geometryEdited: true },
    });
    const untouched = makeLayer("u", "Untouched");

    const updated = applyExternalCopyReferences(
      [plain, wfs, untouched],
      new Map([
        ["p", "/copies/Plain.geojson"],
        ["w", "/copies/WFS.geojson"],
      ]),
    );

    assert.equal(updated[0].sourcePath, "/copies/Plain.geojson");
    assert.equal(updated[0].metadata.localFileReloadable, true);
    assert.equal(updated[0].metadata.geometryEdited, undefined);
    assert.equal(updated[0].metadata.sourceLayer, undefined);

    // Non-plain edited layer is embedded instead of flagged localFileReloadable.
    assert.equal(updated[1].metadata.geometryEdited, undefined);
    assert.equal(updated[1].source.url, undefined);
    assert.equal(updated[1].metadata.localFileReloadable, undefined);

    assert.equal(updated[2], untouched);
  });
});
