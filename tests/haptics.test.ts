import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { triggerHaptic } from "../apps/geolibre-desktop/src/lib/haptics";

describe("triggerHaptic", () => {
  it("vibrates with style-specific durations when supported", () => {
    const calls: Array<number | number[]> = [];
    const nav = {
      vibrate(pattern: number | number[]) {
        calls.push(pattern);
        return true;
      },
    };
    const mm = () => ({ matches: false });

    assert.equal(triggerHaptic("selection", { navigator: nav, matchMedia: mm }), true);
    assert.equal(triggerHaptic("light", { navigator: nav, matchMedia: mm }), true);
    assert.equal(triggerHaptic("medium", { navigator: nav, matchMedia: mm }), true);
    assert.deepEqual(calls, [6, 10, 20]);
  });

  it("stays silent when reduced motion is preferred or vibrate is missing", () => {
    const calls: Array<number | number[]> = [];
    assert.equal(
      triggerHaptic("medium", {
        navigator: {
          vibrate(p) {
            calls.push(p);
            return true;
          },
        },
        matchMedia: () => ({ matches: true }),
      }),
      false,
    );
    assert.equal(calls.length, 0);
    assert.equal(
      triggerHaptic("light", { navigator: {}, matchMedia: () => ({ matches: false }) }),
      false,
    );
  });
});
