import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { probeProjectHistoryStorage } from "../apps/geolibre-desktop/src/lib/project-history-store";

const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");

function setIndexedDb(value: unknown): void {
  Object.defineProperty(globalThis, "indexedDB", { value, configurable: true, writable: true });
}

/** A fake `indexedDB.open` request that fires one handler on the next tick. */
function fakeOpen(outcome: "success" | "error" | "blocked") {
  let closed = 0;
  const factory = {
    open() {
      const request: Record<string, unknown> = {
        result: { close: () => (closed += 1), objectStoreNames: { contains: () => true } },
        error: new Error("open failed"),
      };
      setTimeout(() => {
        const handler = { success: "onsuccess", error: "onerror", blocked: "onblocked" }[outcome];
        (request[handler] as (() => void) | undefined)?.();
      }, 0);
      return request;
    },
  };
  return { factory, closed: () => closed };
}

describe("probeProjectHistoryStorage", () => {
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, "indexedDB", original);
    else delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  it("reports unavailable when IndexedDB is missing", async () => {
    setIndexedDb(undefined);
    assert.equal(await probeProjectHistoryStorage(), false);
  });

  it("reports unavailable when opening throws, as in a private window", async () => {
    setIndexedDb({
      open() {
        throw new Error("The operation is insecure.");
      },
    });
    assert.equal(await probeProjectHistoryStorage(), false);
  });

  it("reports unavailable when the open request errors", async () => {
    setIndexedDb(fakeOpen("error").factory);
    assert.equal(await probeProjectHistoryStorage(), false);
  });

  it("reports available, and closes the database, when it opens", async () => {
    const fake = fakeOpen("success");
    setIndexedDb(fake.factory);
    assert.equal(await probeProjectHistoryStorage(), true);
    assert.equal(fake.closed(), 1);
  });

  it("treats a database blocked by another tab as available", async () => {
    setIndexedDb(fakeOpen("blocked").factory);
    assert.equal(await probeProjectHistoryStorage(), true);
  });
});
