import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MeasureControl } from "maplibre-gl-components";

import { healMeasureLayersOnStyleSwap } from "../packages/plugins/src/plugins/components/measure";

/** A map that keeps sources by id and fires `style.load` on demand. */
function fakeMap() {
  const sources = new Set<string>();
  const listeners = new Set<() => void>();
  return {
    sources,
    listeners,
    getSource: (id: string) => (sources.has(id) ? {} : undefined),
    on: (_type: "style.load", listener: () => void) => listeners.add(listener),
    off: (_type: "style.load", listener: () => void) => listeners.delete(listener),
    /** Mimic `setStyle(..., { diff: false })`: drop every source, then load. */
    swapStyle() {
      sources.clear();
      for (const listener of listeners) listener();
    },
  };
}

function fakeControl(map: ReturnType<typeof fakeMap>) {
  const calls: string[] = [];
  const control = {
    _map: map,
    _sourceId: "measure-1-source",
    _setupMapSources() {
      calls.push("setup");
      map.sources.add("measure-1-source");
    },
    _updateMapGeometry() {
      calls.push("update");
    },
  };
  return { control: control as unknown as MeasureControl, calls };
}

describe("healMeasureLayersOnStyleSwap", () => {
  it("re-adds the measure source and replays geometry after a style swap", () => {
    const map = fakeMap();
    const { control, calls } = fakeControl(map);
    map.sources.add("measure-1-source");
    const detach = healMeasureLayersOnStyleSwap(control);

    map.swapStyle();
    assert.deepEqual(calls, ["setup", "update"]);
    assert.ok(map.sources.has("measure-1-source"));

    detach();
    assert.equal(map.listeners.size, 0);
  });

  it("leaves a source that survived the style load alone", () => {
    const map = fakeMap();
    const { control, calls } = fakeControl(map);
    healMeasureLayersOnStyleSwap(control);
    map.sources.add("measure-1-source");
    for (const listener of map.listeners) listener();
    assert.deepEqual(calls, []);
  });

  it("is a no-op when the upstream internals are missing", () => {
    const map = fakeMap();
    const detach = healMeasureLayersOnStyleSwap({ _map: map } as unknown as MeasureControl);
    assert.equal(map.listeners.size, 0);
    detach();
  });
});
