import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { strToU8, zipSync } from "fflate";
import type {
  GeoLibreDroppedFile,
  GeoLibreDroppedFileInfo,
  GeoLibreFileHandler,
} from "../packages/plugins/src/types";
import { queueDataLoad } from "../apps/geolibre-desktop/src/lib/data-load-queue";
import { fetchRemoteData, remoteFileName } from "../apps/geolibre-desktop/src/lib/data-url";
import {
  type DataUrlFileHandlers,
  dataUrlFileHandlers,
  fetchStyleUnlessHandlerHint,
  finishHandledLoad,
  trackHandlerLayers,
  urlFileHandlers,
} from "../apps/geolibre-desktop/src/lib/data-url-file-handlers";
import {
  awaitingEntryState,
  createLatch,
  createSettleGate,
  deepLinkSettled,
  startupActivationSettled,
} from "../apps/geolibre-desktop/src/lib/settle-gate";

const collection = {
  type: "FeatureCollection" as const,
  features: [{ type: "Feature" as const, id: "a", properties: {}, geometry: null }],
};
const taskDataZip = zipSync({ "TASKDATA/TASKDATA.XML": strToU8("<ISO11783_TaskData/>") });
const geojsonZip = zipSync({ "parks.geojson": strToU8(JSON.stringify(collection)) });

function fetching(body: Uint8Array | string, headers: Record<string, string> = {}) {
  const payload = typeof body === "string" ? body : new Blob([body as BlobPart]);
  return (async () => new Response(payload, { headers })) as unknown as typeof fetch;
}

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

function source(handlers: GeoLibreFileHandler[], hints: Record<string, string> = {}) {
  const registry: DataUrlFileHandlers = {
    list: () => handlers,
    forDataType: (name) => handlers.find((h) => h.id === hints[name]),
  };
  return registry;
}

