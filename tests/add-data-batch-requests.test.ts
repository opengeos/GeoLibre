import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { settleNamedRequests } from "../apps/geolibre-desktop/src/components/layout/add-data/batch-requests.ts";

describe("settleNamedRequests", () => {
  it("keeps successful results when a sibling request fails", async () => {
    const failure = new Error("service unavailable");
    const result = await settleNamedRequests([
      { key: "cities", run: async () => 12 },
      { key: "roads", run: async () => Promise.reject(failure) },
      { key: "lakes", run: async () => 7 },
    ]);

    assert.deepEqual(result.successes, [
      { key: "cities", value: 12 },
      { key: "lakes", value: 7 },
    ]);
    assert.deepEqual(result.failures, [{ key: "roads", reason: failure }]);
  });

  it("retains picker order even when requests settle out of order", async () => {
    let finishFirst!: (value: string) => void;
    const first = new Promise<string>((resolve) => {
      finishFirst = resolve;
    });
    const pending = settleNamedRequests([
      { key: "first", run: () => first },
      { key: "second", run: async () => "second result" },
    ]);

    finishFirst("first result");

    assert.deepEqual((await pending).successes, [
      { key: "first", value: "first result" },
      { key: "second", value: "second result" },
    ]);
  });
});
