import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resetBearingState } from "../packages/map/src/reset-bearing-control";

describe("resetBearingState", () => {
  it("treats an exactly north-up, flat view as nothing to reset", () => {
    const state = resetBearingState(0, 0);
    assert.equal(state.isNorthUp, true);
    assert.equal(state.needleRotation, 0);
  });

  it("tolerates sub-degree drift so an animated reset settles to inactive", () => {
    assert.equal(resetBearingState(0.2, 0.1).isNorthUp, true);
    assert.equal(resetBearingState(-0.3, 0).isNorthUp, true);
  });

  it("is active once the map is rotated past the threshold", () => {
    assert.equal(resetBearingState(45, 0).isNorthUp, false);
    assert.equal(resetBearingState(-90, 0).isNorthUp, false);
  });

  it("is active when the map is tilted even if bearing is north", () => {
    assert.equal(resetBearingState(0, 60).isNorthUp, false);
  });

  it("counter-rotates the needle so its north tip tracks true north", () => {
    assert.equal(resetBearingState(90, 0).needleRotation, -90);
    assert.equal(resetBearingState(-30, 0).needleRotation, 30);
  });
});