describe("fetchRemoteData with file handlers", () => {
  it("offers a downloaded zip to a handler, with its entries, and skips the GeoJSON step", async () => {
    let claimed: unknown;
    let opened: GeoLibreDroppedFile[] = [];
    const taskData = handler({
      claim: (files) => {
        claimed = files[0];
        return files.filter((file) => file.entries?.includes("TASKDATA/TASKDATA.XML"));
      },
      open: (files) => void (opened = files),
    });
    const result = await fetchRemoteData("https://example.com/files/TASKDATA.zip?sig=1", {
      fetchImpl: fetching(taskDataZip),
      fileHandlers: source([taskData]),
    });
    assert.equal(result.kind, "handled");
    if (result.kind === "handled") assert.deepEqual(result.opened, [taskData]);
    assert.equal((claimed as { name: string }).name, "TASKDATA.zip");
    assert.deepEqual((claimed as { entries: string[] }).entries, ["TASKDATA/TASKDATA.XML"]);
    assert.equal(opened.length, 1);
    assert.equal((await opened[0]!.arrayBuffer()).byteLength, taskDataZip.byteLength);
  });

  it("names the file from Content-Disposition when the path has no extension", async () => {
    let seen: string | undefined;
    const result = await fetchRemoteData("https://api.example.com/download/42", {
      fetchImpl: fetching(taskDataZip, {
        "Content-Disposition": 'attachment; filename="Export 7.ZIP"',
      }),
      fileHandlers: source([handler({ claim: (files) => ((seen = files[0]!.name), files) })]),
    });
    assert.equal(result.kind, "handled");
    assert.equal(seen, "Export 7.ZIP");
  });

  it("matches .zip handlers for an extensionless URL the app knows is a zip", async () => {
    for (const headers of [
      { "Content-Type": "application/zip" },
      { "Content-Type": "application/octet-stream" }, // only the PK bytes say zip
    ]) {
      let seen: { name: string; entries?: string[] } | undefined;
      const result = await fetchRemoteData("https://api.example.com/download/abc123?sig=1", {
        fetchImpl: fetching(taskDataZip, headers),
        fileHandlers: source([handler({ claim: (files) => ((seen = files[0]), files) })]),
      });
      assert.equal(result.kind, "handled");
      assert.equal(seen?.name, "abc123.zip");
      assert.deepEqual(seen?.entries, ["TASKDATA/TASKDATA.XML"]);
    }
  });

  it("does not guess a zip name for bytes that are not a zip", async () => {
    let called = false;
    const result = await fetchRemoteData("https://api.example.com/download/abc123", {
      fetchImpl: fetching(JSON.stringify(collection)),
      fileHandlers: source([handler({ claim: () => ((called = true), []) })]),
    });
    assert.equal(result.kind, "geojson");
    assert.equal(called, false);
  });

  it("is unchanged without handlers: a TASKDATA zip still fails as a GeoJSON zip", async () => {
    for (const fileHandlers of [undefined, source([])]) {
      await assert.rejects(
        fetchRemoteData("https://example.com/TASKDATA.zip", {
          fetchImpl: fetching(taskDataZip),
          fileHandlers,
        }),
        /does not contain any GeoJSON/,
      );
    }
  });

  it("is unchanged when no handler claims the file", async () => {
    const result = await fetchRemoteData("https://example.com/bundle.zip", {
      fetchImpl: fetching(geojsonZip),
      fileHandlers: source([handler({ claim: () => [] })]),
    });
    assert.equal(result.kind, "geojson");
  });

  it("never offers a file outside the handler's extensions", async () => {
    let called = false;
    const result = await fetchRemoteData("https://example.com/places.geojson", {
      fetchImpl: fetching(JSON.stringify(collection)),
      fileHandlers: source([handler({ claim: () => ((called = true), []) })]),
    });
    assert.equal(result.kind, "geojson");
    assert.equal(called, false);
  });

  it("treats a throwing claim as not mine and falls through to the built-in loader", async () => {
    const result = await fetchRemoteData("https://example.com/bundle.zip", {
      fetchImpl: fetching(geojsonZip),
      fileHandlers: source([
        handler({
          claim: () => {
            throw new Error("boom");
          },
        }),
      ]),
    });
    assert.equal(result.kind, "geojson");
  });

  it("reports a throwing open and does not add a GeoJSON zip error", async () => {
    const failing = handler({
      open: () => {
        throw new Error("cannot parse");
      },
    });
    const result = await fetchRemoteData("https://example.com/TASKDATA.zip", {
      fetchImpl: fetching(taskDataZip),
      fileHandlers: source([failing]),
    });
    assert.equal(result.kind, "handled");
    if (result.kind === "handled") {
      assert.equal(result.opened.length, 0);
      assert.equal(result.failed[0]?.handler, failing);
      assert.match(String(result.failed[0]?.error), /cannot parse/);
    }
  });

  it("routes a dataType hint straight to open, without claim or the extension filter", async () => {
    let claimCalls = 0;
    let opened: GeoLibreDroppedFile[] = [];
    const taskData = handler({
      extensions: [".xml"],
      claim: () => ((claimCalls += 1), []),
      open: (files) => void (opened = files),
    });
    const result = await fetchRemoteData("https://api.example.com/download/42?sig=abc", {
      fetchImpl: fetching(taskDataZip),
      fileHandlers: source([taskData], { isoxml: "h" }),
      dataType: "isoxml",
    });
    assert.equal(result.kind, "handled");
    assert.equal(claimCalls, 0);
    assert.equal(opened.length, 1);
    assert.equal(opened[0]!.name, "42");
  });

  it("lets a hint win over a path that would be a COG, and reports a throwing open", async () => {
    const result = await fetchRemoteData("https://example.com/odd.tif", {
      fetchImpl: fetching(new Uint8Array(8)),
      fileHandlers: source(
        [
          handler({
            open: () => {
              throw new Error("nope");
            },
          }),
        ],
        { isoxml: "h" },
      ),
      dataType: "isoxml",
    });
    assert.equal(result.kind, "handled");
    if (result.kind === "handled") assert.equal(result.failed.length, 1);
  });

  it("does not let a handler take over the lidar hint", async () => {
    let asked: string | undefined;
    const registry: DataUrlFileHandlers = {
      list: () => [handler()],
      forDataType: (name) => ((asked = name), handler()),
    };
    const result = await fetchRemoteData("https://api.example.com/download/42", {
      fetchImpl: (async () =>
        new Response(null, {
          status: 206,
          headers: { "content-range": "bytes 0-0/1024" },
        })) as unknown as typeof fetch,
      fileHandlers: registry,
      dataType: "lidar",
    });
    assert.equal(result.kind, "lidar");
    assert.equal(asked, undefined);
  });

  it("treats a hint no handler declares as today", async () => {
    const result = await fetchRemoteData("https://example.com/data", {
      fetchImpl: fetching(JSON.stringify(collection)),
      fileHandlers: source([handler()]),
      dataType: "unknown-hint",
    });
    assert.equal(result.kind, "geojson");
  });

  it("keeps the download ceiling: a handler never sees an oversized download", async () => {
    let claimCalls = 0;
    await assert.rejects(
      fetchRemoteData("https://example.com/huge.zip", {
        fetchImpl: fetching(taskDataZip, { "Content-Length": String(300 * 1024 * 1024) }),
        fileHandlers: source([handler({ claim: () => ((claimCalls += 1), []) })], { x: "h" }),
      }),
      /too large/,
    );
    await assert.rejects(
      fetchRemoteData("https://example.com/huge", {
        fetchImpl: fetching(taskDataZip, { "Content-Length": String(300 * 1024 * 1024) }),
        fileHandlers: source([handler()], { isoxml: "h" }),
        dataType: "isoxml",
      }),
      /too large/,
    );
    assert.equal(claimCalls, 0);
  });

  it("waits for the handlers to be ready before offering, so late registration counts", async () => {
    const late: GeoLibreFileHandler[] = [];
    let opened = false;
    const registry: DataUrlFileHandlers = {
      list: () => late,
      forDataType: () => undefined,
      ready: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        late.push(handler({ open: () => void (opened = true) }));
      },
    };
    const result = await fetchRemoteData("https://example.com/TASKDATA.zip", {
      fetchImpl: fetching(taskDataZip),
      fileHandlers: registry,
    });
    assert.equal(result.kind, "handled");
    assert.equal(opened, true);
  });

  it("waits for readiness before resolving a hint too", async () => {
    const late: GeoLibreFileHandler[] = [];
    const registry: DataUrlFileHandlers = {
      list: () => late,
      forDataType: (name) => late.find((h) => name === "isoxml" && h.id === "h"),
      ready: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        late.push(handler());
      },
    };
    const result = await fetchRemoteData("https://example.com/x", {
      fetchImpl: fetching(taskDataZip),
      fileHandlers: registry,
      dataType: "isoxml",
    });
    assert.equal(result.kind, "handled");
  });

  it("does not wait for readiness when the built-in path needs no download", async () => {
    let waited = false;
    const registry: DataUrlFileHandlers = {
      ...source([handler()]),
      ready: async () => void (waited = true),
    };
    const result = await fetchRemoteData("https://example.com/dem.tif", {
      fetchImpl: fetching(new Uint8Array()),
      fileHandlers: registry,
    });
    assert.equal(result.kind, "cog");
    assert.equal(waited, false);
  });
});

