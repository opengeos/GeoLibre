import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { CogLayerControl } from "maplibre-gl-components";
import type { SwipeCogRasterSnapshot } from "../packages/plugins/src/plugins/maplibre-components";
import {
  SwipeCogMirror,
  type SwipeCogMirrorDeps,
} from "../packages/plugins/src/plugins/swipe-cog-mirror";

// A fake CogLayerControl is opaque to the mirror (only passed through deps), so
// a plain object stands in.
const fakeControl = {} as CogLayerControl;
const fakeMap = {} as MapLibreMap;

interface Recorder {
  deps: SwipeCogMirrorDeps;
  calls: string[];
  created: number;
  removedControl: number;
}

function makeDeps(): Recorder {
  const calls: string[] = [];
  let created = 0;
  let removedControl = 0;
  let idCounter = 0;
  const deps: SwipeCogMirrorDeps = {
    createControl: async () => {
      created += 1;
      return fakeControl;
    },
    addLayer: async (_control, snapshot) => {
      idCounter += 1;
      const id = `m${idCounter}`;
      calls.push(`add:${snapshot.id}=>${id}`);
      return id;
    },
    setOpacity: (_control, mirrorId, opacity) => {
      calls.push(`opacity:${mirrorId}=${opacity}`);
    },
    removeLayer: (_control, mirrorId) => {
      calls.push(`remove:${mirrorId}`);
    },
    clearLayers: () => {
      calls.push("clear");
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

function raster(id: string, patch: Partial<SwipeCogRasterSnapshot> = {}): SwipeCogRasterSnapshot {
  return {
    id,
    name: id,
    url: `https://example.com/${id}.tif`,
    visible: true,
    opacity: 1,
    bands: "1,2,3",
    colormap: undefined,
    rescaleMin: 0,
    rescaleMax: 255,
    nodata: 0,
    ...patch,
  };
}

describe("SwipeCogMirror", () => {
  it("adds a new raster and mounts the control once", async () => {
    const rec = makeDeps();
    const mirror = new SwipeCogMirror(fakeMap, rec.deps);
    await mirror.sync([raster("a")]);
    assert.equal(rec.created, 1);
    assert.deepEqual(rec.calls, ["add:a=>m1"]);
  });

  it("applies an opacity-only change in place without re-adding", async () => {
    const rec = makeDeps();
    const mirror = new SwipeCogMirror(fakeMap, rec.deps);
    await mirror.sync([raster("a")]);
    await mirror.sync([raster("a", { opacity: 0.5 })]);
    assert.deepEqual(rec.calls, ["add:a=>m1", "opacity:m1=0.5"]);
    assert.equal(rec.created, 1);
  });

  it("reloads a raster when its visualization changes", async () => {
    const rec = makeDeps();
    const mirror = new SwipeCogMirror(fakeMap, rec.deps);
    await mirror.sync([raster("a")]);
    await mirror.sync([raster("a", { colormap: "viridis" })]);
    assert.deepEqual(rec.calls, ["add:a=>m1", "remove:m1", "add:a=>m2"]);
  });

  it("removes a raster dropped from the desired set", async () => {
    const rec = makeDeps();
    const mirror = new SwipeCogMirror(fakeMap, rec.deps);
    await mirror.sync([raster("a"), raster("b")]);
    await mirror.sync([raster("a")]);
    assert.deepEqual(rec.calls, ["add:a=>m1", "add:b=>m2", "remove:m2"]);
  });

  it("does nothing (and never mounts a control) when desired is empty", async () => {
    const rec = makeDeps();
    const mirror = new SwipeCogMirror(fakeMap, rec.deps);
    await mirror.sync([]);
    assert.equal(rec.created, 0);
    assert.deepEqual(rec.calls, []);
  });

  it("clears mounted layers when the desired set becomes empty", async () => {
    const rec = makeDeps();
    const mirror = new SwipeCogMirror(fakeMap, rec.deps);
    await mirror.sync([raster("a")]);
    await mirror.sync([]);
    assert.deepEqual(rec.calls, ["add:a=>m1", "clear"]);
  });

  it("skips redundant work when nothing changed", async () => {
    const rec = makeDeps();
    const mirror = new SwipeCogMirror(fakeMap, rec.deps);
    await mirror.sync([raster("a")]);
    await mirror.sync([raster("a")]);
    assert.deepEqual(rec.calls, ["add:a=>m1"]);
  });

  it("removes the control and stops rendering after destroy", async () => {
    const rec = makeDeps();
    const mirror = new SwipeCogMirror(fakeMap, rec.deps);
    await mirror.sync([raster("a")]);
    mirror.destroy();
    assert.equal(rec.removedControl, 1);
    await mirror.sync([raster("b")]);
    // No further adds after destroy.
    assert.deepEqual(rec.calls, ["add:a=>m1"]);
  });
});
