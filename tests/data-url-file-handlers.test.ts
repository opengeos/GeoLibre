import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { strToU8, zipSync } from "fflate";
import type { GeoLibreDroppedFile, GeoLibreFileHandler } from "../packages/plugins/src/types";
import { fetchRemoteData } from "../apps/geolibre-desktop/src/lib/data-url";
import {
  type DataUrlFileHandlers,
  dataUrlFileHandlers,
} from "../apps/geolibre-desktop/src/lib/data-url-file-handlers";
import { createSettleGate } from "../apps/geolibre-desktop/src/lib/settle-gate";

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

  it("never waits forever: it gives up after the timeout", async () => {
    const gate = createSettleGate(20);
    const started = Date.now();
    await gate.wait();
    assert.ok(Date.now() - started >= 15);
  });
});
