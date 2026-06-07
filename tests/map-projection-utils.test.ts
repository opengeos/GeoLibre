import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Map as MapLibreMap } from "maplibre-gl";
import { ensureMercatorProjection } from "../packages/plugins/src/plugins/map-projection-utils";

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
