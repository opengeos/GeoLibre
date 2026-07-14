import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Map as MapLibreMap } from "maplibre-gl";
import {
  acquireMercatorProjectionLock,
  ensureMercatorProjection,
  releaseMercatorProjectionLock,
} from "../packages/plugins/src/plugins/map-projection-utils";

type ProjectionType = "globe" | "mercator";

function fakeProjectionMap(initialProjection: ProjectionType) {
  let projection = initialProjection;
  const idleHandlers: Array<() => void> = [];
  const setProjectionCalls: ProjectionType[] = [];

  const map = {
    getProjection: () => ({ type: projection }),
    once: (event: string, handler: () => void) => {
      if (event === "idle") idleHandlers.push(handler);
      return map;
    },
    setProjection: (next: { type: ProjectionType }) => {
      projection = next.type;
      setProjectionCalls.push(next.type);
      return map;
    },
  };

  return {
    emitIdle: () => {
      for (const handler of idleHandlers.splice(0)) handler();
    },
    flipToGlobe: () => {
      projection = "globe";
    },
    get projection() {
      return projection;
    },
    idleHandlers,
    map: map as unknown as MapLibreMap,
    setProjectionCalls,
  };
}

describe("ensureMercatorProjection", () => {
  it("is a no-op for nullish map values", () => {
    assert.doesNotThrow(() => ensureMercatorProjection(undefined));
    assert.doesNotThrow(() => ensureMercatorProjection(null));
  });

  it("restores mercator on idle if the map is flipped back to globe", () => {
    const fake = fakeProjectionMap("globe");

    ensureMercatorProjection(fake.map);
    assert.equal(fake.projection, "mercator");
    assert.equal(fake.idleHandlers.length, 1);

    fake.flipToGlobe();
    fake.emitIdle();

    assert.equal(fake.projection, "mercator");
    assert.deepEqual(fake.setProjectionCalls, ["mercator", "mercator"]);
  });

  it("registers only one pending idle guard per map", () => {
    const fake = fakeProjectionMap("globe");

    ensureMercatorProjection(fake.map);
    ensureMercatorProjection(fake.map);

    assert.equal(fake.idleHandlers.length, 1);
  });

  it("does not call setProjection when already mercator", () => {
    const fake = fakeProjectionMap("mercator");

    ensureMercatorProjection(fake.map);

    assert.deepEqual(fake.setProjectionCalls, []);
    assert.equal(fake.idleHandlers.length, 1);

    fake.emitIdle();

    assert.deepEqual(fake.setProjectionCalls, []);
  });
});

// A minimal app surface for the shared mercator lock. `getMap` returns null so
// the internal ensureMercatorProjection() call is a no-op and the test stays
// focused on the capture/restore bookkeeping. Each test fully releases what it
// acquires so the module-level lock state resets between cases.
function fakeProjectionApp(initial: ProjectionType) {
  let projection: ProjectionType = initial;
  const setProjectionCalls: ProjectionType[] = [];
  return {
    app: {
      getMapProjection: () => projection,
      setMapProjection: (next: ProjectionType) => {
        projection = next;
        setProjectionCalls.push(next);
      },
      getMap: () => null,
    },
    get projection() {
      return projection;
    },
    setProjectionCalls,
  };
}

describe("mercator projection lock", () => {
  it("restores the captured projection only after the last holder releases", () => {
    const fake = fakeProjectionApp("globe");

    // Google acquires first: captures "globe", forces mercator.
    acquireMercatorProjectionLock("google", fake.app);
    assert.equal(fake.projection, "mercator");

    // I3S acquires while already mercator: must not capture a new "previous".
    acquireMercatorProjectionLock("arcgis-i3s", fake.app);
    assert.equal(fake.projection, "mercator");

    // Removing Google must not restore globe while I3S still needs mercator.
    releaseMercatorProjectionLock("google", fake.app);
    assert.equal(fake.projection, "mercator");

    // Removing the last holder restores the originally-captured globe.
    releaseMercatorProjectionLock("arcgis-i3s", fake.app);
    assert.equal(fake.projection, "globe");
  });

  it("treats repeated acquires for one overlay type as a single hold", () => {
    const fake = fakeProjectionApp("globe");

    acquireMercatorProjectionLock("google", fake.app);
    acquireMercatorProjectionLock("google", fake.app);
    acquireMercatorProjectionLock("google", fake.app);
    assert.equal(fake.projection, "mercator");

    // A single release (mirroring the once-per-type teardown) restores globe.
    releaseMercatorProjectionLock("google", fake.app);
    assert.equal(fake.projection, "globe");
  });

  it("never restores a projection that started as (forced) mercator", () => {
    const fake = fakeProjectionApp("mercator");

    acquireMercatorProjectionLock("google", fake.app);
    releaseMercatorProjectionLock("google", fake.app);

    // "mercator" is never captured as worth restoring, so nothing is set back.
    assert.equal(fake.projection, "mercator");
    assert.deepEqual(fake.setProjectionCalls, ["mercator"]);
  });

  it("ignores a release for a key that never acquired the lock", () => {
    const fake = fakeProjectionApp("globe");

    releaseMercatorProjectionLock("google", fake.app);

    assert.deepEqual(fake.setProjectionCalls, []);
    assert.equal(fake.projection, "globe");
  });
});
