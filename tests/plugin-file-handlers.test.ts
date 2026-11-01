import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { strToU8, zipSync } from "fflate";
import type { TFunction } from "i18next";
import {
  __resetFileHandlerRegistryForTests,
  listFileHandlers,
  registerFileHandler,
  unregisterFileHandler,
  unregisterFileHandlersByOwner,
} from "../packages/plugins/src/file-handler-registry";
import { PluginManager } from "../packages/plugins/src/plugin-manager";
import type {
  GeoLibreAppAPI,
  GeoLibreDroppedFile,
  GeoLibreFileHandler,
} from "../packages/plugins/src/types";
import {
  type DropLeaf,
  listZipEntryPaths,
  matchesFileHandlerExtensions,
  offerBrowserDrop,
  offerDropToFileHandlers,
  reportFileHandlerDrop,
} from "../apps/geolibre-desktop/src/lib/plugin-file-drop";

function handler(overrides: Partial<GeoLibreFileHandler> = {}): GeoLibreFileHandler {
  return {
    id: "h",
    name: "Handler",
    extensions: [".zip"],
    claim: (files) => files,
    open: () => undefined,
    ...overrides,
  };
}

/** A read-range over bytes that records how much was actually read. */
function rangeReader(bytes: Uint8Array) {
  const reads = { total: 0 };
  return {
    reads,
    readRange: async (offset: number, length: number) => {
      reads.total += length;
      return bytes.subarray(offset, offset + length);
    },
  };
}

function leaf(name: string, bytes: Uint8Array = new Uint8Array(), path?: string): DropLeaf<string> {
  const origin = path ? path.split("/")[0]! : name;
  return {
    origin,
    name,
    path,
    size: bytes.byteLength,
    read: async () => bytes.slice().buffer,
    readRange: rangeReader(bytes).readRange,
  };
}

function origins(leaves: DropLeaf<string>[]): string[] {
  return [...new Set(leaves.map((l) => l.origin))];
}

const taskDataZip = zipSync({
  "TASKDATA/TASKDATA.XML": strToU8("<ISO11783_TaskData/>"),
  "TASKDATA/TLG00001.BIN": new Uint8Array(4),
});
const shapefileZip = zipSync({ "roads.shp": new Uint8Array(4), "roads.dbf": new Uint8Array(4) });

describe("file handler registry", () => {
  afterEach(() => __resetFileHandlerRegistryForTests());

  it("lists handlers in registration order and keeps the slot when an id is replaced", () => {
    registerFileHandler(handler({ id: "a", name: "A1" }));
    registerFileHandler(handler({ id: "b" }));
    registerFileHandler(handler({ id: "a", name: "A2" }));
    assert.deepEqual(
      listFileHandlers().map((h) => h.name),
      ["A2", "Handler"],
    );
  });

  it("rejects a handler it could never call", () => {
    assert.throws(() => registerFileHandler(handler({ id: "" })), /non-empty id/);
    assert.throws(() => registerFileHandler(handler({ name: "" })), /non-empty name/);
    assert.throws(() => registerFileHandler(handler({ extensions: [] })), /at least one/);
    assert.throws(
      () => registerFileHandler(handler({ extensions: [".zip", undefined as never] })),
      /at least one/,
    );
    assert.throws(
      () => registerFileHandler(handler({ claim: undefined as never })),
      /claim and open/,
    );
  });

  it("a stale disposer cannot evict a newer handler that reused the id", () => {
    const dispose = registerFileHandler(handler({ name: "old" }));
    registerFileHandler(handler({ name: "new" }));
    dispose();
    assert.equal(listFileHandlers()[0]?.name, "new");
  });

  it("only lets the owner unregister, and removes by owner", () => {
    registerFileHandler(handler({ id: "a" }), "plugin-a");
    unregisterFileHandler("a", "plugin-b");
    assert.equal(listFileHandlers().length, 1);
    unregisterFileHandler("a", "plugin-a");
    assert.equal(listFileHandlers().length, 0);

    registerFileHandler(handler({ id: "a" }), "plugin-a");
    registerFileHandler(handler({ id: "b" }), "plugin-b");
    unregisterFileHandlersByOwner("plugin-a");
    assert.deepEqual(
      listFileHandlers().map((h) => h.id),
      ["b"],
    );
  });

  it("the plugin manager scopes registration and releases handlers on deactivate", () => {
    const manager = new PluginManager();
    const mockApp = {
      registerFileHandler,
      unregisterFileHandler,
    } as unknown as GeoLibreAppAPI;
    manager.register({
      id: "drop-plugin",
      name: "Drop plugin",
      version: "1.0.0",
      activate: (api) => void api.registerFileHandler?.(handler({ id: "drop-plugin-h" })),
      deactivate: () => undefined,
    });
    manager.activate("drop-plugin", mockApp);
    assert.equal(listFileHandlers().length, 1);
    manager.deactivate("drop-plugin", mockApp);
    assert.equal(listFileHandlers().length, 0);
  });
});

