import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  androidContentUriFileName,
  isAndroidContentUri,
  isUriWritePermissionError,
} from "../apps/geolibre-desktop/src/lib/android-content-uri";

// The URI from GeoLibre#1833: a project opened from Documents/json through the
// Android document picker.
const EXTERNAL_STORAGE_URI =
  "content://com.android.externalstorage.documents/document/primary%3ADocuments%2Fjson%2FGeneral_Project.geolibre.json";

describe("isAndroidContentUri", () => {
  it("accepts a SAF content URI", () => {
    assert.equal(isAndroidContentUri(EXTERNAL_STORAGE_URI), true);
  });

  it("rejects filesystem paths and URLs", () => {
    assert.equal(isAndroidContentUri("/home/user/project.geolibre.json"), false);
    assert.equal(isAndroidContentUri("C:\\Users\\user\\project.geolibre.json"), false);
    assert.equal(isAndroidContentUri("https://example.com/project.geolibre.json"), false);
    assert.equal(isAndroidContentUri("file:///tmp/project.geolibre.json"), false);
  });
});

describe("androidContentUriFileName", () => {
  it("recovers the file name from an ExternalStorageProvider document id", () => {
    assert.equal(androidContentUriFileName(EXTERNAL_STORAGE_URI), "General_Project.geolibre.json");
  });

  it("recovers the file name from a tree-scoped document URI", () => {
    const uri =
      "content://com.android.externalstorage.documents/tree/primary%3ADocuments/document/primary%3ADocuments%2FMy%20Map.geolibre.json";
    assert.equal(androidContentUriFileName(uri), "My Map.geolibre.json");
  });

  it("returns null for an opaque provider id with no file name", () => {
    // The Downloads provider hands back ids like "msf:1000000123", which carry
    // no name for the save dialog to reuse.
    assert.equal(
      androidContentUriFileName(
        "content://com.android.providers.downloads.documents/document/msf%3A1000000123",
      ),
      null,
    );
    assert.equal(androidContentUriFileName("content://media/external/file/12345"), null);
  });

  it("ignores a query string or fragment", () => {
    assert.equal(
      androidContentUriFileName(`${EXTERNAL_STORAGE_URI}?mode=r#frag`),
      "General_Project.geolibre.json",
    );
  });

  it("falls back to the raw segment when the escape sequence is malformed", () => {
    assert.equal(
      androidContentUriFileName("content://provider/document/broken%2Eproject.json"),
      "broken.project.json",
    );
    assert.equal(
      androidContentUriFileName("content://provider/document/bad%project.json"),
      "bad%project.json",
    );
  });

  it("returns null for anything that is not a content URI", () => {
    assert.equal(androidContentUriFileName("/home/user/project.geolibre.json"), null);
  });
});

describe("isUriWritePermissionError", () => {
  it("matches the Android permission denial reported in #1833", () => {
    const error = new Error(
      "failed to open file: Permission Denial: writing com.android.externalstorage.ExternalStorageProvider uri " +
        `${EXTERNAL_STORAGE_URI} from pid=7564, uid=10393 requires android.permission.MANAGE_DOCUMENTS, ` +
        "or grantUriPermission()",
    );
    assert.equal(isUriWritePermissionError(error), true);
  });

  it("matches a refusal that crossed the bridge as a bare string", () => {
    assert.equal(isUriWritePermissionError("java.io.FileNotFoundException: No permission"), true);
    assert.equal(isUriWritePermissionError("EACCES: permission denied, open"), true);
  });

  it("does not match ordinary write failures", () => {
    assert.equal(isUriWritePermissionError(new Error("No space left on device")), false);
    assert.equal(
      isUriWritePermissionError(new Error("os error 2: no such file or directory")),
      false,
    );
    assert.equal(isUriWritePermissionError(new Error("Failed to serialize project")), false);
  });
});
