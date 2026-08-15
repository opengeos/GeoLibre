import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { RasterControl } from "maplibre-gl-raster";
import {
  SwipeRasterMirror,
  type SwipeRasterMirrorDeps,
  type SwipeRasterSnapshot,
} from "../packages/plugins/src/plugins/swipe-raster-mirror";

// A fake RasterControl is opaque to the mirror (only passed through deps), so a
// plain object stands in.
const fakeControl = {} as RasterControl;
const fakeMap = {} as MapLibreMap;

interface Recorder {
  deps: SwipeRasterMirrorDeps;
  calls: string[];
  created: number;
  removedControl: number;
}

function makeDeps(failAdd?: (snapshot: SwipeRasterSnapshot) => boolean): Recorder {
  const calls: string[] = [];
  let created = 0;
  let removedControl = 0;
  let idCounter = 0;
  const deps: SwipeRasterMirrorDeps = {
    createControl: async () => {
      created += 1;
      return fakeControl;
    },
    addRaster: async (_control, snapshot) => {
      if (failAdd?.(snapshot)) {
        calls.push(`add-fail:${snapshot.id}`);
        throw new Error("addRaster failed");
      }
      idCounter += 1;
      const id = `m${idCounter}`;
      calls.push(`add:${snapshot.id}=>${id}`);
      return id;
    },
    setOpacity: (_control, mirrorId, opacity) => {
      calls.push(`opacity:${mirrorId}=${opacity}`);
    },
    removeRaster: (_control, mirrorId) => {
      calls.push(`remove:${mirrorId}`);
    },
    removeControl: () => {
      removedControl += 1;
    },
  };
  return {
    deps,
    calls,
    get created() {
      return created;
    },
    get removedControl() {
      return removedControl;
    },
  };
}

function raster(id: string, patch: Partial<SwipeRasterSnapshot> = {}): SwipeRasterSnapshot {
  return {
    id,
    name: id,
    url: `https://example.com/${id}.tif`,
    visible: true,
    opacity: 1,
    state: { mode: "single", bands: [1] },
    ...patch,
  };
}

describe("SwipeRasterMirror", () => {
  it("adds a new raster and mounts the control once", async () => {
    const rec = makeDeps();
    const mirror = new SwipeRasterMirror(fakeMap, rec.deps);
    await mirror.sync([raster("a")]);
    assert.equal(rec.created, 1);
    assert.deepEqual(rec.calls, ["add:a=>m1"]);
  });

  it("reloads a raster when its renderer state changes", async () => {
    const rec = makeDeps();
    const mirror = new SwipeRasterMirror(fakeMap, rec.deps);
    await mirror.sync([raster("a")]);
    await mirror.sync([raster("a", { state: { mode: "single", colormap: "viridis" } })]);
    assert.deepEqual(rec.calls, ["add:a=>m1", "remove:m1", "add:a=>m2"]);
  });

  it("applies an opacity-only change in place without re-adding", async () => {
    const rec = makeDeps();
    const mirror = new SwipeRasterMirror(fakeMap, rec.deps);
    await mirror.sync([raster("a")]);
    await mirror.sync([raster("a", { opacity: 0.5 })]);
    assert.deepEqual(rec.calls, ["add:a=>m1", "opacity:m1=0.5"]);
    assert.equal(rec.created, 1);
  });

  it("removes a raster dropped from the desired set", async () => {
    const rec = makeDeps();
    const mirror = new SwipeRasterMirror(fakeMap, rec.deps);
    await mirror.sync([raster("a"), raster("b")]);
    await mirror.sync([raster("a")]);
    assert.deepEqual(rec.calls, ["add:a=>m1", "add:b=>m2", "remove:m2"]);
  });

  it("does nothing (and never mounts a control) when desired is empty", async () => {
    const rec = makeDeps();
    const mirror = new SwipeRasterMirror(fakeMap, rec.deps);
    await mirror.sync([]);
    assert.equal(rec.created, 0);
    assert.deepEqual(rec.calls, []);
  });

  it("removes mounted rasters when the desired set becomes empty", async () => {
    const rec = makeDeps();
    const mirror = new SwipeRasterMirror(fakeMap, rec.deps);
    await mirror.sync([raster("a")]);
    await mirror.sync([]);
    assert.deepEqual(rec.calls, ["add:a=>m1", "remove:m1"]);
  });

  it("skips redundant work when nothing changed", async () => {
    const rec = makeDeps();
    const mirror = new SwipeRasterMirror(fakeMap, rec.deps);
    await mirror.sync([raster("a")]);
    await mirror.sync([raster("a")]);
    assert.deepEqual(rec.calls, ["add:a=>m1"]);
  });

  it("retries the add on the next sync when a reload fails", async () => {
    // The reload triggered by the restyle fails, so the old mirror is gone with
    // nothing in its place. An unchanged follow-up sync must retry rather than
    // skip the raster as already-applied.
    const restyled = { state: { mode: "single", colormap: "viridis" } } as const;
    const rec = makeDeps((snapshot) => snapshot.state.colormap === "viridis");
    const mirror = new SwipeRasterMirror(fakeMap, rec.deps);
    await mirror.sync([raster("a")]);
    await mirror.sync([raster("a", restyled)]);
    await mirror.sync([raster("a", restyled)]);
    assert.deepEqual(rec.calls, ["add:a=>m1", "remove:m1", "add-fail:a", "add-fail:a"]);
  });

  it("removes a control that finishes mounting after destroy", async () => {
    const rec = makeDeps();
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const mounted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const creating = new Promise<void>((resolve) => {
      started = resolve;
    });
    const deps: SwipeRasterMirrorDeps = {
      ...rec.deps,
      createControl: async (map) => {
        started?.();
        await mounted;
        return rec.deps.createControl(map);
      },
    };
    const mirror = new SwipeRasterMirror(fakeMap, deps);
    const pending = mirror.sync([raster("a")]);
    await creating;
    mirror.destroy();
    // Nothing was mounted when destroy() ran, so it had no control to remove.
    assert.equal(rec.removedControl, 0);
    release?.();
    await pending;
    assert.equal(rec.created, 1);
    assert.equal(rec.removedControl, 1);
    assert.deepEqual(rec.calls, []);
  });

  it("removes the control and stops rendering after destroy", async () => {
    const rec = makeDeps();
    const mirror = new SwipeRasterMirror(fakeMap, rec.deps);
    await mirror.sync([raster("a")]);
    mirror.destroy();
    assert.equal(rec.removedControl, 1);
    await mirror.sync([raster("b")]);
    // No further adds after destroy.
    assert.deepEqual(rec.calls, ["add:a=>m1"]);
  });
});
