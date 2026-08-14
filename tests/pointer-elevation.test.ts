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
  POINTER_ELEVATION_CACHE_LIMIT,
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

  it("drops an in-flight result when the resolver is disposed", async () => {
    // Regression for review feedback on #1820: dispose only cleared an unstarted
    // timer, so a fetch already in flight (500ms debounce + up to 15s network)
    // still emitted after MapCanvas teardown, writing into a torn-down map.
    const emitted: (number | null)[] = [];
    let release: ((r: Response) => void) | null = null;
    // Resolved by fetchImpl itself, so the test proves the request really is in
    // flight before disposing rather than trusting a fixed delay.
    let notifyStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const fetchImpl: FetchLike = () =>
      new Promise<Response>((resolve) => {
        release = resolve;
        notifyStarted?.();
      });

    const resolver = createPointerElevationResolver({
      getMap: () => ({ getTerrain: () => null }),
      isEarth: () => true,
      emit: (v) => emitted.push(v),
      fetchImpl,
      debounceMs: 5,
    });

    resolver.update([3, 3]);
    await started;
    resolver.dispose();
    release?.(new Response(JSON.stringify({ elevation: [815] }), { status: 200 }));
    await tick(20);

    assert.ok(!emitted.includes(815), `a disposed resolver still emitted: ${emitted.join(",")}`);
  });

  it("retries a cell whose lookup failed instead of caching the failure", async () => {
    // A transient network error surfaces as null, which is indistinguishable
    // from "no data". Caching it would blackhole that ~11m cell for the session.
    const emitted: (number | null)[] = [];
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      if (calls === 1) throw new Error("network blip");
      return new Response(JSON.stringify({ elevation: [640] }), { status: 200 });
    };

    const resolver = createPointerElevationResolver({
      getMap: () => ({ getTerrain: () => null }),
      isEarth: () => true,
      emit: (v) => emitted.push(v),
      fetchImpl,
      debounceMs: 5,
    });

    resolver.update([7, 7]);
    await tick(30);
    assert.equal(emitted.at(-1), null, "a failed lookup reads as unknown");

    resolver.update([7, 7]); // hover the same cell again
    await tick(30);
    assert.equal(calls, 2, "the failure must not have been cached");
    assert.equal(emitted.at(-1), 640);
    resolver.dispose();
  });

  it("does nothing at all while the readout is switched off", async () => {
    const emitted: (number | null)[] = [];
    const { fetch, calls } = stubFetch(1234);
    let enabled = false;
    const resolver = createPointerElevationResolver({
      getMap: () => terrainMap(900), // terrain available, but toggle is off
      isEarth: () => true,
      isEnabled: () => enabled,
      emit: (v) => emitted.push(v),
      fetchImpl: fetch,
      debounceMs: 5,
    });

    resolver.update([2, 2]);
    await tick(30);
    assert.deepEqual(emitted, [null], "no terrain sample while switched off");
    assert.equal(calls(), 0, "no request while switched off");

    enabled = true;
    resolver.update([2, 2]);
    assert.equal(emitted.at(-1), 900, "switching it on resumes the readout");
    resolver.dispose();
  });

  it("evicts only the oldest entry at the cache cap", async () => {
    // Clearing the whole cache at the cap made every 500th distinct cell
    // trigger a burst of re-fetches for cells still under active hovering.
    const { fetch, calls } = stubFetch(1);
    const resolver = createPointerElevationResolver({
      getMap: () => ({ getTerrain: () => null }),
      isEarth: () => true,
      emit: () => {},
      fetchImpl: fetch,
      debounceMs: 1,
    });

    // Fill past the cap, touching the first cell again partway through so it is
    // the most recently used and must survive eviction.
    const first: [number, number] = [0, 0];
    for (let i = 0; i < POINTER_ELEVATION_CACHE_LIMIT + 5; i += 1) {
      resolver.update([i * 0.01, i * 0.01]);
      await tick(4);
      if (i === 10) {
        resolver.update(first);
        await tick(4);
      }
    }

    const before = calls();
    resolver.update(first); // still cached -> served without a request
    await tick(10);
    assert.equal(calls(), before, "the most recently used cell was evicted");
    resolver.dispose();
  });

  it("uses terrain but never the network when remote lookups are not consented", async () => {
    const emitted: (number | null)[] = [];
    const { fetch, calls } = stubFetch(1);
    const resolver = createPointerElevationResolver({
      getMap: () => terrainMap(640),
      isEarth: () => true,
      canUseRemote: () => false,
      emit: (v) => emitted.push(v),
      fetchImpl: fetch,
      debounceMs: 5,
    });

    resolver.update([1, 1]);
    await tick(30);
    assert.equal(emitted.at(-1), 640, "the terrain path sends nothing, so it stays available");
    assert.equal(calls(), 0, "no request without consent");
    resolver.dispose();
  });

  it("makes no request at all without consent when terrain is off", async () => {
    const emitted: (number | null)[] = [];
    const { fetch, calls } = stubFetch(1);
    const resolver = createPointerElevationResolver({
      getMap: () => ({ getTerrain: () => null }),
      isEarth: () => true,
      canUseRemote: () => false,
      emit: (v) => emitted.push(v),
      fetchImpl: fetch,
      debounceMs: 5,
    });

    resolver.update([1, 1]);
    await tick(30);
    assert.equal(calls(), 0);
    assert.deepEqual(emitted, [null]);
    resolver.dispose();
  });

  it("drops an in-flight result after invalidate, and stays usable", async () => {
    // Loading another project resets the readout; a response for the previous
    // project must not repaint it, including Earth-to-Earth switches where
    // neither the body nor the pointer changed.
    const emitted: (number | null)[] = [];
    let release: ((r: Response) => void) | null = null;
    let notifyStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const fetchImpl: FetchLike = () =>
      new Promise<Response>((resolve) => {
        release = resolve;
        notifyStarted?.();
      });

    // Flipped after the invalidation so the same resolver has a live source to
    // read from, without swapping the resolver out.
    let terrainAvailable = false;
    const resolver = createPointerElevationResolver({
      getMap: () => (terrainAvailable ? terrainMap(120) : { getTerrain: () => null }),
      isEarth: () => true,
      emit: (v) => emitted.push(v),
      fetchImpl,
      debounceMs: 5,
    });

    resolver.update([4, 4]);
    await started;
    resolver.invalidate();
    release?.(new Response(JSON.stringify({ elevation: [404] }), { status: 200 }));
    await tick(20);
    assert.ok(!emitted.includes(404), `stale project result leaked: ${emitted.join(",")}`);

    // Unlike a teardown, invalidate leaves *this* resolver working: terrain is
    // now available, so the next update emits from it rather than staying dead.
    terrainAvailable = true;
    resolver.update([4, 4]);
    assert.equal(emitted.at(-1), 120, "the invalidated resolver must still work");
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