describe("dataUrlFileHandlers gate", () => {
  const registry = source([handler()]);

  it("hands out the registry only where drops would be allowed", () => {
    assert.equal(dataUrlFileHandlers({ viewer: false, canAddData: true }, registry), registry);
  });

  it("withholds handlers in the read-only viewer", () => {
    assert.equal(dataUrlFileHandlers({ viewer: true, canAddData: true }, registry), undefined);
  });

  it("withholds handlers when the deployment does not grant data:add", () => {
    assert.equal(dataUrlFileHandlers({ viewer: false, canAddData: false }, registry), undefined);
  });
});

describe("createSettleGate", () => {
  it("resolves waiters when settled, and immediately afterwards", async () => {
    const gate = createSettleGate(10_000);
    let done = false;
    const waiting = gate.wait().then(() => void (done = true));
    await Promise.resolve();
    assert.equal(done, false);
    gate.settle();
    await waiting;
    assert.equal(done, true);
    await gate.wait();
  });

  it("with several parts, waits for every part (restore and ?plugin= deep link)", async () => {
    const gate = createSettleGate(10_000, ["restore", "deepLink"]);
    let done = false;
    const waiting = gate.wait().then(() => void (done = true));
    gate.settle("restore");
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(done, false);
    gate.settle("deepLink");
    await waiting;
    assert.equal(done, true);
  });

  it("never waits forever: it gives up after the timeout", async () => {
    const gate = createSettleGate(20);
    const started = Date.now();
    await gate.wait();
    assert.ok(Date.now() - started >= 15);
  });
});

