import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { StartupSettings } from "../apps/geolibre-desktop/src/hooks/useDesktopSettings";
import { STARTUP_SNAPSHOTS_STORAGE_KEY } from "../apps/geolibre-desktop/src/lib/storage-keys";
import {
  exceedsStartupSnapshotLimit,
  MAX_STARTUP_SNAPSHOT_BYTES,
  readStartupSnapshot,
  readStartupSnapshotIndex,
  startupSnapshotFile,
  startupSnapshotSlot,
  writeStartupSnapshot,
  type SnapshotStorage,
} from "../apps/geolibre-desktop/src/lib/startup-project-snapshot";

// The project from GeoLibre#1948, as the Android document picker hands it back:
// /storage/emulated/0/Documents/json/General_Project.geolibre.json.
const CONTENT_URI =
  "content://com.android.externalstorage.documents/document/primary%3ADocuments%2Fjson%2FGeneral_Project.geolibre.json";
const OTHER_CONTENT_URI =
  "content://com.android.externalstorage.documents/document/primary%3ADocuments%2Fjson%2FOther.geolibre.json";
const DESKTOP_PATH = "/home/user/projects/General_Project.geolibre.json";

const PROJECT_TEXT = '{"name":"General Project","layers":[]}';

function settings(patch: Partial<StartupSettings> = {}): StartupSettings {
  return {
    mode: "default",
    projectPath: null,
    projectName: null,
    globeByDefault: true,
    center: [-100, 40],
    zoom: 2,
    ...patch,
  };
}

function makeStorage(initial?: Record<string, string>): SnapshotStorage & {
  items: Map<string, string>;
} {
  const items = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
}

function makeIo(options: { writeError?: unknown; files?: Record<string, string> } = {}) {
  const files = new Map<string, string>(Object.entries(options.files ?? {}));
  const writes: Array<{ file: string; content: string }> = [];
  return {
    files,
    writes,
    io: {
      write: async (file: string, content: string) => {
        if (options.writeError) throw options.writeError;
        writes.push({ file, content });
        files.set(file, content);
      },
      read: async (file: string) => {
        const content = files.get(file);
        if (content === undefined) throw new Error(`No such file: ${file}`);
        return content;
      },
    },
  };
}

describe("startupSnapshotSlot", () => {
  it("copies into the last slot whenever the last project is the one restored", () => {
    assert.equal(startupSnapshotSlot(CONTENT_URI, settings({ mode: "last" })), "last");
  });

  it("copies into the specific slot only for the project the user named", () => {
    const specific = settings({ mode: "specific", projectPath: CONTENT_URI });
    assert.equal(startupSnapshotSlot(CONTENT_URI, specific), "specific");
    // Working on another project must not replace the copy the preference needs.
    assert.equal(startupSnapshotSlot(OTHER_CONTENT_URI, specific), null);
  });

  it("copies nothing when the app opens the default workspace", () => {
    assert.equal(startupSnapshotSlot(CONTENT_URI, settings()), null);
  });

  it("copies nothing for a path that can simply be re-read", () => {
    // Desktop paths, and the browser's bare file names, survive a restart on
    // their own; only Android's per-session `content://` grant does not.
    assert.equal(startupSnapshotSlot(DESKTOP_PATH, settings({ mode: "last" })), null);
    assert.equal(
      startupSnapshotSlot("C:\\Users\\u\\a.geolibre.json", settings({ mode: "last" })),
      null,
    );
    assert.equal(
      startupSnapshotSlot("https://example.com/a.geolibre.json", settings({ mode: "last" })),
      null,
    );
  });
});

describe("exceedsStartupSnapshotLimit", () => {
  it("measures the bytes the file will hold, not the code units of the string", () => {
    // The file is written as UTF-8, so a project of three-byte characters is
    // over the limit at a third of the string length that ASCII would need.
    const thirdOfLimit = Math.floor(MAX_STARTUP_SNAPSHOT_BYTES / 3);
    assert.equal(exceedsStartupSnapshotLimit("a".repeat(thirdOfLimit)), false);
    assert.equal(exceedsStartupSnapshotLimit("\u20ac".repeat(thirdOfLimit + 1)), true);
    // A surrogate pair is four bytes over two code units, so it costs two bytes
    // per code unit rather than three: this many is 20 MB, still under.
    assert.equal(
      exceedsStartupSnapshotLimit("\u{1f600}".repeat(Math.floor(MAX_STARTUP_SNAPSHOT_BYTES / 5))),
      false,
    );
  });

  it("accepts and rejects at the ASCII boundary", () => {
    assert.equal(exceedsStartupSnapshotLimit("a".repeat(MAX_STARTUP_SNAPSHOT_BYTES)), false);
    assert.equal(exceedsStartupSnapshotLimit("a".repeat(MAX_STARTUP_SNAPSHOT_BYTES + 1)), true);
  });
});

