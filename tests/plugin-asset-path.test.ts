import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSafePluginAssetRelativePath } from "../apps/geolibre-desktop/src/lib/plugin-asset-path";

describe("isSafePluginAssetRelativePath", () => {
  it("accepts plain relative paths", () => {
    assert.equal(isSafePluginAssetRelativePath("config.json"), true);
    assert.equal(isSafePluginAssetRelativePath("assets/conn.json"), true);
    assert.equal(isSafePluginAssetRelativePath("a/b/c/data.bin"), true);
  });

  it("rejects absolute and Windows-style paths", () => {
    assert.equal(isSafePluginAssetRelativePath("/etc/passwd"), false);
    assert.equal(isSafePluginAssetRelativePath("C:/Windows/system.ini"), false);
    assert.equal(isSafePluginAssetRelativePath("assets\\conn.json"), false);
    assert.equal(isSafePluginAssetRelativePath("\\\\server\\share\\x"), false);
  });

  it("rejects scheme-qualified paths", () => {
    assert.equal(isSafePluginAssetRelativePath("http://evil/x"), false);
    assert.equal(isSafePluginAssetRelativePath("file:///etc/passwd"), false);
  });

  it("rejects dot segments and empty segments", () => {
    assert.equal(isSafePluginAssetRelativePath("../secret"), false);
    assert.equal(isSafePluginAssetRelativePath("a/../../secret"), false);
    assert.equal(isSafePluginAssetRelativePath("./config.json"), false);
    assert.equal(isSafePluginAssetRelativePath("a//b"), false);
    assert.equal(isSafePluginAssetRelativePath("dir/"), false);
    assert.equal(isSafePluginAssetRelativePath(""), false);
  });

  it("treats percent-encoded dot segments as literal names", () => {
    // Filesystem and zip reads do not percent-decode: "%2e%2e" is a plain
    // directory name, not a traversal, so it stays allowed.
    assert.equal(isSafePluginAssetRelativePath("%2e%2e/notes.txt"), true);
  });
});