describe("settle gate: one absolute deadline", () => {
  it("awaits the follow-up work, but never past the deadline", async () => {
    const hanging = createSettleGate(30, [""], () => new Promise(() => undefined));
    hanging.settle();
    const started = Date.now();
    await hanging.wait();
    assert.ok(Date.now() - started >= 25, "gave up before the deadline");
    const slow = createSettleGate(1000, [""], () => new Promise((r) => setTimeout(r, 40)));
    slow.settle();
    const slowStart = Date.now();
    await slow.wait();
    assert.ok(Date.now() - slowStart >= 35, "did not wait for the follow-up work");
    assert.ok(Date.now() - slowStart < 500);
  });

  it("stays open for good once the deadline passed: later waits return at once", async () => {
    const gate = createSettleGate(20);
    await gate.wait();
    const started = Date.now();
    await Promise.all([gate.wait(), gate.wait()]);
    assert.ok(Date.now() - started < 10, "a later wait started a new deadline");
  });
});

describe("startupActivationSettled", () => {
  it("needs the project URL settled and the restore to have run for the current project", () => {
    const settled = { projectUrlSettled: true, restoredGeneration: 1, projectGeneration: 1 };
    assert.equal(startupActivationSettled(settled), true);
    assert.equal(startupActivationSettled({ ...settled, projectUrlSettled: false }), false);
    // The restore of the empty generation-0 project is not the one after the ?url= project.
    assert.equal(startupActivationSettled({ ...settled, restoredGeneration: 0 }), false);
    assert.equal(startupActivationSettled({ ...settled, restoredGeneration: null }), false);
  });
});

describe("urlFileHandlers", () => {
  it("reads the viewer flag and data:add each time it is called", () => {
    const registry = source([handler()]);
    let viewer = false;
    let canAddData = true;
    const read = () =>
      urlFileHandlers({ isViewer: () => viewer, canAddData: () => canAddData, source: registry });
    assert.equal(read(), registry);
    viewer = true;
    assert.equal(read(), undefined);
    viewer = false;
    canAddData = false;
    assert.equal(read(), undefined);
    canAddData = true;
    assert.equal(read(), registry);
  });
});

function fakeStore(initial: string[]) {
  let ids = [...initial];
  return {
    add: (...added: string[]) => void ids.push(...added),
    layerIds: () => ids,
    removeLayer: (id: string) => void (ids = ids.filter((x) => x !== id)),
  };
}

