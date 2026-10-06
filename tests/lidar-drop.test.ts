import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addDroppedPointClouds,
  isLasVersionError,
  isPointCloudFileName,
} from "../apps/geolibre-desktop/src/lib/lidar-drop.ts";

describe("isPointCloudFileName", () => {
  it("claims LAS, LAZ and COPC files, by name or desktop path", () => {
    for (const name of ["a.las", "B.LAZ", "autzen.copc.laz", "/data/tiles/x.laz", "C:\\d\\y.las"]) {
      assert.equal(isPointCloudFileName(name), true, name);
    }
  });

  it("leaves every other dropped file to the vector/raster pipeline", () => {
    for (const name of ["a.geojson", "dem.tif", "tiles.pmtiles", "las.zip", "notes.lasx"]) {
      assert.equal(isPointCloudFileName(name), false, name);
    }
  });
});

describe("isLasVersionError", () => {
  it("recognizes maplibre-gl-lidar's whole-file LAS version limit", () => {
    assert.equal(
      isLasVersionError(new Error("Only file versions <= 1.3 are supported at this time")),
      true,
    );
    assert.equal(isLasVersionError(new Error("Failed to fetch")), false);
    assert.equal(isLasVersionError("Only file versions <= 1.3"), false);
  });
});

describe("addDroppedPointClouds", () => {
  it("adds each cloud under its file name and counts the layers", async () => {
    const calls: string[] = [];
    const file = new File([new Uint8Array([0x4c, 0x41, 0x53, 0x46])], "autzen.copc.laz");
    const added = await addDroppedPointClouds(
      [
        { name: file.name, data: file },
        { name: "/data/tile.las", data: new Uint8Array([0x4c, 0x41, 0x53, 0x46]) },
      ],
      async (data, name, fileName) => {
        calls.push(`${name}|${fileName}|${data instanceof File ? "file" : "bytes"}`);
        return `pc-${calls.length}`;
      },
      () => assert.fail("no error expected"),
    );
    assert.equal(added, 2);
    // The dropped File itself is handed over, so a COPC streams without a copy.
    assert.deepEqual(calls, ["autzen.copc.laz|autzen.copc.laz|file", "tile.las|tile.las|bytes"]);
  });

  it("reports a failed file and keeps going with the rest", async () => {
    const errors: string[] = [];
    const added = await addDroppedPointClouds(
      [
        { name: "bad.laz", data: new Uint8Array() },
        { name: "good.laz", data: new Uint8Array() },
      ],
      async (_data, name) => {
        if (name === "bad.laz") throw new Error("Invalid file signature");
        return "pc-1";
      },
      (name, error) => errors.push(`${name}: ${(error as Error).message}`),
    );
    assert.equal(added, 1);
    assert.deepEqual(errors, ["bad.laz: Invalid file signature"]);
  });

  it("does not count a cloud the LiDAR control could not take", async () => {
    const added = await addDroppedPointClouds(
      [{ name: "a.las", data: new Uint8Array() }],
      async () => null,
      () => assert.fail("no error expected"),
    );
    assert.equal(added, 0);
  });
});
