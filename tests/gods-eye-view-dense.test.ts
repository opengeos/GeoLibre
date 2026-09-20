import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { CesiumSceneHandle } from "@geolibre/map";
import { GodsEyeViewDenseCatalog } from "../packages/plugins/src/plugins/gods-eye-view-dense";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const TLE_TEXT = `ISS (ZARYA)
1 25544U 98067A   26262.50000000  .00016717  00000+0  30178-3 0  9991
2 25544  51.6400 120.0000 0005000  80.0000 280.0000 15.50000000400000
STARLINK TEST
1 44713U 19074A   26262.50000000  .00001200  00000+0  90000-4 0  9991
2 44713  53.0500 210.0000 0001500  85.0000 275.0000 15.06000000300000
`;

function makeGlobe(at = new Date("2026-09-20T12:00:00Z")) {
  const points: Array<Record<string, unknown>> = [];
  const added: unknown[] = [];
  const removed: unknown[] = [];
  let preRender: (() => void) | null = null;

  class PointPrimitiveCollection {
    add(options: Record<string, unknown>) {
      const point = { ...options };
      points.push(point);
      return point;
    }
  }
  class Cartesian3 {
    constructor(
      public x: number,
      public y: number,
      public z: number,
    ) {}
  }
  class NearFarScalar {
    constructor(
      public near: number,
      public nearValue: number,
      public far: number,
      public farValue: number,
    ) {}
  }
  const Cesium = {
    PointPrimitiveCollection,
    Cartesian3,
    NearFarScalar,
    Color: {
      fromCssColorString: (value: string) => ({
        value,
        withAlpha: (alpha: number) => ({ value, alpha }),
      }),
    },
    JulianDate: { toDate: (value: Date) => value },
  };
  const globe = {
    Cesium,
    viewer: { id: "dense-test" },
    scene: {
      primitives: {
        add: (value: unknown) => {
          added.push(value);
          return value;
        },
        remove: (value: unknown) => {
          removed.push(value);
          return true;
        },
      },
      preRender: {
        addEventListener: (listener: () => void) => {
          preRender = listener;
          return () => {
            preRender = null;
          };
        },
      },
    },
    clock: { currentTime: at },
    requestRender: () => {},
  } as unknown as CesiumSceneHandle;
  return { globe, points, added, removed, render: () => preRender?.() };
}

describe("God's Eye View dense catalog", () => {
  it("adds only non-core Starlink records as incrementally updated points", async () => {
    globalThis.fetch = (async () =>
      new Response(TLE_TEXT, {
        status: 200,
        headers: { "content-type": "text/plain" },
      })) as typeof fetch;
    const fake = makeGlobe();
    const catalog = new GodsEyeViewDenseCatalog();

    await catalog.enable(fake.globe, new Set(["25544"]));

    assert.deepEqual(catalog.snapshot(), {
      status: "ready",
      count: 1,
      error: null,
    });
    assert.equal(fake.added.length, 1, "all dense points share one Cesium collection");
    assert.equal(fake.points.length, 1, "the core ISS is deduplicated");
    assert.deepEqual(fake.points[0].id, {
      godsEyeViewDenseSatellite: true,
      catalogNumber: "44713",
      name: "STARLINK TEST",
    });
    const before = fake.points[0].position;
    fake.render();
    assert.notEqual(fake.points[0].position, before, "a pre-render slice re-propagates the shell");

    catalog.disable();
    assert.equal(fake.removed.length, 1);
    assert.deepEqual(catalog.snapshot(), {
      status: "idle",
      count: 0,
      error: null,
    });
  });

  it("re-filters the shell when the core catalog's membership changes", async () => {
    globalThis.fetch = (async () =>
      new Response(TLE_TEXT, {
        status: 200,
        headers: { "content-type": "text/plain" },
      })) as typeof fetch;
    const fake = makeGlobe();
    const catalog = new GodsEyeViewDenseCatalog();

    await catalog.enable(fake.globe, new Set(["25544"]));
    assert.equal(catalog.snapshot().count, 1, "the ISS is left to the core feed");

    // Re-enabling with the same exclusions is the every-refresh case and must
    // not rebuild.
    const collections = fake.added.length;
    await catalog.enable(fake.globe, new Set(["25544"]));
    assert.equal(fake.added.length, collections, "an unchanged core catalog rebuilds nothing");

    // The ISS leaving the core groups has to bring it back into the shell,
    // rather than leaving it drawn by neither.
    await catalog.enable(fake.globe, new Set());
    assert.equal(catalog.snapshot().count, 2);
    assert.deepEqual(
      fake.points.slice(-2).map((point) => (point.id as { catalogNumber: string }).catalogNumber),
      ["25544", "44713"],
    );
  });

  it("drops a satellite SGP4 will not propagate rather than placing a NaN point", async () => {
    globalThis.fetch = (async () =>
      new Response(TLE_TEXT, {
        status: 200,
        headers: { "content-type": "text/plain" },
      })) as typeof fetch;
    // Far enough past the elements' epoch that SGP4 reports the orbit decayed
    // (error 6) and returns no state — what a real catalogue's decaying
    // Starlinks do at the current time.
    const fake = makeGlobe(new Date("2086-09-20T12:00:00Z"));
    const catalog = new GodsEyeViewDenseCatalog();

    await catalog.enable(fake.globe, new Set(["25544"]));

    // Left out rather than parked at a NaN coordinate, and reported as a clean
    // failure rather than an exception out of the load.
    assert.equal(fake.points.length, 0);
    assert.deepEqual(catalog.snapshot(), {
      status: "failed",
      count: 0,
      error: "feed returned no usable satellites",
    });
    // The pre-render slice has to survive the same satellites.
    fake.render();
    assert.equal(fake.points.length, 0);
  });
});
