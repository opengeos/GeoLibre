import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isAbsoluteFilesystemPath,
  parseProject,
  projectFromStore,
  serializeProject,
  useAppStore,
  withoutHistory,
  type GeoLibreLayer,
} from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import { setHistoryCoalesceMs } from "../packages/core/src/history";
import {
  arcgisWorkspaceIdentity,
  importArcgisProject,
} from "../apps/geolibre-desktop/src/lib/arcgis-project-import";
import {
  arcgisRepairGroups,
  commitLocatedArcgisLayers,
  indexFolderListing,
  loadArcgisFolderLayers,
  locatedFilePath,
  readLocatedArcgisLayers,
  type ArcgisWorkspaceRepairSession,
} from "../apps/geolibre-desktop/src/lib/arcgis-workspace-repair";
import { geojsonLayer } from "./helpers/layer-fixtures";

const PROJECT_PATH = "/Users/analyst/projects/city.mapx";
const MOVED = "/Users/analyst/moved/Data";

type Cim = Record<string, unknown>;

function shapefileLayer(
  name: string,
  workspace: string,
  dataset: string,
  options: { visible?: boolean; color?: number[] } = {},
): Cim {
  return {
    type: "CIMFeatureLayer",
    name,
    uRI: `CIMPATH=Layers/${name.replace(/\W+/g, "_")}.lyrx`,
    visibility: options.visible ?? true,
    featureTable: {
      dataConnection: {
        type: "CIMStandardDataConnection",
        workspaceFactory: "Shapefile",
        workspaceConnectionString: `DATABASE=${workspace}`,
        dataset,
      },
    },
    renderer: {
      type: "CIMSimpleRenderer",
      symbol: {
        type: "CIMSymbolReference",
        symbol: {
          type: "CIMPolygonSymbol",
          symbolLayers: [
            {
              type: "CIMSolidFill",
              color: { type: "CIMRGBColor", values: options.color ?? [1, 2, 3, 100] },
            },
          ],
        },
      },
    },
  };
}

/** A shapefile layer whose file is `<workspace>/<name in lower case>.shp`. */
const shp = (name: string, workspace = "C:\\Old") =>
  shapefileLayer(name, workspace, name.toLowerCase());
const tif = (name: string): Cim => ({
  type: "CIMRasterLayer",
  name,
  dataConnection: { workspaceConnectionString: "DATABASE=C:\\Old", dataset: `${name}.tif` },
});
const tiled = (name: string): Cim => ({
  type: "CIMTiledServiceLayer",
  name,
  serviceConnection: { url: "https://example.com/MapServer", objectType: "MapServer" },
});
const group = (name: string, layerDefinitions: Cim[]): Cim => ({
  type: "CIMGroupLayer",
  name,
  visibility: true,
  layerDefinitions,
});
const map = (layerDefinitions: Cim[]) =>
  JSON.stringify({ type: "CIMMap", name: "Map", layerDefinitions });

function features(label: string): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: { label }, geometry: { type: "Point", coordinates: [0, 0] } },
    ],
  };
}

/** A reader backed by the files `exists` accepts; records every path it is asked for. */
function fakeReader(exists: string[] | ((path: string) => boolean)) {
  const has = typeof exists === "function" ? exists : (path: string) => exists.includes(path);
  const reads: string[] = [];
  const read = async (path: string, layers: GeoLibreLayer[]) => {
    reads.push(path);
    if (!has(path)) throw new Error(`ENOENT: ${path}`);
    return new Map(layers.map((layer) => [layer.id, features(path)]));
  };
  return { read, reads };
}

/**
 * Import a project the way the desktop app does: read its folder-backed
 * layers, load it, add rasters on top and into their group, put everything
 * in ArcGIS Pro's order, and keep what a Locate folder needs.
 */
