import assert from "node:assert/strict";
import test from "node:test";
import {
  droppedFileNames,
  splitSandboxHiddenDropPaths,
} from "../apps/geolibre-desktop/src/lib/sandbox-drop.ts";

test("splitSandboxHiddenDropPaths separates host paths the sandbox hides (#3393)", async () => {
  const paths = ["/run/user/1000/doc/abc/a.tif", "/lidar/leon/dem.tif", "/lidar/leon/pc.laz"];
  const split = await splitSandboxHiddenDropPaths(paths, async () => [
    "/lidar/leon/pc.laz",
    "/lidar/leon/dem.tif",
  ]);
  assert.deepEqual(split, {
    readable: ["/run/user/1000/doc/abc/a.tif"],
    hidden: ["/lidar/leon/dem.tif", "/lidar/leon/pc.laz"],
  });
});

test("splitSandboxHiddenDropPaths passes every path through when the check fails", async () => {
  const paths = ["/data/a.tif"];
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const split = await splitSandboxHiddenDropPaths(paths, async () => {
      throw new Error("command sandbox_hidden_drop_paths not found");
    });
    assert.deepEqual(split, { readable: paths, hidden: [] });
  } finally {
    console.warn = originalWarn;
  }
});

test("droppedFileNames lists base names of POSIX and Windows paths", () => {
  assert.equal(droppedFileNames(["/lidar/leon/dem.tif", "C:\\data\\pc.laz"]), "dem.tif, pc.laz");
});
