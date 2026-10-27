import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createEmptyProject, serializeProject } from "../packages/core/src/project";
import { openRecentProjectFile } from "../apps/geolibre-desktop/src/lib/file-io/project-files";
import { STARTUP_SNAPSHOTS_STORAGE_KEY } from "../apps/geolibre-desktop/src/lib/storage-keys";

const URI =
  "content://com.android.externalstorage.documents/document/primary%3ADocuments%2Fmap.geolibre.json";

/** In-memory Storage with only what the snapshot index reads. */
function memoryStorage(entries: Record<string, string>) {
  return {
    getItem: (key: string) => entries[key] ?? null,
    setItem: (key: string, value: string) => {
      entries[key] = value;
    },
    removeItem: (key: string) => {
      delete entries[key];
    },
  };
}

/**
 * Stand in for the Android app: a Tauri window whose `fs` plugin reads the
 * stored copy from app data, and reads the content URI only while `grantAlive`.
 */
function installAndroidWindow(options: { original: string; copy: string; grantAlive: boolean }) {
  const storage = memoryStorage({
    [STARTUP_SNAPSHOTS_STORAGE_KEY]: JSON.stringify({
      last: { sourcePath: URI, file: "last.geolibre.json", savedAt: "2026-10-26T04:00:00.000Z" },
    }),
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: storage,
      __TAURI_INTERNALS__: {
        invoke: async (cmd: string, args: { path: string }) => {
          assert.equal(cmd, "plugin:fs|read_text_file");
          if (args.path === URI) {
            if (!options.grantAlive) {
              throw new Error(
                "failed to open file: Permission Denial: requires that you obtain access using ACTION_OPEN_DOCUMENT",
              );
            }
            return Array.from(new TextEncoder().encode(options.original));
          }
          return Array.from(new TextEncoder().encode(options.copy));
        },
      },
    },
  });
}

describe("openRecentProjectFile on Android (GeoLibre#3216)", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalWarn = console.warn;
  afterEach(() => {
    console.warn = originalWarn;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });

  const original = serializeProject(createEmptyProject("Edited outside GeoLibre"));
  const copy = serializeProject(createEmptyProject("Stored copy"));

  it("reads the original while the document grant is alive, without the stored-copy flag", async () => {
    installAndroidWindow({ original, copy, grantAlive: true });
    const result = await openRecentProjectFile(URI);
    assert.equal(result.project.name, "Edited outside GeoLibre");
    assert.equal(result.fromStoredCopy, undefined);
  });

  it("flags the stored copy when the original can no longer be read", async () => {
    console.warn = () => {};
    installAndroidWindow({ original, copy, grantAlive: false });
    const result = await openRecentProjectFile(URI);
    assert.equal(result.project.name, "Stored copy");
    assert.equal(result.path, URI);
    assert.equal(result.fromStoredCopy, true);
  });
});
