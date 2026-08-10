/**
 * Tests for the status-bar pointer elevation resolver (issue #1813).
 *
 * The behaviour worth pinning down is the asymmetry between the two sources:
 * terrain is sampled synchronously on every move, while the network fallback is
 * debounced, cached, Earth-only, and must never write a result for a point the
 * pointer has already left.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createPointerElevationResolver,
  sampleMapTerrainPoint,
  type FetchLike,
  type TerrainMapLike,
} from "../packages/core/src/elevation";

/** A map stub with terrain enabled at a fixed exaggeration. */
function terrainMap(elevation: number | null, exaggeration = 1): TerrainMapLike {
  return {
    getTerrain: () => ({ exaggeration }),
    queryTerrainElevation: () => (elevation === null ? null : elevation * exaggeration),
  };
}

/** A fetch stub returning one elevation, counting how many times it was called. */
function stubFetch(elevation: number): { fetch: FetchLike; calls: () => number } {
  let calls = 0;
  const fetchImpl: FetchLike = async () => {
    calls += 1;
    return new Response(JSON.stringify({ elevation: [elevation] }), { status: 200 });
  };
  return { fetch: fetchImpl, calls: () => calls };
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("sampleMapTerrainPoint", () => {
  it("divides the exaggeration back out", () => {
    assert.equal(sampleMapTerrainPoint(terrainMap(1200, 3), [0, 0]), 1200);
  });

  it("returns null when terrain is off", () => {
    assert.equal(sampleMapTerrainPoint({ getTerrain: () => null }, [0, 0]), null);
  });
});

describe("pointer elevation resolver", () => {
  it("emits the terrain sample synchronously, without any network call", () => {
    const emitted: (number | null)[] = [];
    const { fetch, calls } = stubFetch(999);
    const resolver = createPointerElevationResolver({
      getMap: () => terrainMap(1500),
      isEarth: () => true,
      emit: (v) => emitted.push(v),
      fetchImpl: fetch,
      debounceMs: 5,
    });

    resolver.update([10, 20]);
    assert.deepEqual(emitted, [1500]);
    assert.equal(calls(), 0, "terrain hit must not trigger a remote lookup");
    resolver.dispose();
  });

  it("falls back to the network only after the pointer settles", async () => {
    const emitted: (number | null)[] = [];
    const { fetch, calls } = stubFetch(742);
    const resolver = createPointerElevationResolver({
      getMap: () => ({ getTerrain: () => null }), // terrain off
      isEarth: () => true,
      emit: (v) => emitted.push(v),
      fetchImpl: fetch,
      debounceMs: 20,
    });

    // A sweep across the map: only the final resting point should be fetched.
    resolver.update([1, 1]);
    resolver.update([2, 2]);
    resolver.update([3, 3]);
    assert.equal(calls(), 0, "no request while the pointer is still moving");

    await tick(60);
    assert.equal(calls(), 1, "exactly one request for the point it settled on");
    assert.equal(emitted.at(-1), 742);
    resolver.dispose();
  });

  it("never emits a result for a point the pointer has left", async () => {
    const emitted: (number | null)[] = [];
    let resolveFirst: ((r: Response) => void) | null = null;
    const fetchImpl: FetchLike = async () =>
      new Promise<Response>((resolve) => {
        if (!resolveFirst) resolveFirst = resolve;
        else resolve(new Response(JSON.stringify({ elevation: [200] }), { status: 200 }));
      });

    const resolver = createPointerElevationResolver({
      getMap: () => ({ getTerrain: () => null }),
      isEarth: () => true,
      emit: (v) => emitted.push(v),
      fetchImpl,
      debounceMs: 5,
    });

    resolver.update([1, 1]);
    await tick(20); // first request now in flight
    resolver.update([9, 9]); // pointer moves away before it resolves
    resolveFirst?.(new Response(JSON.stringify({ elevation: [100] }), { status: 200 }));
    await tick(20);

    assert.ok(
      !emitted.includes(100),
      `stale elevation for the abandoned point leaked into the readout: ${emitted.join(",")}`,
    );
    resolver.dispose();
  });

  it("serves a repeat hover from cache instead of refetching", async () => {
    const emitted: (number | null)[] = [];
    const { fetch, calls } = stubFetch(555);
    const resolver = createPointerElevationResolver({
      getMap: () => ({ getTerrain: () => null }),
      isEarth: () => true,
      emit: (v) => emitted.push(v),
      fetchImpl: fetch,
      debounceMs: 5,
    });

    resolver.update([12.34567, 45.6789]);
    await tick(30);
    assert.equal(calls(), 1);

    // Same ~11 m cell: served from cache, synchronously, with no second request.
    emitted.length = 0;
    resolver.update([12.345671, 45.678901]);
    assert.deepEqual(emitted, [555], "cached value should be emitted immediately");
    await tick(30);
    assert.equal(calls(), 1, "a cached cell must not hit the network again");
    resolver.dispose();
  });

  it("does not call Open-Meteo off Earth", async () => {
    const emitted: (number | null)[] = [];
    const { fetch, calls } = stubFetch(1);
    const resolver = createPointerElevationResolver({
      getMap: () => ({ getTerrain: () => null }),
      isEarth: () => false, // Mars/Moon basemap active
      emit: (v) => emitted.push(v),
      fetchImpl: fetch,
      debounceMs: 5,
    });

    resolver.update([0, 0]);
    await tick(30);
    assert.equal(calls(), 0, "Open-Meteo has no data for other bodies");
    assert.deepEqual(emitted, [null]);
    resolver.dispose();
  });

  it("clears the readout and cancels a pending lookup when the pointer leaves", async () => {
    const emitted: (number | null)[] = [];
    const { fetch, calls } = stubFetch(300);
    const resolver = createPointerElevationResolver({
      getMap: () => ({ getTerrain: () => null }),
      isEarth: () => true,
      emit: (v) => emitted.push(v),
      fetchImpl: fetch,
      debounceMs: 20,
    });

    resolver.update([5, 5]);
    resolver.update(null); // pointer left the map
    assert.equal(emitted.at(-1), null);
    await tick(60);
    assert.equal(calls(), 0, "a lookup for a pointer that already left is wasted work");
    resolver.dispose();
  });
});
