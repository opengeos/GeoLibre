import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clampSecondsPerYear,
  DEFAULT_SECONDS_PER_YEAR,
  frameIndexForYear,
  nextFrameIndex,
  normalizeTimelapseProjectState,
  TIMELAPSE_SPEED_STEPS,
} from "../packages/plugins/src/plugins/timelapse-engine";
import { eoxS2CloudlessProvider } from "../packages/plugins/src/plugins/timelapse-providers";

const frames = eoxS2CloudlessProvider.listFrames();
if (!Array.isArray(frames)) throw new Error("EOX provider must be sync");

describe("nextFrameIndex", () => {
  it("advances through the frames in order", () => {
    assert.equal(nextFrameIndex(0, 10, false), 1);
    assert.equal(nextFrameIndex(4, 10, true), 5);
  });

  it("wraps to the start when looping", () => {
    assert.equal(nextFrameIndex(9, 10, true), 0);
  });

  it("stops at the end without looping", () => {
    assert.equal(nextFrameIndex(9, 10, false), null);
  });

  it("never steps a single-frame or empty set", () => {
    assert.equal(nextFrameIndex(0, 1, true), null);
    assert.equal(nextFrameIndex(0, 0, true), null);
  });
});

describe("clampSecondsPerYear", () => {
  it("keeps allowed steps as-is", () => {
    for (const step of TIMELAPSE_SPEED_STEPS) {
      assert.equal(clampSecondsPerYear(step), step);
    }
  });

  it("snaps arbitrary values to the nearest step", () => {
    assert.equal(clampSecondsPerYear(0.1), 0.25);
    assert.equal(clampSecondsPerYear(0.8), 1);
    assert.equal(clampSecondsPerYear(2.4), 2);
    assert.equal(clampSecondsPerYear(100), 3);
  });

  it("defaults non-numeric input", () => {
    assert.equal(clampSecondsPerYear("fast"), DEFAULT_SECONDS_PER_YEAR);
    assert.equal(clampSecondsPerYear(Number.NaN), DEFAULT_SECONDS_PER_YEAR);
    assert.equal(clampSecondsPerYear(-1), DEFAULT_SECONDS_PER_YEAR);
    assert.equal(clampSecondsPerYear(undefined), DEFAULT_SECONDS_PER_YEAR);
  });
});

describe("frameIndexForYear", () => {
  it("finds the matching frame", () => {
    assert.equal(frameIndexForYear(frames, 2018), 0);
    assert.equal(frameIndexForYear(frames, 2020), 2);
    assert.equal(frameIndexForYear(frames, 2025), 7);
  });

  it("clamps out-of-range years to the nearest end", () => {
    assert.equal(frameIndexForYear(frames, 2050), 7);
    assert.equal(frameIndexForYear(frames, 1999), 0);
  });

  it("defaults non-numeric years to the first frame", () => {
    assert.equal(frameIndexForYear(frames, "2020"), 0);
    assert.equal(frameIndexForYear(frames, undefined), 0);
  });
});

describe("normalizeTimelapseProjectState", () => {
  it("rejects non-object state", () => {
    assert.equal(normalizeTimelapseProjectState(null, frames), null);
    assert.equal(normalizeTimelapseProjectState("state", frames), null);
    assert.equal(normalizeTimelapseProjectState(42, frames), null);
  });

  it("fills defaults for an empty object", () => {
    const state = normalizeTimelapseProjectState({}, frames);
    assert.deepEqual(state, {
      providerId: "eox-s2cloudless",
      year: 2018,
      secondsPerYear: DEFAULT_SECONDS_PER_YEAR,
      loop: true,
    });
  });

  it("clamps an out-of-range year into the provider range", () => {
    const state = normalizeTimelapseProjectState({ year: 2099 }, frames);
    assert.equal(state?.year, 2025);
  });

  it("snaps the speed and never keeps a playing flag", () => {
    const state = normalizeTimelapseProjectState({ secondsPerYear: 0.4, playing: true }, frames);
    assert.equal(state?.secondsPerYear, 0.5);
    assert.ok(state && !("playing" in state));
  });

  it("keeps the persisted year verbatim when no frames are available", () => {
    // An async provider's catalog is unresolved at project-restore time; the
    // year must survive so activation can clamp it against the real frames.
    const state = normalizeTimelapseProjectState({ year: 2021 }, []);
    assert.equal(state?.year, 2021);
    const invalid = normalizeTimelapseProjectState({ year: "2021" }, []);
    assert.equal(invalid?.year, 0);
  });

  it("round-trips a valid state through JSON", () => {
    const original = {
      providerId: "eox-s2cloudless",
      year: 2021,
      secondsPerYear: 2,
      loop: false,
    };
    const state = normalizeTimelapseProjectState(JSON.parse(JSON.stringify(original)), frames);
    assert.deepEqual(state, original);
  });
});