describe("writeStartupSnapshot", () => {
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

  it("writes the copy and records where it came from", async () => {
    const storage = makeStorage();
    const { io, writes } = makeIo();
    const slot = await writeStartupSnapshot(
      CONTENT_URI,
      PROJECT_TEXT,
      settings({ mode: "last" }),
      io,
      { storage },
    );
    assert.equal(slot, "last");
    assert.deepEqual(writes, [{ file: startupSnapshotFile("last"), content: PROJECT_TEXT }]);
    const index = readStartupSnapshotIndex(storage);
    assert.equal(index.last?.sourcePath, CONTENT_URI);
    assert.equal(index.last?.file, "last.geolibre.json");
    assert.equal(typeof index.last?.savedAt, "string");
  });

  it("keeps the two slots independent", async () => {
    const storage = makeStorage();
    const { io } = makeIo();
    await writeStartupSnapshot(CONTENT_URI, PROJECT_TEXT, settings({ mode: "last" }), io, {
      storage,
    });
    // Switching the preference to a named project fills the other slot; the copy
    // made for "last" mode stays where it is.
    await writeStartupSnapshot(
      OTHER_CONTENT_URI,
      "{}",
      settings({ mode: "specific", projectPath: OTHER_CONTENT_URI }),
      io,
      { storage },
    );
    const index = readStartupSnapshotIndex(storage);
    assert.equal(index.last?.sourcePath, CONTENT_URI);
    assert.equal(index.specific?.sourcePath, OTHER_CONTENT_URI);
  });

  it("writes nothing for a path that can simply be re-read", async () => {
    const storage = makeStorage();
    const { io, writes } = makeIo();
    // A desktop path is not what the fallback is for, and a stale copy of it
    // would shadow the real file.
    const slot = await writeStartupSnapshot(
      DESKTOP_PATH,
      PROJECT_TEXT,
      settings({ mode: "specific", projectPath: DESKTOP_PATH }),
      io,
      { storage },
    );
    assert.equal(slot, null);
    assert.equal(writes.length, 0);
    assert.deepEqual(readStartupSnapshotIndex(storage), {});
  });

  it("skips a project too large to duplicate on a phone", async () => {
    const storage = makeStorage();
    const { io, writes } = makeIo();
    const slot = await writeStartupSnapshot(
      CONTENT_URI,
      "x".repeat(MAX_STARTUP_SNAPSHOT_BYTES + 1),
      settings({ mode: "last" }),
      io,
      { storage },
    );
    assert.equal(slot, null);
    assert.equal(writes.length, 0);
    assert.equal(warnings.length, 1);
  });

  it("skips one that is only too large once encoded as UTF-8", async () => {
    const storage = makeStorage();
    const { io, writes } = makeIo();
    // Well under the limit counted as code units, well over it as bytes.
    const slot = await writeStartupSnapshot(
      CONTENT_URI,
      "\u20ac".repeat(Math.floor(MAX_STARTUP_SNAPSHOT_BYTES / 2)),
      settings({ mode: "last" }),
      io,
      { storage },
    );
    assert.equal(slot, null);
    assert.equal(writes.length, 0);
    assert.equal(warnings.length, 1);
  });

  it("lets the last copy asked for win the slot, not the last one to land", async () => {
    // Open one project, open another before the first copy has landed. The
    // recent list already says the second is the most recent, so the slot has to
    // agree with it however slowly the first write finishes.
    const storage = makeStorage();
    const files = new Map<string, string>();
    const delays = [40, 0];
    const io = {
      write: async (file: string, content: string) => {
        await new Promise((resolve) => setTimeout(resolve, delays.shift() ?? 0));
        files.set(file, content);
      },
      read: async (file: string) => files.get(file) ?? Promise.reject(new Error("missing")),
    };

    const first = writeStartupSnapshot(CONTENT_URI, "first", settings({ mode: "last" }), io, {
      storage,
    });
    const second = writeStartupSnapshot(
      OTHER_CONTENT_URI,
      "second",
      settings({ mode: "last" }),
      io,
      {
        storage,
      },
    );
    await Promise.all([first, second]);

    assert.equal(files.get(startupSnapshotFile("last")), "second");
    assert.equal(readStartupSnapshotIndex(storage).last?.sourcePath, OTHER_CONTENT_URI);
  });

  it("keeps both slots in the index when their writes overlap", async () => {
    // Opening a project fires a "last" copy; committing a "specific" preference
    // before it lands fires another. Both read the shared index, so without a
    // single queue the later one would write back only its own entry and orphan
    // the other slot's file.
    const storage = makeStorage();
    const files = new Map<string, string>();
    const delays = [40, 0];
    const io = {
      write: async (file: string, content: string) => {
        await new Promise((resolve) => setTimeout(resolve, delays.shift() ?? 0));
        files.set(file, content);
      },
      read: async (file: string) => files.get(file) ?? Promise.reject(new Error("missing")),
    };

    await Promise.all([
      writeStartupSnapshot(CONTENT_URI, "for last", settings({ mode: "last" }), io, { storage }),
      writeStartupSnapshot(
        OTHER_CONTENT_URI,
        "for specific",
        settings({ mode: "specific", projectPath: OTHER_CONTENT_URI }),
        io,
        { storage },
      ),
    ]);

    const index = readStartupSnapshotIndex(storage);
    assert.equal(index.last?.sourcePath, CONTENT_URI);
    assert.equal(index.specific?.sourcePath, OTHER_CONTENT_URI);
  });

  it("swallows a write failure so it cannot fail the save that triggered it", async () => {
    const storage = makeStorage();
    const { io } = makeIo({ writeError: new Error("No space left on device") });
    const slot = await writeStartupSnapshot(
      CONTENT_URI,
      PROJECT_TEXT,
      settings({ mode: "last" }),
      io,
      { storage },
    );
    assert.equal(slot, null);
    assert.equal(warnings.length, 1);
    // Nothing recorded, so a later restore reports the real failure rather than
    // trying to read a file that was never written.
    assert.deepEqual(readStartupSnapshotIndex(storage), {});
  });
});