async function importAndLoad(
  document: string,
  exists: string[] | ((path: string) => boolean),
  projectPath = PROJECT_PATH,
) {
  const imported = importArcgisProject(document, projectPath);
  const pending = await loadArcgisFolderLayers(imported, projectPath, fakeReader(exists).read);
  useAppStore.getState().loadProject(imported.project, null);
  const storeIds = new Map(imported.project.layers.map((layer) => [layer.id, layer.id]));
  for (const raster of imported.rasters) {
    const id = `${raster.id}-store`;
    useAppStore.getState().addLayer(geojsonLayer({ id, name: raster.name }));
    if (raster.groupId) useAppStore.getState().moveLayerToGroup(id, raster.groupId);
    storeIds.set(raster.id, id);
  }
  const order = imported.layerOrder.flatMap((id) => storeIds.get(id) ?? []);
  withoutHistory(() => useAppStore.getState().applyLayerOrder(order));
  const session: ArcgisWorkspaceRepairSession = {
    projectPath,
    order: imported.layerOrder,
    storeIds,
    pending,
    projectLoadCount: useAppStore.getState().projectLoadCount,
  };
  return { imported, session };
}

/** Locate one saved workspace (by label prefix, or the first) in `folder`. */
async function locate(
  session: ArcgisWorkspaceRepairSession,
  folder: string,
  exists: string[] | ((path: string) => boolean),
  labelPrefix = "",
) {
  const target = arcgisRepairGroups(session).find((entry) => entry.label.startsWith(labelPrefix));
  assert.ok(target, `a workspace labelled ${labelPrefix}…`);
  const restored = await readLocatedArcgisLayers(
    session,
    target.key,
    folder,
    null,
    fakeReader(exists).read,
  );
  return commitLocatedArcgisLayers(session, restored, () => useAppStore.getState());
}

const names = () => useAppStore.getState().layers.map((layer) => layer.name);
/** Each layer with its group's name, bottom first. */
const placed = () => {
  const { layers, layerGroups } = useAppStore.getState();
  return layers.map((layer) => [
    layer.name,
    layerGroups.find((entry) => entry.id === layer.groupId)?.name ?? null,
  ]);
};

/**
 * A project saved on Windows: a group holding three layers from C:\GIS\Data
 * (two of the files are in the moved folder, one is not) plus a second, hidden
 * reference to the roads file, a layer from an unrelated D:\Other\Data, one
 * from a network share, and a healthy layer stored relative to the project.
 */
const MOVED_PROJECT = map([
  shapefileLayer("Local parks", "data", "parks"),
  group("Transport", [
    shapefileLayer("Roads", "C:\\GIS\\Data", "Roads", { color: [255, 0, 0, 100] }),
    shapefileLayer("Roads (major)", "c:\\gis\\data\\", "Roads", {
      visible: false,
      color: [0, 0, 255, 100],
    }),
    shapefileLayer("Parcels", "C:\\GIS\\Data", "parcels"),
    shapefileLayer("Rivers", "C:\\GIS\\Data", "rivers"),
  ]),
  shapefileLayer("Lakes", "D:\\Other\\Data", "lakes"),
  shapefileLayer("Wells", "\\\\fileserver\\gis\\Data", "wells"),
]);

