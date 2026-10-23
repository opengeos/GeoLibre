import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRequestLimiter } from "../apps/geolibre-desktop/src/lib/request-limiter";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createRequestLimiter", () => {
  it("runs at most `limit` tasks at once, in arrival order", async () => {
    const run = createRequestLimiter(2);
    const gates = [deferred(), deferred(), deferred()];
    const started: number[] = [];
    const results = gates.map((gate, index) =>
      run(async () => {
        started.push(index);
        await gate.promise;
        return index;
      }),
    );
    await tick();
    assert.deepEqual(started, [0, 1]);
    gates[0].resolve();
    await tick();
    assert.deepEqual(started, [0, 1, 2]);
    gates[1].resolve();
    gates[2].resolve();
    assert.deepEqual(await Promise.all(results), [0, 1, 2]);
  });

  it("drops a queued task whose signal aborts without starting it", async () => {
    const run = createRequestLimiter(1);
    const gate = deferred();
    const first = run(() => gate.promise);
    const controller = new AbortController();
    let started = false;
    const queued = run(async () => {
      started = true;
    }, controller.signal);
    controller.abort();
    await assert.rejects(queued, { name: "AbortError" });
    gate.resolve();
    await first;
    // The aborted task freed its place: the next one starts at once.
    assert.equal(await run(async () => "next"), "next");
    assert.equal(started, false);
  });

  it("rejects an already-aborted request immediately", async () => {
    const run = createRequestLimiter(1);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      run(async () => "never", controller.signal),
      { name: "AbortError" },
    );
  });

  it("frees the slot when a task throws", async () => {
    const run = createRequestLimiter(1);
    await assert.rejects(
      run(async () => Promise.reject(new Error("boom"))),
      /boom/,
    );
    assert.equal(await run(async () => 1), 1);
  });
});
