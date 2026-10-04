import assert from "node:assert/strict";
import { test } from "node:test";
import { createOperationTokens } from "../apps/geolibre-desktop/src/lib/operation-tokens.ts";

test("the latest operation is current and earlier ones are not", () => {
  const ops = createOperationTokens();
  const first = ops.begin();
  assert.equal(ops.isCurrent(first), true);
  const second = ops.begin();
  assert.equal(ops.isCurrent(first), false);
  assert.equal(ops.isCurrent(second), true);
});

test("invalidate orphans the in-flight operation without starting one", () => {
  const ops = createOperationTokens();
  const token = ops.begin();
  ops.invalidate();
  assert.equal(ops.isCurrent(token), false);
  const next = ops.begin();
  assert.equal(ops.isCurrent(next), true);
});

test("separate counters do not interfere", () => {
  const a = createOperationTokens();
  const b = createOperationTokens();
  const tokenA = a.begin();
  b.begin();
  b.invalidate();
  assert.equal(a.isCurrent(tokenA), true);
});

test("a language switch mid-download drops the stale result", async () => {
  // Mirrors useLanguagePack: the handler begins, awaits, and a language change
  // invalidates before it settles, so the stale result is never applied.
  const ops = createOperationTokens();
  let installed = "de";
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const download = (async () => {
    const token = ops.begin();
    await pending;
    if (ops.isCurrent(token)) installed = "fr";
  })();
  ops.invalidate(); // the user picked another language
  release();
  await download;
  assert.equal(installed, "de");
});