describe("readStartupSnapshot", () => {
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

  it("returns the copy of the project that was asked for", async () => {
    const storage = makeStorage();
    const { io } = makeIo();
    await writeStartupSnapshot(CONTENT_URI, PROJECT_TEXT, settings({ mode: "last" }), io, {
      storage,
    });
    assert.equal(await readStartupSnapshot(CONTENT_URI, io, storage), PROJECT_TEXT);
  });

  it("never substitutes a copy of a different project", async () => {
    const storage = makeStorage();
    const { io } = makeIo();
    await writeStartupSnapshot(CONTENT_URI, PROJECT_TEXT, settings({ mode: "last" }), io, {
      storage,
    });
    assert.equal(await readStartupSnapshot(OTHER_CONTENT_URI, io, storage), null);
  });

  it("prefers the newest copy when both slots hold the same project", async () => {
    // Running in "specific" mode on a project and later switching to "last"
    // leaves a copy in each slot, and only the active mode's slot is refreshed.
    const storage = makeStorage({
      [STARTUP_SNAPSHOTS_STORAGE_KEY]: JSON.stringify({
        specific: {
          sourcePath: CONTENT_URI,
          file: "specific.geolibre.json",
          savedAt: "2026-08-01T00:00:00.000Z",
        },
        last: {
          sourcePath: CONTENT_URI,
          file: "last.geolibre.json",
          savedAt: "2026-08-15T00:00:00.000Z",
        },
      }),
    });
    const { io } = makeIo({
      files: { "specific.geolibre.json": "stale", "last.geolibre.json": "fresh" },
    });
    assert.equal(await readStartupSnapshot(CONTENT_URI, io, storage), "fresh");
  });

  it("falls through to an older copy when the newest slot's file is gone", async () => {
    const storage = makeStorage({
      [STARTUP_SNAPSHOTS_STORAGE_KEY]: JSON.stringify({
        specific: {
          sourcePath: CONTENT_URI,
          file: "specific.geolibre.json",
          savedAt: "2026-08-01T00:00:00.000Z",
        },
        last: {
          sourcePath: CONTENT_URI,
          file: "last.geolibre.json",
          savedAt: "2026-08-15T00:00:00.000Z",
        },
      }),
    });
    // Only the older slot's file survived. An older copy of the right project
    // still beats reporting the project as unavailable.
    const { io } = makeIo({ files: { "specific.geolibre.json": "older" } });
    assert.equal(await readStartupSnapshot(CONTENT_URI, io, storage), "older");
    assert.equal(warnings.length, 1);
  });

  it("returns null when there is no copy at all", async () => {
    const { io } = makeIo();
    assert.equal(await readStartupSnapshot(CONTENT_URI, io, makeStorage()), null);
    assert.equal(await readStartupSnapshot(CONTENT_URI, io, null), null);
  });

  it("returns null when the index outlived its file", async () => {
    const storage = makeStorage({
      [STARTUP_SNAPSHOTS_STORAGE_KEY]: JSON.stringify({
        last: { sourcePath: CONTENT_URI, file: "last.geolibre.json", savedAt: "2026-08-15" },
      }),
    });
    const { io } = makeIo();
    assert.equal(await readStartupSnapshot(CONTENT_URI, io, storage), null);
    assert.equal(warnings.length, 1);
  });
});

describe("readStartupSnapshotIndex", () => {
  it("ignores stored text that is not a usable index", () => {
    assert.deepEqual(
      readStartupSnapshotIndex(makeStorage({ [STARTUP_SNAPSHOTS_STORAGE_KEY]: "not json" })),
      {},
    );
    assert.deepEqual(
      readStartupSnapshotIndex(makeStorage({ [STARTUP_SNAPSHOTS_STORAGE_KEY]: "[1,2]" })),
      {},
    );
    // A half-written entry is dropped rather than read back as a snapshot with
    // an empty file name.
    assert.deepEqual(
      readStartupSnapshotIndex(
        makeStorage({
          [STARTUP_SNAPSHOTS_STORAGE_KEY]: JSON.stringify({
            last: { sourcePath: CONTENT_URI, file: "", savedAt: "2026-08-15" },
            specific: { sourcePath: 7 },
          }),
        }),
      ),
      {},
    );
  });
});