describe("finishHandledLoad", () => {
  const named = (name: string) => handler({ name });

  it("returns the layers the handler added", () => {
    const store = fakeStore(["old", "a", "b"]);
    assert.deepEqual(
      finishHandledLoad({
        remote: { failed: [] },
        hasStyle: false,
        added: new Set(["a", "b"]),
        store,
      }),
      ["a", "b"],
    );
  });

  it("joins every failure under the handler names and removes what they added", () => {
    const store = fakeStore(["old", "partial", "user"]);
    assert.throws(
      () =>
        finishHandledLoad({
          remote: {
            failed: [
              { handler: named("One"), error: new Error("bad bytes") },
              { handler: named("Two"), error: "plain" },
            ],
          },
          hasStyle: false,
          added: new Set(["partial"]),
          store,
        }),
      /One: bad bytes Two: plain/,
    );
    assert.deepEqual(store.layerIds(), ["old", "user"]);
  });

  it("rejects a style for a file a plugin opened, and removes its layers", () => {
    const store = fakeStore(["x"]);
    assert.throws(
      () =>
        finishHandledLoad({
          remote: { failed: [] },
          hasStyle: true,
          added: new Set(["x"]),
          store,
        }),
      /style cannot be applied/,
    );
    assert.deepEqual(store.layerIds(), []);
  });

  it("removes the handler's layers, and only those, when the load was aborted", () => {
    const store = fakeStore(["old", "late", "user"]);
    const controller = new AbortController();
    controller.abort();
    assert.throws(
      () =>
        finishHandledLoad({
          remote: { failed: [] },
          hasStyle: false,
          added: new Set(["late"]),
          store,
          signal: controller.signal,
        }),
      { name: "AbortError" },
    );
    assert.deepEqual(store.layerIds(), ["old", "user"]);
  });
});

describe("trackHandlerLayers", () => {
  it("counts only layers added while the handler's open runs, not a user's during the download", async () => {
    const store = fakeStore(["old"]);
    const registry = source([
      handler({
        open: async () => {
          store.add("from-handler");
        },
      }),
    ]);
    const tracking = trackHandlerLayers(registry, store);
    store.add("user-during-download"); // the download is still running
    const [wrapped] = tracking.source.list();
    await wrapped!.open([]);
    store.add("user-after"); // after open returned
    assert.deepEqual([...tracking.added], ["from-handler"]);
  });

  it("keeps what a failing open added, so it can be removed", async () => {
    const store = fakeStore([]);
    const registry = source(
      [
        handler({
          open: () => {
            store.add("partial");
            throw new Error("nope");
          },
        }),
      ],
      { isoxml: "h" },
    );
    const tracking = trackHandlerLayers(registry, store);
    await assert.rejects(async () => tracking.source.forDataType("isoxml")!.open([]), /nope/);
    assert.deepEqual([...tracking.added], ["partial"]);
  });

  it("passes the handler's name through and leaves ready alone", () => {
    const ready = async () => undefined;
    const tracking = trackHandlerLayers(
      { ...source([handler({ name: "Named" })]), ready },
      fakeStore([]),
    );
    assert.equal(tracking.source.list()[0]!.name, "Named");
    assert.equal(tracking.source.ready, ready);
  });
});

describe("fetchStyleUnlessHandlerHint", () => {
  it("rejects a style combined with a hint a handler declares, without fetching it", async () => {
    let fetched = 0;
    await assert.rejects(
      fetchStyleUnlessHandlerHint({
        handlers: source([handler()], { isoxml: "h" }),
        dataType: "isoxml",
        fetchStyle: async () => ((fetched += 1), {}),
      }),
      /style cannot be applied/,
    );
    assert.equal(fetched, 0);
  });

  it("fetches the style for a hint nobody declares, for lidar, and for no hint", async () => {
    let asked: string[] = [];
    const registry: DataUrlFileHandlers = {
      list: () => [],
      forDataType: (name) => (asked.push(name), undefined),
    };
    for (const dataType of ["unknown-hint", "lidar", null, undefined]) {
      asked = [];
      const style = await fetchStyleUnlessHandlerHint({
        handlers: registry,
        dataType,
        fetchStyle: async () => "style",
      });
      assert.equal(style, "style");
      if (dataType === "lidar") assert.deepEqual(asked, []);
    }
    assert.equal(
      await fetchStyleUnlessHandlerHint({
        handlers: undefined,
        dataType: "isoxml",
        fetchStyle: async () => "style",
      }),
      "style",
    );
  });
});

