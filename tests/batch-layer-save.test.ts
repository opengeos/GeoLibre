import { useAppStore } from "./helpers/dom";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { CollaborationState, GeoLibreLayer } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import type { TFunction } from "i18next";

const { PostgisWriteRejectedError } = await import("@geolibre/processing");
const { canWriteEditsToSource } =
  await import("../apps/geolibre-desktop/src/components/panels/layer-panel/layer-panel-utils");
const {
  applyExternalCopyReferences,
  canCollaboratorEditLayer,
  clearLayerGeometryEditedFlag,
  clearPostgisWritebackRefreshRequired,
  defaultSelectedWritableLayerIds,
  isPostgisWritebackRefreshRequired,
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

it("keeps mobile GeoJSON copy saves available without offering sidecar-backed sources", async () => {
  const originalTauri = Object.getOwnPropertyDescriptor(window, "__TAURI_INTERNALS__");
  const originalUa = Object.getOwnPropertyDescriptor(navigator, "userAgent");
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Android" });
  try {
    const root = "/data/user/0/org.geolibre.app/files/picked-documents/selection/data";
    const geojson = makeLayer("mobile-json", "Cities", { sourcePath: `${root}/cities.geojson` });
    const gpkg = makeLayer("mobile-gpkg", "Regions", { sourcePath: `${root}/regions.gpkg` });
    for (const extension of ["gpkg", "shp", "fgb", "parquet", "geoparquet"]) {
      assert.equal(
        canWriteEditsToSource(
          makeLayer(extension, extension, {
            sourcePath: `${root}/data.${extension}`,
          }),
        ),
        false,
      );
    }
    useAppStore.setState({ layers: [geojson, gpkg] });
    assert.deepEqual(
      listWritableLayerCandidates([geojson, gpkg]).map((c) => c.layer.id),
      [geojson.id],
    );
    let commits = 0;
    let writes = 0;
    const deps = {
      commitDrafts: () => {
        commits++;
        return "none" as const;
      },
      resolveGeojson: async () => sampleFeatureCollection,
      writeLocalGeojson: async () => {
        writes++;
      },
      startSidecar: async () => {
        throw new Error("Mobile cannot start a Python sidecar");
      },
      writeVectorSource: async () => {
        throw new Error("Mobile cannot use the sidecar writer");
      },
    };
    const refused = await writeLayerEditsToSource(gpkg, { map: undefined, t, deps });
    assert.equal(refused.status, "error");
    assert.equal(commits, 0, "unsupported saves must not commit pending drafts");
    for (const sourcePath of [
      "content://documents/roads.geojson",
      "https://example.com/roads.geojson",
      "roads.geojson",
      `${root}/project.geolibre.json`,
    ]) {
      const unsupported = makeLayer("legacy-mobile-json", "Legacy source", { sourcePath });
      assert.equal(canWriteEditsToSource(unsupported), false, sourcePath);
      useAppStore.setState({ layers: [unsupported] });
      const result = await writeLayerEditsToSource(unsupported, { map: undefined, t, deps });
      assert.equal(result.status, "error", sourcePath);
      assert.equal(commits, 0, "unsupported paths must not commit pending drafts");
    }
    useAppStore.setState({ layers: [geojson, gpkg] });
    const saved = await writeLayerEditsToSource(geojson, { map: undefined, t, deps });
    assert.equal(saved.status, "success");
    assert.equal(writes, 1);
  } finally {
    if (originalTauri) Object.defineProperty(window, "__TAURI_INTERNALS__", originalTauri);
    else Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    if (originalUa) Object.defineProperty(navigator, "userAgent", originalUa);
    else Reflect.deleteProperty(navigator, "userAgent");
  }
});

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
  it("writes an imported document copy and identifies that destination in the result", async () => {
    const path =
      "/data/user/0/org.geolibre.app/files/picked-documents/3cb9b477-d563-4d3e-8503-263ec23c01c5/data/roads.geojson";
    const layer = makeLayer("roads", "Roads", { sourcePath: path });
    const written: string[] = [];
    const result = await writeLayerEditsToSource(layer, {
      map: undefined,
      t,
      canEditLayer: () => true,
      deps: {
        isDesktop: () => true,
        commitDrafts: () => "none",
        readLatestLayer: () => layer,
        readProjectGeneration: () => 1,
        resolveGeojson: async () => layer.geojson!,
        writeLocalGeojson: async (target) => {
          written.push(target);
        },
        clearGeometryEdited: () => {},
      },
    });
    assert.equal(result.status, "success");
    assert.deepEqual(written, [path]);
    assert.match(result.message, /^layers.saveEditsImportedCopySuccess:/);
  });

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

  it("routes GeoPackage files through the sidecar with sourceLayer and clears geometryEdited", async () => {
    let sidecarStarted = false;
    let receivedLayer: string | undefined;
    const layer = makeLayer("parcels", "Parcels", {
      sourcePath: "/data/parcels.gpkg",
      metadata: { sourceLayer: "roads" },
    });

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
        writeVectorSource: async (req) => {
          receivedLayer = req.layer;
          return {
            feature_count: 1,
            path: "/data/parcels.gpkg",
            layer: req.layer ?? null,
            messages: [],
          };
        },
        clearGeometryEdited: () => {},
      },
    });

    assert.equal(sidecarStarted, true);
    assert.equal(receivedLayer, "roads");
    assert.equal(res.status, "success");
  });

  it("distinguishes definite PostGIS rejections from uncertain write failures", async () => {
    const pgLayer = makeLayer("pg1", "PG Layer", {
      sourcePath: undefined,
      metadata: {
        sourceKind: "postgis-table",
        postgisSchema: "public",
        postgisTable: "roads",
        postgisPrimaryKey: "id",
        postgisBaselineKeys: [1],
      },
    });
    const fakeConn = "postgresql://postgres:secret@localhost:5432/gis";

    try {
      const rejected = await writeLayerEditsToSource(pgLayer, {
        map: undefined,
        t,
        canEditLayer: () => true,
        deps: {
          commitDrafts: () => "none",
          readLatestLayer: () => pgLayer,
          readProjectGeneration: () => 7,
          resolveGeojson: async () => pgLayer.geojson!,
          resolvePostgisConn: () => fakeConn,
          writePostgis: async () => {
            throw new PostgisWriteRejectedError("constraint violation");
          },
        },
      });
      assert.equal(rejected.status, "error");
      assert.equal(rejected.message, "constraint violation");
      assert.equal(isPostgisWritebackRefreshRequired(pgLayer, 7), false);

      const uncertain = await writeLayerEditsToSource(pgLayer, {
        map: undefined,
        t,
        canEditLayer: () => true,
        deps: {
          commitDrafts: () => "none",
          readLatestLayer: () => pgLayer,
          readProjectGeneration: () => 7,
          resolveGeojson: async () => pgLayer.geojson!,
          resolvePostgisConn: () => fakeConn,
          writePostgis: async () => {
            throw new Error("Connection reset while waiting for response");
          },
        },
      });
      assert.equal(uncertain.status, "error");
      assert.equal(isPostgisWritebackRefreshRequired(pgLayer, 7), true);
    } finally {
      clearPostgisWritebackRefreshRequired("pg1", 7);
    }
  });

  it("catches synchronous commitDrafts throws so later batch layers still run", async () => {
    const l1 = makeLayer("l1", "Layer 1");
    const l2 = makeLayer("l2", "Layer 2");
    const written: string[] = [];

    const summary = await saveLayerEditsBatch([l1, l2], {
      map: undefined,
      t,
      projectGeneration: 3,
      canEditLayer: () => true,
      deps: {
        isDesktop: () => true,
        commitDrafts: (id) => {
          if (id === "l1") throw new Error("draft store corrupted");
          return "none";
        },
        readLatestLayer: (id) => [l1, l2].find((l) => l.id === id),
        readProjectGeneration: () => 3,
        resolveGeojson: async (layer) => layer.geojson!,
        writeLocalGeojson: async (path) => {
          written.push(path);
        },
        clearGeometryEdited: () => {},
      },
    });

    assert.equal(summary.failed, 1);
    assert.equal(summary.succeeded, 1);
    assert.equal(summary.results[0].message, "draft store corrupted");
    assert.deepEqual(written, ["/data/l2.geojson"]);
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

  it("aborts before writing on blocked drafts, extracts string errors, and checks generation in retry loop", async () => {
    const l1 = makeLayer("1", "Roads");
    const l2 = makeLayer("2", "Cities");
    let writes = 0;

    // abortOnBlockedDrafts prevents partial disk writes when another layer has blocked drafts.
    const blockedRes = await saveGeojsonCopiesToDirectory([l1, l2], "/out", {
      map: undefined,
      abortOnBlockedDrafts: true,
      deps: {
        commitDrafts: (id) => (id === "2" ? "blocked" : "none"),
        readLatestLayer: (id) => [l1, l2].find((l) => l.id === id),
        resolveGeojson: async (layer) => layer.geojson!,
        writeTextFile: async () => {
          writes += 1;
        },
      },
    });
    assert.equal(writes, 0);
    assert.deepEqual(blockedRes.blockedDraftLayers, ["Cities"]);
    assert.equal(blockedRes.written.length, 0);

    // Non-Error string rejection (Tauri style) is preserved, and empty rejections use fallbackErrorMessage.
    const stringErrRes = await saveGeojsonCopiesToDirectory([l1, l2], "/out", {
      map: undefined,
      fallbackErrorMessage: "Localized fallback",
      deps: {
        commitDrafts: () => "none",
        readLatestLayer: (id) => [l1, l2].find((l) => l.id === id),
        resolveGeojson: async (layer) => layer.geojson!,
        writeTextFile: async (path) => {
          if (path.includes("Roads")) throw "Permission denied (os error 13)";
          throw {};
        },
      },
    });
    assert.equal(stringErrRes.errors.length, 2);
    assert.equal(stringErrRes.errors[0].message, "Permission denied (os error 13)");
    assert.equal(stringErrRes.errors[1].message, "Localized fallback");

    // Project switch during EEXIST retry loop stops before attempting the next suffix.
    let gen = 5;
    const attempted: string[] = [];
    const switchedRes = await saveGeojsonCopiesToDirectory([l1], "/out", {
      map: undefined,
      projectGeneration: 5,
      deps: {
        readProjectGeneration: () => gen,
        commitDrafts: () => "none",
        readLatestLayer: () => l1,
        resolveGeojson: async () => l1.geojson!,
        writeTextFile: async (path) => {
          attempted.push(path);
          gen = 6;
          throw new Error("File exists (os error 17)");
        },
      },
    });
    assert.equal(switchedRes.aborted, true);
    assert.deepEqual(attempted, ["/out/Roads.geojson"]);
  });
});