describe("ArcGIS Pro workspace repair: import", () => {
  it("keeps the folder reference of folder-backed layers, including network shares", () => {
    const imported = importArcgisProject(MOVED_PROJECT, PROJECT_PATH);
    const ids = Object.fromEntries(
      [...imported.project.layers, ...imported.repair.unresolvedLayers].map((layer) => [
        layer.name,
        layer.id,
      ]),
    );
    assert.deepEqual(imported.repair.folderSources.get(ids.Roads), {
      workspace: "C:\\GIS\\Data",
      file: "Roads.shp",
    });
    assert.equal(
      imported.project.layers.find((l) => l.id === ids.Roads)?.sourcePath,
      "C:/GIS/Data/Roads.shp",
    );
    // Relative workspaces resolve against the project file, as ArcGIS Pro does.
    assert.equal(
      imported.project.layers.find((l) => l.id === ids["Local parks"])?.sourcePath,
      "/Users/analyst/projects/data/parks.shp",
    );
    // The network share is still never read, but its record survives.
    assert.deepEqual(
      imported.repair.unresolvedLayers.map((layer) => [layer.name, layer.sourcePath]),
      [["Wells", undefined]],
    );
    assert.deepEqual(
      imported.warnings.map((warning) => [warning.layerName, warning.reason, warning.layerId]),
      [
        ["Map", "map-extent", undefined],
        ["Wells", "network-path", ids.Wells],
      ],
    );
    // Every folder-backed layer has its place in the order, bottom first,
    // including the one that is not loaded.
    assert.deepEqual(
      imported.layerOrder,
      ["Wells", "Lakes", "Rivers", "Parcels", "Roads (major)", "Roads", "Local parks"].map(
        (name) => ids[name],
      ),
    );
  });

  it("keeps a group that holds only a layer waiting for its folder", () => {
    const imported = importArcgisProject(
      map([group("Share", [shapefileLayer("Wells", "\\\\fileserver\\gis", "wells")])]),
      PROJECT_PATH,
    );
    assert.deepEqual(
      imported.project.layerGroups?.map((entry) => entry.name),
      ["Share"],
    );
  });

  const datasets: [dataset: string, file: string | null][] = [
    // A dataset joined onto the picked folder must stay inside it.
    ["..\\..\\secret", null],
    ["sub/../../roads", null],
    ["sub\\..\\..\\roads", null],
    ["C:\\Other\\roads", null],
    ["C:roads", null],
    // Leading, repeated and `.` separators collapse to a path under the
    // folder, so even a `\\server\share` dataset names subfolders of the pick.
    ["/etc/roads", "etc/roads.shp"],
    ["\\\\server\\share\\roads", "server/share/roads.shp"],
    [".\\sub//roads.SHP", "sub/roads.SHP"],
  ];
  for (const [dataset, file] of datasets) {
    it(`keeps dataset ${JSON.stringify(dataset)} ${file ? `as ${file}` : "out"}`, () => {
      const imported = importArcgisProject(
        map([shapefileLayer("Layer", "C:\\GIS", dataset)]),
        PROJECT_PATH,
      );
      assert.deepEqual(
        [...imported.repair.folderSources.values()],
        file ? [{ workspace: "C:\\GIS", file }] : [],
      );
    });
  }

  const shares: [workspace: string, projectPath: string][] = [
    // A relative path in a project opened from a share lands on that share.
    ["data", "\\\\server\\gis\\city.mapx"],
    ["\\GISData", "\\\\server\\gis\\city.mapx"],
    ["\\GISData", "/\\server\\gis\\city.mapx"],
    // Two leading separators of either kind are a share.
    ["\\/server/gis/data", "E:\\Projects\\city.mapx"],
    ["/\\server\\gis\\data", "E:\\Projects\\city.mapx"],
  ];
  for (const [workspace, projectPath] of shares) {
    it(`treats ${workspace} from ${projectPath} as a share, never read but locatable`, () => {
      const imported = importArcgisProject(map([shp("Shared", workspace)]), projectPath);
      assert.deepEqual(imported.project.layers, []);
      assert.equal(imported.warnings.at(-1)?.reason, "network-path");
      assert.equal(imported.repair.unresolvedLayers[0]?.name, "Shared");
    });
  }

  it("resolves a drive-rooted workspace on the project's drive", () => {
    const imported = importArcgisProject(map([shp("Rooted", "\\GISData")]), "E:\\Projects\\a.mapx");
    assert.equal(imported.project.layers[0]?.sourcePath, "E:/GISData/rooted.shp");
  });
});

