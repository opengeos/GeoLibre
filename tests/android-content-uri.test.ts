import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  androidContentUriFileName,
  isAndroidContentUri,
  isUriWritePermissionError,
  writeInPlaceWithAndroidFallback,
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

// The message Android returns for a read-only `content://` grant, verbatim from
// the issue's diagnostic log.
const DENIAL = new Error(
  "failed to open file: Permission Denial: writing com.android.externalstorage.ExternalStorageProvider uri " +
    `${EXTERNAL_STORAGE_URI} from pid=7564, uid=10393 requires android.permission.MANAGE_DOCUMENTS, ` +
    "or grantUriPermission()",
);

// A save-dialog URI is writable, so the fallback's own write succeeds; only the
// in-place write to the read-only URI is refused, as on a device.
const CREATED_URI =
  "content://com.android.externalstorage.documents/document/primary%3ADocuments%2Fjson%2FGeneral_Project(1).geolibre.json";

function makeHandlers(options: { writeError?: unknown; saveAsResult?: string | null } = {}) {
  const writes: Array<{ path: string; content: string }> = [];
  const saveAsCalls: Array<{ content: string; defaultName?: string }> = [];
  return {
    writes,
    saveAsCalls,
    handlers: {
      write: async (path: string, content: string) => {
        if (options.writeError && path !== CREATED_URI) throw options.writeError;
        writes.push({ path, content });
      },
      saveAs: async (content: string, defaultName?: string) => {
        saveAsCalls.push({ content, defaultName });
        const created = options.saveAsResult === undefined ? CREATED_URI : options.saveAsResult;
        if (created !== null) writes.push({ path: created, content });
        return created;
      },
    },
  };
}

describe("writeInPlaceWithAndroidFallback", () => {
  // The fallback logs the original refusal to the Diagnostics panel, so collect
  // `console.warn` rather than letting it scribble over the test output.
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;

  beforeEach(() => {
    warnings.length = 0;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  it("writes in place and never opens a dialog when the write succeeds", async () => {
    const { handlers, writes, saveAsCalls } = makeHandlers();
    const path = await writeInPlaceWithAndroidFallback(
      "{}",
      "/home/user/a.geolibre.json",
      "a.geolibre.json",
      handlers,
    );
    assert.equal(path, "/home/user/a.geolibre.json");
    assert.deepEqual(writes, [{ path: "/home/user/a.geolibre.json", content: "{}" }]);
    assert.equal(saveAsCalls.length, 0);
  });

  it("falls back to the save dialog when Android refuses a content URI", async () => {
    const { handlers, writes, saveAsCalls } = makeHandlers({ writeError: DENIAL });
    const path = await writeInPlaceWithAndroidFallback(
      "{}",
      EXTERNAL_STORAGE_URI,
      "Untitled Project.geolibre.json",
      handlers,
    );
    // The dialog is pre-filled with the name recovered from the URI, not the
    // generic project name, so the user can save over the file they opened.
    assert.deepEqual(saveAsCalls, [
      { content: "{}", defaultName: "General_Project.geolibre.json" },
    ]);
    // The refused write touched nothing; only the created document was written.
    assert.deepEqual(writes, [{ path: CREATED_URI, content: "{}" }]);
    // The writable URI becomes the project path, so later saves go in place.
    assert.equal(path, CREATED_URI);
    // The original refusal reaches the Diagnostics panel, so an unexpected
    // fallback on some other provider can be diagnosed from a user's report.
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]?.[0]), /cannot write .* in place/);
    assert.equal(warnings[0]?.[1], DENIAL);
  });

  it("falls back to the caller's name when the URI has no usable one", async () => {
    const { handlers, saveAsCalls } = makeHandlers({ writeError: DENIAL });
    await writeInPlaceWithAndroidFallback(
      "{}",
      "content://com.android.providers.downloads.documents/document/msf%3A1000000123",
      "Untitled Project.geolibre.json",
      handlers,
    );
    assert.equal(saveAsCalls[0]?.defaultName, "Untitled Project.geolibre.json");
  });

  it("reports a cancelled fallback dialog as no save", async () => {
    const { handlers, writes } = makeHandlers({ writeError: DENIAL, saveAsResult: null });
    const path = await writeInPlaceWithAndroidFallback(
      "{}",
      EXTERNAL_STORAGE_URI,
      "Untitled Project.geolibre.json",
      handlers,
    );
    assert.equal(path, null);
    assert.deepEqual(writes, []);
  });

  it("rethrows an ordinary write failure instead of reopening a dialog", async () => {
    const { handlers, saveAsCalls } = makeHandlers({
      writeError: new Error("No space left on device"),
    });
    await assert.rejects(
      () =>
        writeInPlaceWithAndroidFallback(
          "{}",
          EXTERNAL_STORAGE_URI,
          "Untitled Project.geolibre.json",
          handlers,
        ),
      /No space left/,
    );
    assert.equal(saveAsCalls.length, 0);
  });

  it("rethrows a permission error on a plain filesystem path", async () => {
    const { handlers, saveAsCalls } = makeHandlers({
      writeError: new Error("EACCES: permission denied, open '/etc/a.geolibre.json'"),
    });
    await assert.rejects(
      () =>
        writeInPlaceWithAndroidFallback("{}", "/etc/a.geolibre.json", "a.geolibre.json", handlers),
      /EACCES/,
    );
    assert.equal(saveAsCalls.length, 0);
  });
});
