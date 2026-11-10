import assert from "node:assert/strict";
import test from "node:test";
import { createKeyedDebounce } from "../apps/geolibre-desktop/src/lib/keyed-debounce";

test("a newer action under the same key replaces the waiting one", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const debounce = createKeyedDebounce(250);
  const ran: string[] = [];
  debounce.schedule("a", () => ran.push("first"));
  t.mock.timers.tick(100);
  debounce.schedule("a", () => ran.push("second"));
  t.mock.timers.tick(250);
  assert.deepEqual(ran, ["second"]);
});

test("scheduling under another key does not cancel the waiting action", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const debounce = createKeyedDebounce(250);
  const ran: string[] = [];
  debounce.schedule("layer-a", () => ran.push("a"));
  t.mock.timers.tick(100);
  debounce.schedule("layer-b", () => ran.push("b"));
  t.mock.timers.tick(250);
  assert.deepEqual(ran.sort(), ["a", "b"]);
});

test("pending is true only while an action waits under that key", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const debounce = createKeyedDebounce(250);
  debounce.schedule("a", () => {});
  assert.equal(debounce.pending("a"), true);
  assert.equal(debounce.pending("b"), false);
  t.mock.timers.tick(250);
  assert.equal(debounce.pending("a"), false);
});