describe("ArcGIS Pro workspace repair: paths", () => {
  const identities: [workspace: string, projectPath: string, label: string, key?: string][] = [
    ["C:\\GIS\\Data\\", PROJECT_PATH, "C:\\GIS\\Data", "c:\\gis\\data"],
    ["c:/gis/data", PROJECT_PATH, "c:\\gis\\data", "c:\\gis\\data"],
    [
      "//fileserver/gis/Data",
      PROJECT_PATH,
      "\\\\fileserver\\gis\\Data",
      "\\\\fileserver\\gis\\data",
    ],
    // Relative workspaces resolve against the project file; POSIX keeps case.
    ["..\\shared", PROJECT_PATH, "/Users/analyst/shared", "/Users/analyst/shared"],
    ["/Volumes/GIS", PROJECT_PATH, "/Volumes/GIS", "/Volumes/GIS"],
    ["data", "\\\\server\\gis\\city.mapx", "\\\\server\\gis\\data"],
    // A single leading separator is the root of the project's drive or share.
    ["\\GISData", "E:\\Projects\\city.mapx", "E:\\GISData"],
    ["/GISData", "E:\\Projects\\city.mapx", "E:\\GISData"],
    ["\\GISData", "\\\\server\\gis\\city.mapx", "\\\\server\\gis\\GISData"],
    // `..` stops at a drive, POSIX or share root, which keeps its separator.
    ["..\\..\\Data", "E:\\Projects\\city.mapx", "E:\\Data"],
    ["../..", "/Projects/city.mapx", "/"],
    ["..\\..", "E:\\Projects\\city.mapx", "E:\\"],
    ["..\\..\\..\\x", "\\\\server\\gis\\city.mapx", "\\\\server\\gis\\x"],
  ];
  for (const [workspace, projectPath, label, key] of identities) {
    it(`identifies ${workspace} from ${projectPath} as ${label}`, () => {
      const identity = arcgisWorkspaceIdentity(workspace, projectPath);
      assert.equal(identity.label, label);
      if (key !== undefined) assert.equal(identity.key, key);
    });
  }

  it("keeps workspaces apart by full path, with each platform's case rules", () => {
    const key = (workspace: string) => arcgisWorkspaceIdentity(workspace, PROJECT_PATH).key;
    assert.equal(key("c:/gis/data"), key("C:\\GIS\\Data"));
    assert.notEqual(key("D:\\Other\\Data"), key("C:\\GIS\\Data"));
    assert.notEqual(key("/Volumes/GIS/Data"), key("/Volumes/gis/data"));
  });

  const located: [file: string, listing: string[] | null, path: string | null][] = [
    ["Roads.shp", ["roads.shp"], `${MOVED}/roads.shp`],
    ["Roads.shp", ["Roads.shp", "roads.shp"], `${MOVED}/Roads.shp`],
    // Two case-insensitive matches and no exact one: no guess.
    ["Roads.shp", ["roads.shp", "ROADS.SHP"], null],
    ["rivers.shp", ["roads.shp"], null],
    ["b.shp", null, `${MOVED}/b.shp`],
    ["etc/roads.shp", null, `${MOVED}/etc/roads.shp`],
  ];
  for (const [file, listing, path] of located) {
    it(`finds ${file} in ${JSON.stringify(listing)} as ${path}`, () => {
      assert.equal(locatedFilePath(MOVED, file, listing && indexFolderListing(listing)), path);
    });
  }

  it("joins a subfolder with a Windows folder's own separator", () => {
    assert.equal(locatedFilePath("E:\\Moved", "a/b.shp", null), "E:\\Moved\\a\\b.shp");
  });
});

