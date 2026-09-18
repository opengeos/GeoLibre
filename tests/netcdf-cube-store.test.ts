import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  bandChoicesFor,
  closeNetcdfCube,
  closeNetcdfCubeForLayer,
  getNetcdfCubeState,
  normalizeCubeSettings,
  openNetcdfCubeSetup,
  reopenNetcdfCubeSetup,
  resumeNetcdfCube,
  startNetcdfCube,
  subscribeNetcdfCube,
  type NetcdfCubeSettings,
} from "../apps/geolibre-desktop/src/lib/netcdf-cube-store";
import { MAX_CUBE_BANDS } from "../apps/geolibre-desktop/src/lib/netcdf-cube";

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

  it("clears the read token when the dialog opens on a different layer", () => {
    openNetcdfCubeSetup("layer-1");
    startNetcdfCube(settings({ extent: "draw", bbox: [10, 10, 11, 11] }));
    assert.ok(getNetcdfCubeState().readToken > 0);

    openNetcdfCubeSetup("layer-2");
    // The window reads whenever the token changes. Carrying layer 1's token
    // over would start an expensive read on layer 2 the moment the dialog
    // opened, using an extent chosen for a different scene, before the user had
    // seen the dialog at all.
    assert.equal(getNetcdfCubeState().readToken, 0);
    assert.equal(getNetcdfCubeState().phase, "setup");
  });

  it("keeps the read token when the dialog reopens on the same layer", () => {
    openNetcdfCubeSetup("layer-1");
    startNetcdfCube(settings());
    const token = getNetcdfCubeState().readToken;
    // Reaching the dialog again from the Style panel rather than the window's
    // own Settings button must still not throw the cube away.
    openNetcdfCubeSetup("layer-1");
    assert.equal(getNetcdfCubeState().readToken, token);
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

  it("carries the bbox only while the layer stays the same", () => {
    openNetcdfCubeSetup("layer-1");
    startNetcdfCube(settings({ extent: "draw", bbox: [10, 10, 11, 11] }));
    openNetcdfCubeSetup("layer-1");
    // Same layer: the rectangle still means what it did, so keep it.
    assert.deepEqual(getNetcdfCubeState().settings.bbox, [10, 10, 11, 11]);
  });

  it("ignores a start with nothing open", () => {
    // Establish the phase here rather than relying on whatever the previous
    // test left behind: `closeNetcdfCube` returns early when nothing is open,
    // so `beforeEach` alone does not reset it.
    openNetcdfCubeSetup("layer-1");
    startNetcdfCube(settings());
    closeNetcdfCube();

    startNetcdfCube(settings());
    assert.equal(getNetcdfCubeState().layerId, null);
    assert.equal(getNetcdfCubeState().phase, "setup");
  });
});

describe("normalizeCubeSettings", () => {
  const carried = (overrides: Partial<NetcdfCubeSettings> = {}): NetcdfCubeSettings => ({
    extent: "draw",
    bbox: [10, 10, 11, 11],
    maxSize: 192,
    maxBands: 64,
    rgbBands: [200, 150, 100],
    ...overrides,
  });

  it("drops a drawn extent that belongs to another layer", () => {
    const next = normalizeCubeSettings(carried(), 285, false, [3, 2, 1]);
    // A bbox is geography. Pointed at a different scene it clamps into a corner
    // of the new grid, which reads as a slow, near-empty cube and nothing else.
    assert.equal(next.extent, "view");
    assert.equal(next.bbox, null);
  });

  it("keeps a drawn extent on the same layer", () => {
    const next = normalizeCubeSettings(carried(), 285, true, [3, 2, 1]);
    assert.equal(next.extent, "draw");
    assert.deepEqual(next.bbox, [10, 10, 11, 11]);
  });

  it("leaves a non-drawn extent alone either way", () => {
    for (const keep of [true, false]) {
      const next = normalizeCubeSettings(carried({ extent: "full" }), 285, keep, [0, 0, 0]);
      assert.equal(next.extent, "full");
    }
  });

  it("replaces band indices that do not exist on the new axis", () => {
    // Clamping them instead (which the reader would do) makes all three
    // channels the last band, so the "color" image comes out grey.
    const next = normalizeCubeSettings(carried(), 40, false, [30, 20, 10]);
    assert.deepEqual(next.rgbBands, [30, 20, 10]);
  });

  it("keeps band indices that still fit", () => {
    const next = normalizeCubeSettings(carried({ rgbBands: [5, 4, 3] }), 40, false, [30, 20, 10]);
    assert.deepEqual(next.rgbBands, [5, 4, 3]);
  });

  it("leaves the overlay off when it was off", () => {
    const next = normalizeCubeSettings(carried({ rgbBands: null }), 40, false, [1, 2, 3]);
    assert.equal(next.rgbBands, null);
  });

  it("snaps the band count onto an offered choice", () => {
    // 64 is not offered for a 40-band axis, and a value with no matching option
    // leaves the dropdown blank while the read uses something else.
    assert.deepEqual(bandChoicesFor(40), [16, 32, 40]);
    // "All" never offers more than the reader will actually read.
    assert.deepEqual(bandChoicesFor(5000).at(-1), MAX_CUBE_BANDS);
    assert.equal(
      normalizeCubeSettings(carried({ maxBands: 64 }), 40, false, [1, 2, 3]).maxBands,
      40,
    );
    // 40 carried onto a 100-band axis is likewise not an option; 32 is nearest.
    assert.equal(
      normalizeCubeSettings(carried({ maxBands: 40 }), 100, false, [1, 2, 3]).maxBands,
      32,
    );
  });

  it("leaves a band count that is already offered", () => {
    assert.equal(
      normalizeCubeSettings(carried({ maxBands: 64 }), 285, false, [1, 2, 3]).maxBands,
      64,
    );
  });
});