describe("listZipEntryPaths", () => {
  it("lists entries from the tail, without reading the file data", async () => {
    const stored = zipSync(
      { "big.bin": new Uint8Array(500_000), "a/b.xml": strToU8("x") },
      {
        level: 0,
      },
    );
    const { reads, readRange } = rangeReader(stored);
    assert.deepEqual(await listZipEntryPaths(stored.byteLength, readRange), ["big.bin", "a/b.xml"]);
    assert.ok(reads.total < 70_000, `read ${reads.total} of ${stored.byteLength} bytes`);
  });

  it("handles a zip comment after the directory", async () => {
    const zip = zipSync({ "a.txt": strToU8("x") });
    const comment = strToU8("hello");
    const bytes = new Uint8Array(zip.byteLength + comment.byteLength);
    bytes.set(zip);
    bytes.set(comment, zip.byteLength);
    new DataView(bytes.buffer).setUint16(zip.byteLength - 2, comment.byteLength, true);
    assert.deepEqual(await listZipEntryPaths(bytes.byteLength, rangeReader(bytes).readRange), [
      "a.txt",
    ]);
  });

  it("follows the zip64 records", async () => {
    const zip = zipSync({ "a.txt": strToU8("x") });
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const eocd = zip.byteLength - 22;
    const directorySize = view.getUint32(eocd + 12, true);
    const directoryOffset = view.getUint32(eocd + 16, true);
    // zip64 EOCD + locator go between the directory and a saturated classic EOCD.
    const bytes = new Uint8Array(zip.byteLength + 56 + 20);
    bytes.set(zip.subarray(0, eocd));
    const out = new DataView(bytes.buffer);
    out.setUint32(eocd, 0x06064b50, true);
    out.setBigUint64(eocd + 40, BigInt(directorySize), true);
    out.setBigUint64(eocd + 48, BigInt(directoryOffset), true);
    out.setUint32(eocd + 56, 0x07064b50, true);
    out.setBigUint64(eocd + 56 + 8, BigInt(eocd), true);
    const classic = eocd + 56 + 20;
    bytes.set(zip.subarray(eocd), classic);
    out.setUint32(classic + 12, 0xffffffff, true);
    out.setUint32(classic + 16, 0xffffffff, true);
    assert.deepEqual(await listZipEntryPaths(bytes.byteLength, rangeReader(bytes).readRange), [
      "a.txt",
    ]);
  });

  it("returns undefined for a file that is not a zip", async () => {
    const bytes = new Uint8Array(1000).fill(7);
    assert.equal(
      await listZipEntryPaths(bytes.byteLength, rangeReader(bytes).readRange),
      undefined,
    );
    assert.equal(await listZipEntryPaths(3, rangeReader(new Uint8Array(3)).readRange), undefined);
  });
});

describe("reportFileHandlerDrop", () => {
  const t = ((key: string, options: Record<string, string>) =>
    `${key}:${Object.values(options).join("|")}`) as unknown as TFunction;

  it("reports nothing and returns false when no handler took files", () => {
    let calls = 0;
    const bump = () => {
      calls += 1;
    };
    assert.equal(
      reportFileHandlerDrop({ unclaimed: [], opened: [], failed: [] }, bump, bump, t),
      false,
    );
    assert.equal(calls, 0);
  });

  it("keeps the success message and shows every failure when results are mixed", () => {
    const messages: Array<string | null> = [];
    const errors: Array<string | null> = [];
    reportFileHandlerDrop(
      {
        unclaimed: [],
        opened: [handler({ name: "A" })],
        failed: [
          { handler: handler({ name: "B" }), error: new Error("x") },
          { handler: handler({ name: "C" }), error: new Error("y") },
        ],
      },
      (m) => messages.push(m),
      (e) => errors.push(e),
      t,
    );
    assert.equal(messages.length, 1);
    assert.equal(
      errors[0],
      "toolbar.fileDrop.handlerFailed:B|x toolbar.fileDrop.handlerFailed:C|y",
    );
  });

  it("names the handlers that opened, and shows a failure as an error", () => {
    const messages: Array<string | null> = [];
    const errors: Array<string | null> = [];
    const handled = reportFileHandlerDrop(
      { unclaimed: [], opened: [handler({ name: "A" })], failed: [] },
      (m) => messages.push(m),
      (e) => errors.push(e),
      t,
    );
    assert.equal(handled, true);
    assert.equal(messages[0], "toolbar.fileDrop.openedByHandler:A");
    reportFileHandlerDrop(
      {
        unclaimed: [],
        opened: [],
        failed: [{ handler: handler({ name: "B" }), error: new Error("bad") }],
      },
      (m) => messages.push(m),
      (e) => errors.push(e),
      t,
    );
    assert.equal(messages.at(-1), null);
    assert.deepEqual(errors, ["toolbar.fileDrop.handlerFailed:B|bad"]);
  });
});

