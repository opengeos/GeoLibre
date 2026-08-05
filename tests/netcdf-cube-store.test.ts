import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  closeNetcdfCube,
  closeNetcdfCubeForLayer,
  getNetcdfCubeState,
  openNetcdfCubeSetup,
  reopenNetcdfCubeSetup,
  resumeNetcdfCube,
  startNetcdfCube,
  subscribeNetcdfCube,
  type NetcdfCubeSettings,
} from "../apps/geolibre-desktop/src/lib/netcdf-cube-store";

/** Settings differing from the defaults, so a carry-over is visible. */
function settings(overrides: Partial<NetcdfCubeSettings> = {}): NetcdfCubeSettings {
  return {
    extent: "draw",
    bbox: [-1, -1, 1, 1],
    maxSize: 96,
    maxBands: 32,
    rgbBands: [3, 2, 1],
    ...overrides,
  };
}

describe("netcdf cube store", () => {
  beforeEach(() => closeNetcdfCube());

  it("opens into setup without asking for a read", () => {
    const before = getNetcdfCubeState().readToken;
    openNetcdfCubeSetup("layer-1");
    const state = getNetcdfCubeState();
    assert.equal(state.layerId, "layer-1");
    assert.equal(state.phase, "setup");
    // The whole point of the dialog: opening it must not start a read.
    assert.equal(state.readToken, before);
    assert.equal(state.started, false);
  });

  it("bumps the read token only when a cube is asked for", () => {
    openNetcdfCubeSetup("layer-1");
    const before = getNetcdfCubeState().readToken;
    startNetcdfCube(settings());
    const started = getNetcdfCubeState();
    assert.equal(started.phase, "cube");
    assert.equal(started.readToken, before + 1);
    assert.equal(started.started, true);

    // Reopening and going back must not re-read: the cube is already in memory,
    // and rebuilding it is tens of seconds.
    reopenNetcdfCubeSetup();
    assert.equal(getNetcdfCubeState().readToken, before + 1);
    resumeNetcdfCube();
    const resumed = getNetcdfCubeState();
    assert.equal(resumed.phase, "cube");
    assert.equal(resumed.readToken, before + 1);
  });

  it("re-reads when the settings are accepted again", () => {
    openNetcdfCubeSetup("layer-1");
    startNetcdfCube(settings());
    const first = getNetcdfCubeState().readToken;
    reopenNetcdfCubeSetup();
    startNetcdfCube(settings({ maxBands: 128 }));
    assert.equal(getNetcdfCubeState().readToken, first + 1);
    assert.equal(getNetcdfCubeState().settings.maxBands, 128);
  });

  it("carries the settings from one cube to the next", () => {
    openNetcdfCubeSetup("layer-1");
    startNetcdfCube(settings({ maxBands: 16 }));
    closeNetcdfCube();
    openNetcdfCubeSetup("layer-2");
    // The common loop is read, move the map, read again; re-picking every
    // setting each time would be the whole cost of the dialog with none of its
    // benefit.
    assert.equal(getNetcdfCubeState().settings.maxBands, 16);
    assert.deepEqual(getNetcdfCubeState().settings.rgbBands, [3, 2, 1]);
  });

  it("has nothing to resume to on a different layer", () => {
    openNetcdfCubeSetup("layer-1");
    startNetcdfCube(settings());
    openNetcdfCubeSetup("layer-2");
    // Layer 2 has no cube yet, so cancelling must close rather than show layer
    // 1's cube under layer 2's name.
    assert.equal(getNetcdfCubeState().started, false);
    resumeNetcdfCube();
    assert.equal(getNetcdfCubeState().layerId, null);
  });

  it("keeps `started` when the dialog is reopened on the same layer", () => {
    openNetcdfCubeSetup("layer-1");
    startNetcdfCube(settings());
    openNetcdfCubeSetup("layer-1");
    assert.equal(getNetcdfCubeState().started, true);
  });

  it("closes only for the layer being removed", () => {
    openNetcdfCubeSetup("layer-1");
    startNetcdfCube(settings());
    closeNetcdfCubeForLayer("layer-2");
    assert.equal(getNetcdfCubeState().layerId, "layer-1");
    closeNetcdfCubeForLayer("layer-1");
    assert.equal(getNetcdfCubeState().layerId, null);
  });

  it("notifies subscribers on every transition", () => {
    let calls = 0;
    const unsubscribe = subscribeNetcdfCube(() => {
      calls += 1;
    });
    openNetcdfCubeSetup("layer-1");
    startNetcdfCube(settings());
    reopenNetcdfCubeSetup();
    resumeNetcdfCube();
    closeNetcdfCube();
    assert.equal(calls, 5);
    unsubscribe();
    openNetcdfCubeSetup("layer-1");
    assert.equal(calls, 5);
  });

  it("ignores a start with nothing open", () => {
    startNetcdfCube(settings());
    assert.equal(getNetcdfCubeState().layerId, null);
    assert.equal(getNetcdfCubeState().phase, "setup");
  });
});