describe("ArcGIS Pro workspace repair: Locate folder", () => {
  it("adds the located layers in place, keeps the missing one reported, and saves the new paths", async () => {
    const { imported, session } = await importAndLoad(MOVED_PROJECT, [
      "/Users/analyst/projects/data/parks.shp",
    ]);
    assert.deepEqual(names(), ["Local parks"]);
    const groups = arcgisRepairGroups(session);
    assert.deepEqual(
      groups.map((entry) => [entry.label, entry.layerNames]),
      [
        ["C:\\GIS\\Data", ["Roads", "Roads (major)", "Parcels", "Rivers"]],
        ["D:\\Other\\Data", ["Lakes"]],
        ["\\\\fileserver\\gis\\Data", ["Wells"]],
      ],
    );
    const transportId = useAppStore.getState().layerGroups.find((g) => g.name === "Transport")?.id;
    assert.ok(transportId, "the group of the missing layers is kept for them");

    // A folder holding none of the files changes nothing.
    const none = await readLocatedArcgisLayers(
      session,
      groups[0].key,
      "/Users/analyst/elsewhere",
      ["readme.txt"],
      fakeReader([]).read,
    );
    assert.deepEqual(none, []);
    assert.deepEqual(
      commitLocatedArcgisLayers(session, none, () => useAppStore.getState()),
      [],
    );
    assert.equal(session.pending.size, 6);

    // The moved folder holds the roads and parcels files (and, by chance, a
    // lakes file of the same name as the unrelated D:\Other\Data one).
    const moved = fakeReader([`${MOVED}/roads.shp`, `${MOVED}/parcels.shp`, `${MOVED}/lakes.shp`]);
    const listing = ["roads.shp", "roads.dbf", "parcels.shp", "lakes.shp"];
    const restored = await readLocatedArcgisLayers(
      session,
      groups[0].key,
      MOVED,
      listing,
      moved.read,
    );
    assert.deepEqual(moved.reads.sort(), [`${MOVED}/parcels.shp`, `${MOVED}/roads.shp`]);
    assert.equal(
      commitLocatedArcgisLayers(session, restored, () => useAppStore.getState()).length,
      3,
    );

    const layers = useAppStore.getState().layers;
    assert.deepEqual(
      layers.map((layer) => [layer.name, layer.sourcePath, layer.groupId ?? null, layer.visible]),
      [
        ["Parcels", `${MOVED}/parcels.shp`, transportId, true],
        ["Roads (major)", `${MOVED}/roads.shp`, transportId, false],
        ["Roads", `${MOVED}/roads.shp`, transportId, true],
        ["Local parks", "/Users/analyst/projects/data/parks.shp", null, true],
      ],
    );
    // The two references to one file keep their own styles.
    assert.equal(layers.find((layer) => layer.name === "Roads")?.style.fillColor, "#ff0000");
    assert.equal(
      layers.find((layer) => layer.name === "Roads (major)")?.style.fillColor,
      "#0000ff",
    );

    // Rivers is still waiting for its folder; the unrelated workspaces too.
    assert.deepEqual(
      arcgisRepairGroups(session).map((entry) => [entry.label, entry.layerIds.length]),
      [
        ["C:\\GIS\\Data", 1],
        ["D:\\Other\\Data", 1],
        ["\\\\fileserver\\gis\\Data", 1],
      ],
    );
    assert.equal(
      imported.warnings.find((warning) => warning.layerName === "Rivers")?.reason,
      "data-not-found",
    );

    // Locating the same folder again adds nothing twice.
    const again = await readLocatedArcgisLayers(session, groups[0].key, MOVED, listing, moved.read);
    assert.deepEqual(
      commitLocatedArcgisLayers(session, again, () => useAppStore.getState()),
      [],
    );
    assert.deepEqual(
      commitLocatedArcgisLayers(session, restored, () => useAppStore.getState()),
      [],
    );
    assert.equal(useAppStore.getState().layers.length, 4);

    // The saved project keeps the new paths, not the features, so a reopen
    // reads them from the located folder.
    const saved = parseProject(serializeProject(projectFromStore(useAppStore.getState())));
    for (const layer of saved.layers) {
      assert.equal(layer.geojson, undefined);
      assert.equal(layer.metadata.localFileReloadable, true);
      assert.ok(isAbsoluteFilesystemPath(layer.sourcePath ?? ""));
    }
  });

  it("adds a network-share layer from a located local folder", async () => {
    const { session } = await importAndLoad(MOVED_PROJECT, []);
    const added = await locate(
      session,
      "/Volumes/gis/Data",
      ["/Volumes/gis/Data/wells.shp"],
      "\\\\",
    );
    assert.equal(added.length, 1);
    assert.deepEqual(
      useAppStore.getState().layers.map((layer) => [layer.name, layer.sourcePath]),
      [["Wells", "/Volumes/gis/Data/wells.shp"]],
    );
  });

  it("keeps the saved name when another layer has it, in one undo step", async () => {
    setHistoryCoalesceMs(0);
    const { session } = await importAndLoad(
      map([shapefileLayer("Roads", "data", "roads"), shapefileLayer("Roads", "C:\\Old", "Roads")]),
      ["/Users/analyst/projects/data/roads.shp"],
    );
    useAppStore.temporal.getState().clear();
    await locate(session, MOVED, [`${MOVED}/Roads.shp`]);
    // `Roads` is also the file's own name, which `addLayer` would number.
    assert.deepEqual(names(), ["Roads", "Roads"]);
    assert.equal(useAppStore.temporal.getState().pastStates.length, 1);
  });

  it("handles layer ids that are Object.prototype keys", async () => {
    const reader = fakeReader([]);
    const imported = importArcgisProject(
      map([tiled("constructor"), shapefileLayer("__proto__", "C:\\Old", "roads")]),
      PROJECT_PATH,
    );
    const pending = await loadArcgisFolderLayers(imported, PROJECT_PATH, reader.read);
    // The tiled service is not mistaken for a folder-backed layer.
    assert.deepEqual(reader.reads, ["C:/Old/roads.shp"]);
    assert.deepEqual(
      imported.project.layers.map((layer) => layer.name),
      ["constructor"],
    );
    assert.deepEqual(
      [...pending.values()].map((entry) => entry.layer.name),
      ["__proto__"],
    );
  });

  it("gives a located layer a free id when a layer added since holds its own", async () => {
    const { session } = await importAndLoad(map([shp("Missing")]), []);
    const [importId] = session.pending.keys();
    useAppStore.getState().addLayer(geojsonLayer({ id: importId, name: "Someone else's" }));
    const [added] = await locate(session, MOVED, () => true);
    assert.equal(added, importId);
    const ids = useAppStore.getState().layers.map((layer) => layer.id);
    assert.equal(new Set(ids).size, 2);
    assert.equal(session.storeIds.get(importId), `${importId}-2`);
  });

  it("leaves a layer the user added since the import where it is", async () => {
    const { session } = await importAndLoad(map([shp("Top"), shp("Bottom")]), (path) =>
      path.endsWith("bottom.shp"),
    );
    useAppStore.getState().addLayer(geojsonLayer({ id: "mine", name: "Mine" }));
    await locate(session, MOVED, () => true);
    assert.deepEqual(names(), ["Bottom", "Top", "Mine"]);
  });

  it("keeps a rearrangement outside the located layer's group", async () => {
    const { session } = await importAndLoad(
      map([shp("X"), shp("Y"), group("G", [shp("A"), shp("B")])]),
      (path) => !path.endsWith("/a.shp"),
    );
    assert.deepEqual(names(), ["B", "Y", "X"]);
    const [y, x] = useAppStore
      .getState()
      .layers.slice(1)
      .map((layer) => layer.id);
    useAppStore.getState().moveLayersRelative([y], x, "above");
    await locate(session, MOVED, () => true);
    assert.deepEqual(names(), ["B", "A", "X", "Y"]);
  });

  it("puts a located layer into its group's block after the user moved the group", async () => {
    // Saved top first: X, G[J[B], H[A]], Y. With B missing, G holds only A.
    const { session } = await importAndLoad(
      map([shp("X"), group("G", [group("J", [shp("B")]), group("H", [shp("A")])]), shp("Y")]),
      (path) => !path.endsWith("/b.shp"),
    );
    assert.deepEqual(names(), ["Y", "A", "X"]);
    const [y, a, x] = useAppStore.getState().layers.map((layer) => layer.id);
    useAppStore.getState().applyLayerOrder([y, x, a]);
    await locate(session, MOVED, () => true);
    assert.deepEqual(names(), ["Y", "X", "A", "B"]);
  });

  it("moves no layer of the group across one the user added to it", async () => {
    const { session } = await importAndLoad(
      map([group("G", [shp("B"), shp("A"), shp("C")]), shp("X")]),
      (path) => !path.endsWith("/b.shp"),
    );
    assert.deepEqual(names(), ["X", "C", "A"]);
    const { layers, layerGroups } = useAppStore.getState();
    const groupId = layerGroups.find((entry) => entry.name === "G")?.id;
    useAppStore.getState().addLayer(geojsonLayer({ id: "u", name: "U", groupId }), layers[2].id);
    await locate(session, MOVED, () => true);
    assert.deepEqual(names(), ["X", "C", "U", "A", "B"]);
  });

  it("puts a located layer into a group that holds only a layer the user added", async () => {
    const { session } = await importAndLoad(
      map([shp("X"), group("G", [shp("B")]), shp("Y")]),
      (path) => !path.endsWith("/b.shp"),
    );
    const groupId = useAppStore.getState().layerGroups.find((entry) => entry.name === "G")?.id;
    useAppStore.getState().addLayer(geojsonLayer({ id: "u", name: "U", groupId }));
    assert.deepEqual(names(), ["Y", "X", "U"]);
    await locate(session, MOVED, () => true);
    assert.deepEqual(placed(), [
      ["Y", null],
      ["X", null],
      ["B", "G"],
      ["U", "G"],
    ]);
  });

  // Each case imports the map twice: once with every file found, and once with
  // `missing` not found and then located. Both must end in the same order and
  // groups. Rasters join the store after the project loads, as in the app.
  const placements: {
    name: string;
    layers: Cim[];
    missing: string[];
    /** Workspaces to locate, by label prefix, in this order. */
    locateOrder?: string[];
  }[] = [
    {
      name: "below an imported tiled layer",
      layers: [shp("Missing"), tiled("Basemap")],
      missing: ["Missing"],
    },
    {
      // Without contiguity, the restored A would sit outside its own group,
      // with B between it and G's raster.
      name: "a group's first vector, its group holding only a raster",
      layers: [group("G", [shp("A"), tif("R")]), shp("B")],
      missing: ["A"],
    },
    {
      name: "a group's last vector, below its raster",
      layers: [group("G", [tif("R"), shp("A")]), shp("B")],
      missing: ["A"],
    },
    {
      name: "an ungrouped layer and a grouped one around a grouped raster",
      layers: [group("G", [shp("A"), shp("C"), tif("R")]), shp("B")],
      missing: ["B", "C"],
    },
    {
      name: "a nested group's only layer",
      layers: [group("Outer", [shp("Top"), group("Inner", [shp("Middle")]), shp("Bottom")])],
      missing: ["Middle"],
    },
    {
      name: "an outer group's own bottom layer",
      layers: [group("Outer", [shp("Top"), group("Inner", [shp("Middle")]), shp("Bottom")])],
      missing: ["Bottom"],
    },
    {
      name: "the upper of two siblings in a nested group",
      layers: [group("G", [shp("A"), group("H", [shp("B"), shp("C")]), shp("D")])],
      missing: ["B"],
    },
    {
      name: "the lower of two siblings in a nested group",
      layers: [group("G", [shp("A"), group("H", [shp("B"), shp("C")]), shp("D")])],
      missing: ["C"],
    },
    {
      name: "an ungrouped layer between a group and another layer",
      layers: [shp("X"), group("G", [shp("A")]), shp("L"), shp("Y")],
      missing: ["L"],
    },
    {
      // Contiguity has already moved A below B; X must go above all of G.
      name: "an ungrouped layer above a group whose nested member moved",
      layers: [shp("X"), group("G", [shp("A"), group("H", [shp("B")]), shp("D")])],
      missing: ["X"],
    },
    {
      name: "an ungrouped layer below a group whose nested member moved",
      layers: [group("G", [shp("A"), group("H", [shp("B")]), shp("D")]), shp("X")],
      missing: ["X"],
    },
    {
      name: "grouped and ungrouped layers located together",
      layers: [
        shp("X"),
        group("G", [shp("A"), group("H", [shp("B"), tif("R")]), shp("D")]),
        shp("Y"),
      ],
      missing: ["X", "B", "Y"],
    },
    {
      name: "two workspaces, located last first",
      layers: [shp("Kept"), shp("Missing"), shp("Moved", "D:\\Other"), tif("Raster")],
      missing: ["Missing", "Moved"],
      locateOrder: ["D:", "C:"],
    },
  ];
  for (const { name, layers, missing, locateOrder = [""] } of placements) {
    it(`places a located layer where a full import would: ${name}`, async () => {
      const document = map(layers);
      await importAndLoad(document, () => true);
      const full = placed();
      const isMissing = (path: string) =>
        missing.some((entry) => path.endsWith(`/${entry.toLowerCase()}.shp`));
      const { session } = await importAndLoad(document, (path) => !isMissing(path));
      assert.equal(useAppStore.getState().layers.length, full.length - missing.length);
      for (const prefix of locateOrder) await locate(session, MOVED, isMissing, prefix);
      assert.deepEqual(placed(), full);
    });
  }
});