describe("matchesFileHandlerExtensions", () => {
  it("ignores case and tolerates a missing dot", () => {
    assert.ok(matchesFileHandlerExtensions("TASKDATA.ZIP", [".zip"]));
    assert.ok(matchesFileHandlerExtensions("track.fit", ["FIT"]));
    assert.ok(matchesFileHandlerExtensions("a.copc.laz", [".copc.laz"]));
    assert.ok(!matchesFileHandlerExtensions("zip", [".zip"]));
    assert.ok(!matchesFileHandlerExtensions("afit", ["fit"]));
  });
});

describe("offerDropToFileHandlers", () => {
  const isTaskData: GeoLibreFileHandler["claim"] = (files) =>
    files.filter((file) => file.entries?.some((e) => e.endsWith("TASKDATA.XML")));

  it("leaves a shapefile zip to the core while taking a TASKDATA.zip", async () => {
    const opened: GeoLibreDroppedFile[] = [];
    const leaves = [leaf("TASKDATA.zip", taskDataZip), leaf("roads.zip", shapefileZip)];
    const result = await offerDropToFileHandlers(leaves, origins(leaves), [
      handler({
        claim: isTaskData,
        open: (files) => {
          opened.push(...files);
        },
      }),
    ]);
    assert.deepEqual(result.unclaimed, ["roads.zip"]);
    assert.deepEqual(
      opened.map((f) => f.name),
      ["TASKDATA.zip"],
    );
    assert.equal(result.opened.length, 1);
    assert.equal(new Uint8Array(await opened[0]!.arrayBuffer()).byteLength, taskDataZip.byteLength);
  });

  it("never calls claim for a file outside the extensions", async () => {
    let claimed = 0;
    const leaves = [leaf("roads.geojson")];
    const result = await offerDropToFileHandlers(leaves, origins(leaves), [
      handler({
        claim: (files) => {
          claimed += 1;
          return files;
        },
      }),
    ]);
    assert.equal(claimed, 0);
    assert.deepEqual(result.unclaimed, ["roads.geojson"]);
  });

  it("does not offer a claimed file to the next handler, and accepts returned copies", async () => {
    const seenBySecond: string[] = [];
    const leaves = [leaf("a.fit"), leaf("b.fit")];
    const result = await offerDropToFileHandlers(leaves, origins(leaves), [
      handler({
        id: "first",
        extensions: [".fit"],
        claim: (files) => files.filter((f) => f.name === "a.fit").map((f) => ({ ...f })),
      }),
      handler({
        id: "second",
        extensions: [".fit"],
        claim: (files) => {
          seenBySecond.push(...files.map((f) => f.name));
          return [];
        },
      }),
    ]);
    assert.deepEqual(seenBySecond, ["b.fit"]);
    assert.deepEqual(result.unclaimed, ["b.fit"]);
  });

  it("claims only one of two files that share a name when one is returned", async () => {
    const leaves = [leaf("same.fit"), { ...leaf("same.fit"), origin: "other/same.fit" }];
    const result = await offerDropToFileHandlers(leaves, origins(leaves), [
      handler({ extensions: [".fit"], claim: (files) => files.slice(0, 1) }),
    ]);
    assert.deepEqual(result.unclaimed, ["other/same.fit"]);
  });

  it("treats a throwing claim as not mine and still tries later handlers", async () => {
    const leaves = [leaf("a.fit")];
    const result = await offerDropToFileHandlers(leaves, origins(leaves), [
      handler({
        id: "broken",
        extensions: [".fit"],
        claim: () => {
          throw new Error("boom");
        },
      }),
      handler({ id: "good", extensions: [".fit"] }),
    ]);
    assert.deepEqual(result.unclaimed, []);
    assert.deepEqual(
      result.opened.map((h) => h.id),
      ["good"],
    );
  });

  it("reports a throwing open and keeps its files claimed", async () => {
    const leaves = [leaf("a.fit")];
    const result = await offerDropToFileHandlers(leaves, origins(leaves), [
      handler({
        extensions: [".fit"],
        open: async () => {
          throw new Error("bad file");
        },
      }),
    ]);
    assert.deepEqual(result.unclaimed, []);
    assert.equal(result.opened.length, 0);
    assert.equal((result.failed[0]?.error as Error).message, "bad file");
  });

  it("consumes a folder a handler took part of, and leaves an unclaimed folder", async () => {
    const leaves = [
      leaf("TASKDATA.XML", new Uint8Array(), "TASKDATA/TASKDATA.XML"),
      leaf("notes.xml", new Uint8Array(), "TASKDATA/notes.xml"),
      leaf("other.xml", new Uint8Array(), "OTHER/other.xml"),
    ];
    const opened: Array<string | undefined> = [];
    const result = await offerDropToFileHandlers(
      leaves,
      ["TASKDATA", "OTHER"],
      [
        handler({
          extensions: [".xml"],
          claim: (files) => files.filter((f) => f.name === "TASKDATA.XML"),
          open: (files) => {
            opened.push(...files.map((f) => f.path));
          },
        }),
      ],
    );
    assert.deepEqual(opened, ["TASKDATA/TASKDATA.XML"]);
    assert.deepEqual(result.unclaimed, ["OTHER"]);
  });
});

