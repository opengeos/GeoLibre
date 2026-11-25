import assert from "node:assert/strict";
import { it, mock } from "node:test";
import { sessionCreationRateStatus } from "../workers/collab/src/session-rate-limit";

it("uses the caller key and allows a successful platform decision", async () => {
  const keys: string[] = [];
  const limiter: RateLimit = {
    async limit({ key }) {
      keys.push(key);
      return { success: true };
    },
  };
  assert.equal(await sessionCreationRateStatus(limiter, "198.51.100.1"), null);
  assert.deepEqual(keys, ["198.51.100.1"]);
});

it("honors a denied platform decision on every request", async () => {
  let calls = 0;
  const limiter: RateLimit = {
    async limit() {
      calls += 1;
      return { success: false };
    },
  };
  assert.equal(await sessionCreationRateStatus(limiter, "198.51.100.1"), 429);
  assert.equal(await sessionCreationRateStatus(limiter, "198.51.100.1"), 429);
  assert.equal(calls, 2);
});

it("does not create an isolate-local allowance when the binding is missing", async () => {
  const warning = mock.method(console, "warn", () => {});
  try {
    assert.equal(await sessionCreationRateStatus(undefined, "198.51.100.1"), 503);
    assert.deepEqual(JSON.parse(warning.mock.calls[0].arguments[0]), {
      event: "collab_rate_limit_unavailable",
      reason: "binding_missing",
    });
  } finally {
    warning.mock.restore();
  }
});

it("fails closed during a platform outage and recovers on a later successful call", async () => {
  const warning = mock.method(console, "warn", () => {});
  let failed = true;
  const limiter: RateLimit = {
    async limit() {
      if (failed) throw new Error("platform unavailable");
      return { success: true };
    },
  };
  try {
    assert.equal(await sessionCreationRateStatus(limiter, "198.51.100.1"), 503);
    failed = false;
    assert.equal(await sessionCreationRateStatus(limiter, "198.51.100.1"), null);
    assert.equal(warning.mock.callCount(), 1);
  } finally {
    warning.mock.restore();
  }
});
