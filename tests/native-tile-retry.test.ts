import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchTileWithRetry,
  isRetryableTileStatus,
  jitteredDelay,
  TILE_RETRY_DELAYS_MS,
  tileErrorStatus,
} from "../apps/geolibre-desktop/src/lib/tile-retry";

const FAILED_500 = "Request failed with status 500 Internal Server Error";
/** Puts the jitter factor at exactly 1. */
const NO_JITTER = () => 0.5;

/** A fetch that answers from a queue: strings reject (as `invoke` does), anything else resolves. */
function queuedFetch(outcomes: unknown[]) {
  let calls = 0;
  const fetchOnce = async () => {
    const outcome = outcomes[calls++];
    if (typeof outcome === "string") throw outcome;
    return outcome;
  };
  return { fetchOnce, calls: () => calls };
}

function recordingSleep() {
  const waits: number[] = [];
  return { sleep: async (ms: number) => void waits.push(ms), waits };
}

test("tileErrorStatus reads the status from a fetch_url_bytes error", () => {
  assert.equal(tileErrorStatus(FAILED_500), 500);
  assert.equal(tileErrorStatus(new Error("Request failed with status 429 Too Many Requests")), 429);
  assert.equal(tileErrorStatus("Could not reach example.com: connection refused"), null);
  assert.equal(tileErrorStatus(undefined), null);
});

test("isRetryableTileStatus accepts 5xx and 429 only", () => {
  for (const status of [500, 502, 503, 504, 429]) assert.equal(isRetryableTileStatus(status), true);
  for (const status of [400, 403, 404, 410, 200])
    assert.equal(isRetryableTileStatus(status), false);
});

test("a tile that fails with 500 and then succeeds is returned", async () => {
  const { fetchOnce, calls } = queuedFetch([FAILED_500, { data: "tile" }]);
  const { sleep, waits } = recordingSleep();

  assert.deepEqual(await fetchTileWithRetry(fetchOnce, { sleep, random: NO_JITTER }), {
    data: "tile",
  });
  assert.equal(calls(), 2);
  assert.deepEqual(waits, [TILE_RETRY_DELAYS_MS[0]]);
});

test("a tile that keeps failing with 5xx rejects with the last error after every retry", async () => {
  const last = "Request failed with status 503 Service Unavailable";
  const { fetchOnce, calls } = queuedFetch([FAILED_500, FAILED_500, last]);
  const { sleep, waits } = recordingSleep();

  await assert.rejects(
    fetchTileWithRetry(fetchOnce, { sleep, random: NO_JITTER }),
    (error) => error === last,
  );
  assert.equal(calls(), TILE_RETRY_DELAYS_MS.length + 1);
  assert.deepEqual(waits, [...TILE_RETRY_DELAYS_MS]);
});

test("404 and network errors are not retried", async () => {
  for (const error of [
    "Request failed with status 404 Not Found",
    "Could not reach example.com: connection refused",
  ]) {
    const { fetchOnce, calls } = queuedFetch([error, { data: "tile" }]);
    const { sleep, waits } = recordingSleep();

    await assert.rejects(
      fetchTileWithRetry(fetchOnce, { sleep, random: NO_JITTER }),
      (thrown) => thrown === error,
    );
    assert.equal(calls(), 1);
    assert.deepEqual(waits, []);
  }
});

test("an aborted tile request is not retried", async () => {
  const controller = new AbortController();
  const { fetchOnce, calls } = queuedFetch([FAILED_500, { data: "tile" }]);
  const sleep = async () => controller.abort();

  await assert.rejects(
    fetchTileWithRetry(fetchOnce, { signal: controller.signal, sleep }),
    (error) => error === FAILED_500,
  );
  assert.equal(calls(), 1);
});

test("the default wait ends as soon as the tile request is aborted", async () => {
  const controller = new AbortController();
  const { fetchOnce, calls } = queuedFetch([FAILED_500, { data: "tile" }]);
  setTimeout(() => controller.abort(), 20);
  const started = Date.now();

  await assert.rejects(
    fetchTileWithRetry(fetchOnce, { signal: controller.signal, delaysMs: [10_000] }),
    (error) => error === FAILED_500,
  );
  assert.ok(Date.now() - started < 1_000);
  assert.equal(calls(), 1);
});

test("jitteredDelay spreads a delay over plus or minus 25 percent", () => {
  assert.equal(
    jitteredDelay(1000, () => 0),
    750,
  );
  assert.equal(
    jitteredDelay(1000, () => 0.5),
    1000,
  );
  assert.equal(
    jitteredDelay(1000, () => 0.999999),
    1250,
  );
  for (let i = 0; i < 100; i++) {
    const delay = jitteredDelay(TILE_RETRY_DELAYS_MS[1]);
    assert.ok(delay >= 562 && delay <= 938, `${delay}`);
  }
});
