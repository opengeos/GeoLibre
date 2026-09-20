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

  it("runs no more than four service requests concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    const releases: (() => void)[] = [];
    const requests = Array.from({ length: 9 }, (_, index) => ({
      key: String(index),
      run: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return index;
      },
    }));

    const pending = settleNamedRequests(requests);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(maxActive, 4);

    while (releases.length > 0) {
      releases.splice(0).forEach((release) => release());
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal((await pending).successes.length, 9);
  });
});
