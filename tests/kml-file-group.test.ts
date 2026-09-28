import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { useAppStore } from "@geolibre/core";
import {
  groupKmlLayersBySourceFile,
  isKmlSourcePath,
} from "../apps/geolibre-desktop/src/lib/kml-file-group";

const EMPTY = { type: "FeatureCollection" as const, features: [] };

/** Adds a GeoJSON layer from `path` and returns its id. */
function addLayer(name: string, path: string): string {
  return useAppStore.getState().addGeoJsonLayer(name, EMPTY, path);
}

function group(id: string) {
  return useAppStore.getState().layerGroups.find((g) => g.id === id);
}

function layer(id: string) {
  return useAppStore.getState().layers.find((l) => l.id === id);
}

describe("isKmlSourcePath", () => {
  it("matches .kml and .kmz in any case", () => {
    assert.equal(isKmlSourcePath("/data/My_Project.kmz"), true);
    assert.equal(isKmlSourcePath("C:\\data\\roads.KML"), true);
    assert.equal(isKmlSourcePath("roads.geojson"), false);
    assert.equal(isKmlSourcePath("kmz"), false);
  });
});

describe("groupKmlLayersBySourceFile", () => {
  beforeEach(() => {
    useAppStore.getState().newProject({ name: "KMZ groups" });
  });

  it("wraps a file's Folder groups and loose layers in a group named after it", () => {
    const path = "/data/My_Project.kmz";
    const store = useAppStore.getState();
    const trail = addLayer("Trail", path);
    const oak = addLayer("Oak tree", path);
    const loose = addLayer("Trailhead", path);
    const pathGroup = store.addLayerGroup("Path", [trail]);
    const treeGroup = store.addLayerGroup("Tree", [oak]);

    const created = groupKmlLayersBySourceFile(new Map([[path, [trail, oak, loose]]]));

    const fileGroupId = created.get(path);
    assert.ok(fileGroupId);
    assert.equal(group(fileGroupId)?.name, "My_Project.kmz");
    assert.equal(group(pathGroup)?.parentId, fileGroupId);
    assert.equal(group(treeGroup)?.parentId, fileGroupId);
    assert.equal(layer(loose)?.groupId, fileGroupId);
    // Foldered layers stay in their own Folder group.
    assert.equal(layer(trail)?.groupId, pathGroup);
  });

  it("reaches the outermost group of nested Folders", () => {
    const path = "/data/nested.kml";
    const store = useAppStore.getState();
    const deep = addLayer("Deep", path);
    const loose = addLayer("Loose", path);
    const outer = store.addLayerGroup("Outer");
    const inner = store.addLayerGroup("Inner", [deep]);
    store.moveLayerGroupToGroup(inner, outer);

    const fileGroupId = groupKmlLayersBySourceFile(new Map([[path, [deep, loose]]])).get(path);

    assert.ok(fileGroupId);
    assert.equal(group(outer)?.parentId, fileGroupId);
    assert.equal(group(inner)?.parentId, outer);
  });

  it("leaves a file that produced a single layer or a single group alone", () => {
    const single = addLayer("Only", "/data/single.kmz");
    const a = addLayer("A", "/data/one-folder.kmz");
    const b = addLayer("B", "/data/one-folder.kmz");
    const folder = useAppStore.getState().addLayerGroup("Folder", [a, b]);
    const groupsBefore = useAppStore.getState().layerGroups.length;

    const created = groupKmlLayersBySourceFile(
      new Map([
        ["/data/single.kmz", [single]],
        ["/data/one-folder.kmz", [a, b]],
      ]),
    );

    assert.equal(created.size, 0);
    assert.equal(useAppStore.getState().layerGroups.length, groupsBefore);
    assert.equal(layer(single)?.groupId, undefined);
    assert.equal(group(folder)?.parentId, undefined);
  });

  it("gives each file of a batch its own group", () => {
    const a1 = addLayer("a1", "/data/a.kmz");
    const a2 = addLayer("a2", "/data/a.kmz");
    const b1 = addLayer("b1", "/data/b.kml");
    const b2 = addLayer("b2", "/data/b.kml");

    const created = groupKmlLayersBySourceFile(
      new Map([
        ["/data/a.kmz", [a1, a2]],
        ["/data/b.kml", [b1, b2]],
      ]),
    );

    assert.equal(layer(a1)?.groupId, created.get("/data/a.kmz"));
    assert.equal(layer(a2)?.groupId, created.get("/data/a.kmz"));
    assert.equal(layer(b1)?.groupId, created.get("/data/b.kml"));
    assert.equal(group(created.get("/data/b.kml") ?? "")?.name, "b.kml");
  });

  it("ignores other formats", () => {
    const x = addLayer("x", "/data/roads.gpkg");
    const y = addLayer("y", "/data/roads.gpkg");

    const created = groupKmlLayersBySourceFile(new Map([["/data/roads.gpkg", [x, y]]]));

    assert.equal(created.size, 0);
    assert.equal(layer(x)?.groupId, undefined);
  });
});
