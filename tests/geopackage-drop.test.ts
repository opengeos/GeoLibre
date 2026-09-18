import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { importGeoPackageDrops } from "../apps/geolibre-desktop/src/lib/geopackage-drop";

describe("GeoPackage drop routing", () => {
  it("routes native files to the picker with their reload path and keeps other paths", async () => {
    const imported: { name: string; path?: string; bytes: number[] }[] = [];
    const result = await importGeoPackageDrops(["/data/buildings.GPKG", "/data/roads.geojson"], {
      readPath: async (path) => {
        assert.equal(path, "/data/buildings.GPKG");
        return new Uint8Array([1, 2, 3]);
      },
      addFile: async (file, path) => {
        imported.push({
          name: file.name,
          path,
          bytes: [...new Uint8Array(await file.arrayBuffer())],
        });
        return 3;
      },
      onError: () => assert.fail("unexpected error"),
    });
    assert.deepEqual(imported, [
      { name: "buildings.GPKG", path: "/data/buildings.GPKG", bytes: [1, 2, 3] },
    ]);
    assert.deepEqual(result, { remaining: ["/data/roads.geojson"], count: 1, layerCount: 3 });
  });
  it("continues after a bad container and preserves remaining browser files", async () => {
    const bad = new File([], "bad.gpkg"),
      good = new File([], "good.gpkg"),
      other = new File([], "roads.geojson");
    const errors: string[] = [];
    const result = await importGeoPackageDrops([bad, good, other], {
      readPath: async () => assert.fail("browser files must not read native paths"),
      addFile: async (file, path) => {
        assert.equal(path, undefined);
        if (file === bad) throw new Error("Invalid GeoPackage");
        assert.equal(file, good);
        return 2;
      },
      onError: (name, error) => errors.push(`${name}: ${String(error)}`),
    });
    assert.deepEqual(result, { remaining: [other], count: 2, layerCount: 2 });
    assert.deepEqual(errors, ["bad.gpkg: Error: Invalid GeoPackage"]);
  });
  it("treats cancellation as zero layers without reporting a failure", async () => {
    const result = await importGeoPackageDrops([new File([], "cancelled.gpkg")], {
      readPath: async () => assert.fail("unexpected read"),
      addFile: async () => 0,
      onError: () => assert.fail("cancellation is not an error"),
    });
    assert.deepEqual(result, { remaining: [], count: 1, layerCount: 0 });
  });
});