describe("createLatch", () => {
  it("stays true once it has been true", () => {
    const latch = createLatch();
    assert.equal(latch(false), false);
    assert.equal(latch(true), true);
    assert.equal(latch(false), true);
  });
});

describe("deepLinkSettled", () => {
  const done = { linkResolved: true, pending: 0, awaiting: 0, activating: 0 };
  it("waits for registry plugins that still need a trust decision or are activating", () => {
    assert.equal(deepLinkSettled(done), true);
    assert.equal(deepLinkSettled({ ...done, linkResolved: false }), false);
    assert.equal(deepLinkSettled({ ...done, pending: 1 }), false);
    assert.equal(deepLinkSettled({ ...done, awaiting: 1 }), false);
    assert.equal(deepLinkSettled({ ...done, activating: 1 }), false);
  });
});

describe("the offer after the readiness wait", () => {
  it("stops if the load was aborted while waiting, without offering the file", async () => {
    const controller = new AbortController();
    let claimed = false;
    const registry: DataUrlFileHandlers = {
      ...source([handler({ claim: () => ((claimed = true), []) })]),
      ready: async () => controller.abort(),
    };
    await assert.rejects(
      fetchRemoteData("https://example.com/TASKDATA.zip", {
        fetchImpl: fetching(taskDataZip),
        fileHandlers: registry,
        signal: controller.signal,
      }),
      { name: "AbortError" },
    );
    assert.equal(claimed, false);
  });

  it("does the same on the hinted path, before downloading", async () => {
    const controller = new AbortController();
    let downloads = 0;
    const registry: DataUrlFileHandlers = {
      ...source([handler()], { isoxml: "h" }),
      ready: async () => controller.abort(),
    };
    await assert.rejects(
      fetchRemoteData("https://example.com/x", {
        fetchImpl: (async () => ((downloads += 1), new Response("x"))) as unknown as typeof fetch,
        fileHandlers: registry,
        dataType: "isoxml",
        signal: controller.signal,
      }),
      { name: "AbortError" },
    );
    assert.equal(downloads, 0);
  });
});

describe("a style with a plugin hint", () => {
  it("is rejected before anything is downloaded", async () => {
    let downloads = 0;
    let opened = false;
    await assert.rejects(
      fetchRemoteData("https://api.example.com/download/42", {
        fetchImpl: (async () => ((downloads += 1), new Response("x"))) as unknown as typeof fetch,
        fileHandlers: source([handler({ open: () => void (opened = true) })], { isoxml: "h" }),
        dataType: "isoxml",
        hasStyle: true,
      }),
      /style cannot be applied/,
    );
    assert.equal(downloads, 0);
    assert.equal(opened, false);
  });
});

describe("remoteFileName", () => {
  it("strips control characters and keeps the end of an over-long name", () => {
    const long = `${"a".repeat(300)}.zip`;
    const name = remoteFileName("https://x.example/d", `attachment; filename="${long}"`);
    assert.equal(name.length, 255);
    assert.ok(name.endsWith(".zip"));
    assert.equal(
      remoteFileName("https://x.example/d", 'attachment; filename="a\u0001b.zip"'),
      "ab.zip",
    );
    assert.equal(remoteFileName("https://x.example/a%01b.zip", null), "ab.zip");
  });

  it("reads an escaped quote inside a quoted filename", () => {
    assert.equal(
      remoteFileName("https://x.example/d", 'attachment; filename="we\\"ird.zip"'),
      'we"ird.zip',
    );
  });

  it("falls back to the URL path for an empty name", () => {
    assert.equal(
      remoteFileName("https://x.example/dl/export.zip", 'attachment; filename=""'),
      "export.zip",
    );
    assert.equal(remoteFileName("https://x.example/", null), "data");
  });
});