describe("ArcGIS Pro workspace repair: random projects", () => {
  /** Mulberry32: a small seeded generator, so every run builds the same projects. */
  function seeded(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** A block on the map: an outermost group with everything in it, or one ungrouped layer. */
  interface Block {
    key: string;
    ids: string[];
    names: string[];
  }

  /** The map's blocks, bottom first; fails if a group is split. */
  function blocks(): Block[] {
    const { layers, layerGroups } = useAppStore.getState();
    const parents = new Map(layerGroups.map((entry) => [entry.id, entry.parentId]));
    const groupNames = new Map(layerGroups.map((entry) => [entry.id, entry.name]));
    const result: Block[] = [];
    for (const layer of layers) {
      let outer = layer.groupId;
      while (outer !== undefined && parents.get(outer) !== undefined) outer = parents.get(outer);
      const key = outer === undefined ? `layer ${layer.name}` : `group ${groupNames.get(outer)}`;
      const last = result.at(-1);
      if (last?.key === key) {
        last.ids.push(layer.id);
        last.names.push(layer.name);
      } else {
        assert.ok(!result.some((entry) => entry.key === key), `${key} is in one block`);
        result.push({ key, ids: [layer.id], names: [layer.name] });
      }
    }
    return result;
  }

  /** A random project: nested groups of vector layers from two workspaces and rasters. */
  function randomProject(random: () => number) {
    let count = 0;
    const workspaces = new Map<string, string>();
    const items = (depth: number, min: number): Cim[] =>
      Array.from({ length: min + Math.floor(random() * 3) }, () => {
        const roll = random();
        if (depth < 3 && roll < 0.3) return group(`G${count++}`, items(depth + 1, 1));
        if (roll < 0.4) return tif(`R${count++}`);
        const name = `L${count++}`;
        const workspace = random() < 0.5 ? "C:\\Old" : "D:\\Other";
        workspaces.set(name, workspace);
        return shp(name, workspace);
      });
    return { document: map(items(0, 3)), workspaces };
  }

  /**
   * The blocks expected once `located` is added to `before`: the located
   * layers' blocks as `fresh` (an import with the same files found) has them,
   * every other block as it was, and a block new to the map just below the
   * nearest block above it in `fresh` that was already on the map, or else
   * just above the nearest one below.
   */
  function expectedBlocks(fresh: Block[], before: Block[], located: Set<string>): Block[] {
    const touched = new Set(
      fresh.filter((entry) => entry.names.some((name) => located.has(name))).map((e) => e.key),
    );
    const keys = before.map((entry) => entry.key);
    const wasThere = new Set(keys);
    fresh.forEach(({ key }, index) => {
      if (wasThere.has(key)) return;
      const above = fresh.slice(index + 1).find((entry) => wasThere.has(entry.key));
      if (above) keys.splice(keys.indexOf(above.key), 0, key);
      else {
        const below = fresh.slice(0, index).findLast((entry) => keys.includes(entry.key));
        keys.splice(below ? keys.indexOf(below.key) + 1 : keys.length, 0, key);
      }
    });
    return keys.map((key) => {
      const source = touched.has(key) ? fresh : before;
      return { key, ids: [], names: source.find((entry) => entry.key === key)!.names };
    });
  }

  const summary = (list: Block[]) => list.map(({ key, names }) => ({ key, names }));

  it("places located layers as a fresh import would, keeping the user's block moves", async (t) => {
    // Files left missing are reported on purpose; keep the output readable.
    t.mock.method(console, "warn", () => {});
    for (let seed = 1; seed <= 100; seed++) {
      const random = seeded(seed);
      const { document, workspaces } = randomProject(random);
      const missing = [...workspaces.keys()].filter(() => random() < 0.4);
      const prefixes = ["C:", "D:"].filter((prefix) =>
        missing.some((name) => workspaces.get(name)!.startsWith(prefix)),
      );
      if (random() < 0.5) prefixes.reverse();
      const steps = prefixes.map((prefix) =>
        missing.filter((name) => workspaces.get(name)!.startsWith(prefix)),
      );
      const reader = (absent: string[]) => (path: string) =>
        !absent.some((name) => path.endsWith(`/${name.toLowerCase()}.shp`));

      // What an import finds after each Locate, all files found by the last.
      const fresh: Block[][] = [];
      for (let step = 1; step <= steps.length; step++) {
        await importAndLoad(document, reader(steps.slice(step).flat()));
        fresh.push(blocks());
      }

      const { session } = await importAndLoad(document, reader(missing));
      // The user moves a whole block or two.
      for (let moves = Math.floor(random() * 3); moves > 0; moves--) {
        const list = blocks();
        if (list.length < 2) break;
        const [moved] = list.splice(Math.floor(random() * list.length), 1);
        list.splice(Math.floor(random() * (list.length + 1)), 0, moved);
        useAppStore.getState().applyLayerOrder(list.flatMap((entry) => entry.ids));
      }

      for (const [step, prefix] of prefixes.entries()) {
        const before = blocks();
        await locate(session, MOVED, () => true, prefix);
        assert.deepEqual(
          summary(blocks()),
          summary(expectedBlocks(fresh[step], before, new Set(steps[step]))),
          `seed ${seed}, locating ${prefix}`,
        );
      }
    }
  });
});