/** A minimal browser directory entry; `readEntries` returns batches, then empty. */
function fakeDirectory(name: string, children: FileSystemEntry[]): FileSystemDirectoryEntry {
  let done = false;
  return {
    name,
    isDirectory: true,
    isFile: false,
    createReader: () => ({
      readEntries: (resolve: (batch: FileSystemEntry[]) => void) => {
        resolve(done ? [] : children);
        done = true;
      },
    }),
  } as unknown as FileSystemDirectoryEntry;
}

function fakeFileEntry(file: File): FileSystemEntry {
  return {
    name: file.name,
    isDirectory: false,
    isFile: true,
    file: (resolve: (f: File) => void) => resolve(file),
  } as unknown as FileSystemEntry;
}

describe("offerBrowserDrop", () => {
  it("passes the drop through untouched with no handlers registered", async () => {
    const files = [new File(["x"], "a.zip")];
    const result = await offerBrowserDrop(files, new Map(), []);
    assert.equal(result.unclaimed, files);
  });

  it("offers real File objects with their zip entries and reads them", async () => {
    let text = "";
    const taskDataHandler = handler({
      claim: (files) => files.filter((f) => f.entries?.includes("TASKDATA/TASKDATA.XML")),
      open: async (files) => {
        text = (await files[0]!.arrayBuffer()).byteLength.toString();
      },
    });
    const zipBytes = taskDataZip.slice().buffer as ArrayBuffer;
    const taskData = new File([zipBytes], "TASKDATA.zip");
    const roads = new File([shapefileZip.slice().buffer as ArrayBuffer], "roads.zip");
    const result = await offerBrowserDrop([taskData, roads], new Map(), [taskDataHandler]);
    assert.deepEqual(result.unclaimed, [roads]);
    assert.equal(text, String(taskDataZip.byteLength));
  });

  it("expands a dropped folder, giving nested files a relative path", async () => {
    const paths: Array<string | undefined> = [];
    const placeholder = new File([], "TASKDATA");
    const folder = fakeDirectory("TASKDATA", [
      fakeFileEntry(new File(["<x/>"], "TASKDATA.XML")),
      fakeFileEntry(new File(["hidden"], ".DS_Store")),
      fakeFileEntry(new File(["jpeg"], "photo.jpg")),
      fakeDirectory("logs", [fakeFileEntry(new File(["01"], "TLG00001.BIN"))]),
    ]);
    const result = await offerBrowserDrop([placeholder], new Map([["TASKDATA", [folder]]]), [
      handler({
        extensions: [".xml", ".bin"],
        open: (files) => {
          paths.push(...files.map((f) => f.path));
        },
      }),
    ]);
    assert.deepEqual(paths, ["TASKDATA/TASKDATA.XML", "TASKDATA/logs/TLG00001.BIN"]);
    assert.deepEqual(result.unclaimed, []);
  });

  it("walks both of two folders that share a name", async () => {
    const paths: Array<string | undefined> = [];
    const first = fakeDirectory("TASKDATA", [fakeFileEntry(new File(["x"], "a.xml"))]);
    const second = fakeDirectory("TASKDATA", [fakeFileEntry(new File(["x"], "b.xml"))]);
    const placeholders = [new File([], "TASKDATA"), new File([], "TASKDATA")];
    await offerBrowserDrop(placeholders, new Map([["TASKDATA", [first, second]]]), [
      handler({
        extensions: [".xml"],
        open: (files) => {
          paths.push(...files.map((f) => f.path));
        },
      }),
    ]);
    assert.deepEqual(paths, ["TASKDATA/a.xml", "TASKDATA/b.xml"]);
  });

  it("leaves an unclaimed folder as the placeholder the built-in groups saw before", async () => {
    const placeholder = new File([], "TASKDATA");
    const folder = fakeDirectory("TASKDATA", [fakeFileEntry(new File(["x"], "a.xml"))]);
    const result = await offerBrowserDrop([placeholder], new Map([["TASKDATA", [folder]]]), [
      handler({ extensions: [".xml"], claim: () => [] }),
    ]);
    assert.deepEqual(result.unclaimed, [placeholder]);
  });
});