describe("trackHandlerLayers with a class-instance handler", () => {
  it("keeps prototype methods, bound to the handler", async () => {
    class ClassHandler implements GeoLibreFileHandler {
      id = "cls";
      name = "Class handler";
      extensions = [".zip"];
      dataTypes = ["isoxml"];
      opened = 0;
      claim(files: GeoLibreDroppedFileInfo[]) {
        // Reads `this`, so it only works when called on the handler itself.
        return this.extensions.length > 0 ? files : [];
      }
      open() {
        this.opened += 1;
      }
    }
    const instance = new ClassHandler();
    const registry: DataUrlFileHandlers = {
      list: () => [instance],
      forDataType: () => instance,
    };
    const tracking = trackHandlerLayers(registry, fakeStore([]));
    const [wrapped] = tracking.source.list();
    assert.equal(typeof wrapped!.claim, "function");
    assert.equal((await wrapped!.claim([{ name: "a.zip", size: 1 }])).length, 1);
    await wrapped!.open([]);
    await tracking.source.forDataType("isoxml")!.open([]);
    assert.equal(instance.opened, 2);
    assert.equal(wrapped!.name, "Class handler");
    assert.deepEqual(wrapped!.extensions, [".zip"]);
  });
});

describe("the readiness wait honours the abort", () => {
  const never = () => new Promise<void>(() => undefined);
  const settles = async (promise: Promise<unknown>) =>
    Promise.race([
      promise.then(
        () => "resolved",
        (error: Error) => error.name,
      ),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 300)),
    ]);

  it("ends an unhinted offer, a hinted one and the style check with AbortError", async () => {
    for (const hinted of [false, true]) {
      const controller = new AbortController();
      const registry: DataUrlFileHandlers = {
        ...source([handler()], { isoxml: "h" }),
        ready: never,
      };
      const pending = fetchRemoteData("https://example.com/TASKDATA.zip", {
        fetchImpl: fetching(taskDataZip),
        fileHandlers: registry,
        dataType: hinted ? "isoxml" : undefined,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 20);
      assert.equal(await settles(pending), "AbortError", hinted ? "hinted" : "unhinted");
    }
    const controller = new AbortController();
    const pending = fetchStyleUnlessHandlerHint({
      handlers: { ...source([handler()], { isoxml: "h" }), ready: never },
      dataType: "isoxml",
      fetchStyle: async () => "style",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    assert.equal(await settles(pending), "AbortError", "style");
  });
});

describe("awaitingEntryState", () => {
  it("settles a trusted entry once it loaded or reported a load issue", () => {
    assert.equal(awaitingEntryState({ loadedFromEntry: true, hasLoadIssue: false }), "ready");
    assert.equal(awaitingEntryState({ loadedFromEntry: false, hasLoadIssue: true }), "failed");
    // Another plugin already holds the id, yet this manifest failed: not stuck.
    assert.equal(awaitingEntryState({ loadedFromEntry: false, hasLoadIssue: true }), "failed");
    assert.equal(awaitingEntryState({ loadedFromEntry: false, hasLoadIssue: false }), "waiting");
  });
});

describe("queueDataLoad", () => {
  it("runs loads one after another, and a failure does not block the next", async () => {
    const order: string[] = [];
    const slow = queueDataLoad(async () => {
      order.push("a:start");
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push("a:end");
      throw new Error("a failed");
    });
    const next = queueDataLoad(async () => {
      order.push("b:start");
      return "b";
    });
    await assert.rejects(slow, /a failed/);
    assert.equal(await next, "b");
    assert.deepEqual(order, ["a:start", "a:end", "b:start"]);
  });
});
