import assert from "node:assert/strict";
import { test } from "node:test";
import { captureEngineImage } from "../packages/map/src/map-capture";
import type { MapEngine } from "../packages/map/src/map-engine";

test("capture reports a failed visible layer instead of exporting partial pixels", async () => {
  const engine = {
    getRenderStatus: () => ({ pending: [], errors: ["Buildings: failed to load"] }),
  };
  await assert.rejects(captureEngineImage(engine as unknown as MapEngine), /Buildings: failed/);
});

test("destroying the engine while capture waits rejects and stops polling", async () => {
  let polls = 0;
  const engine = {
    getRenderStatus: () =>
      ++polls === 1
        ? { pending: ["Tiles"], errors: [] }
        : { pending: [], errors: ["The globe is not available"] },
  };
  await assert.rejects(captureEngineImage(engine as unknown as MapEngine), /not available/);
  assert.equal(polls, 2);
});
