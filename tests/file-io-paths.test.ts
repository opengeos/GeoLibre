import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Imported straight from the pure module (not the tauri-io barrel), so this
// suite needs no `self` shim: nothing here pulls in shpjs or Tauri.
import {
  browserSafeFileName,
  fileBaseName,
  fileExtension,
  isAbsoluteLocalPath,
  isHttpUrl,
  isLoadableFilePath,
  isRasterFileName,
  isRestorableVectorPath,
  isVectorFileName,
  isWindowsStylePath,
  joinLocalPath,
  pathWithoutExtension,
} from "../apps/geolibre-desktop/src/lib/file-io/paths";

describe("file-io path predicates", () => {
  it("reads the lowercased extension, treating .geoparquet as one", () => {
    assert.equal(fileExtension("/data/Roads.GeoJSON"), "geojson");
    assert.equal(fileExtension("C:\\data\\parcels.geoparquet"), "geoparquet");
    assert.equal(fileExtension("archive.shp.zip"), "zip");
  });

  it("strips only the final extension", () => {
    assert.equal(pathWithoutExtension("/data/roads.shp"), "/data/roads");
    assert.equal(pathWithoutExtension("/data.v2/roads"), "/data.v2/roads");
  });

  it("falls back to a default name only for browserSafeFileName", () => {
    assert.equal(browserSafeFileName("/maps/city.geolibre"), "city.geolibre");
    assert.equal(browserSafeFileName(""), "project.geolibre");
    assert.equal(fileBaseName("C:\\rasters\\dem.tif"), "dem.tif");
    assert.equal(fileBaseName(""), "");
  });

  it("whitelists restorable vector paths case-insensitively", () => {
    assert.equal(isRestorableVectorPath("/data/roads.GPKG"), true);
    assert.equal(isRestorableVectorPath("/data/roads.shp"), true);
    assert.equal(isRestorableVectorPath("/etc/passwd"), false);
    assert.equal(isRestorableVectorPath("/data/dem.tif"), false);
  });

  it("treats vectors and GeoTIFFs as one-click loadable", () => {
    assert.equal(isRasterFileName("dem.TIFF"), true);
    assert.equal(isRasterFileName("dem.png"), false);
    assert.equal(isLoadableFilePath("dem.tif"), true);
    assert.equal(isLoadableFilePath("roads.fgb"), true);
    assert.equal(isLoadableFilePath("tiles.mbtiles"), false);
  });

  it("keeps projects, rasters and shapefile sidecars off the vector path", () => {
    assert.equal(isVectorFileName("roads.shp"), true);
    assert.equal(isVectorFileName("points.csv"), true);
    assert.equal(isVectorFileName("roads.dbf"), false);
    assert.equal(isVectorFileName("roads.sbn"), false);
    assert.equal(isVectorFileName("roads.shp.xml"), false);
    assert.equal(isVectorFileName("dem.tif"), false);
    assert.equal(isVectorFileName("map.geolibre.json"), false);
  });

  it("recognizes only http(s) URLs", () => {
    assert.equal(isHttpUrl("https://example.com/a.geojson"), true);
    assert.equal(isHttpUrl("http://example.com"), true);
    assert.equal(isHttpUrl("file:///tmp/a.geojson"), false);
    assert.equal(isHttpUrl("/tmp/a.geojson"), false);
  });

  it("accepts absolute local paths but not relative or UNC ones", () => {
    assert.equal(isAbsoluteLocalPath("/home/user/a.geojson"), true);
    assert.equal(isAbsoluteLocalPath("C:\\data\\a.geojson"), true);
    assert.equal(isAbsoluteLocalPath("data/a.geojson"), false);
    assert.equal(isAbsoluteLocalPath("\\\\host\\share\\a.geojson"), false);
  });

  it("classifies only drive-letter and UNC paths as Windows-style", () => {
    assert.equal(isWindowsStylePath("C:\\data"), true);
    assert.equal(isWindowsStylePath("d:/data"), true);
    assert.equal(isWindowsStylePath("\\\\host\\share"), true);
    assert.equal(isWindowsStylePath("/home/u/a\\b"), false);
    assert.equal(isWindowsStylePath("C:relative"), false);
  });

  it("joins POSIX paths with / even when a name contains a backslash", () => {
    assert.equal(joinLocalPath("/home/u/a\\b", "file.tif"), "/home/u/a\\b/file.tif");
    // A trailing backslash is part of the POSIX directory name, not a separator.
    assert.equal(joinLocalPath("/home/u/dir\\", "file.tif"), "/home/u/dir\\/file.tif");
    assert.equal(joinLocalPath("/home/u/", "file.tif"), "/home/u/file.tif");
    assert.equal(joinLocalPath("/", "tmp"), "/tmp");
  });

  it("joins Windows drive paths with the directory's own separator", () => {
    assert.equal(joinLocalPath("C:\\data", "a.tif"), "C:\\data\\a.tif");
    assert.equal(joinLocalPath("C:\\", "a.tif"), "C:\\a.tif");
    assert.equal(joinLocalPath("C:/data", "a.tif"), "C:/data/a.tif");
    assert.equal(joinLocalPath("C:/data/", "a.tif"), "C:/data/a.tif");
  });

  it("joins UNC paths with a backslash", () => {
    assert.equal(joinLocalPath("\\\\host\\share", "a.tif"), "\\\\host\\share\\a.tif");
    assert.equal(joinLocalPath("\\\\host\\share\\", "a.tif"), "\\\\host\\share\\a.tif");
  });
});
