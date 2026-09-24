import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { arcgisFeatureSelectionMap } from "../packages/map/src/arcgis-feature-selection";
import type { ArcgisView } from "../packages/map/src/arcgis-sdk";
import type { MapEngine } from "../packages/map/src/map-engine";

// The shared selection gestures (map-feature-selection.ts) drive a
// MapLibre-shaped map; this adapter is what they drive on ArcGIS (#2477).

function makeView() {
  const { document } = parseHTML("<html><body><div></div></body></html>").window;
  const container = document.querySelector("div") as unknown as HTMLElement;
  const handlers = new Map<string, Set<(event: Record<string, unknown>) => void>>();
  const view = {
    container,
    toMap: ({ x, y }: { x: number; y: number }) => ({ longitude: x / 10, latitude: y / 10 }),
    on: (type: string, handler: (event: Record<string, unknown>) => void) => {
      const set = handlers.get(type) ?? new Set();
      set.add(handler);
      handlers.set(type, set);
      return { remove: () => set.delete(handler) };
    },
  };
  let suspended = 0;
  let resumed = 0;
  const engine = {
    getRenderSurface: () => null,
    suspendNavigation: () => {
      suspended++;
      return () => resumed++;
    },
  } as unknown as MapEngine;
  const fire = (type: string, event: Record<string, unknown>) => {
    for (const handler of handlers.get(type) ?? []) handler(event);
  };
  return {
    map: arcgisFeatureSelectionMap(engine, view as unknown as ArcgisView),
    fire,
    handlers,
    counts: () => ({ suspended, resumed }),
  };
}

describe("arcgisFeatureSelectionMap", () => {
  it("suspends navigation once for every handler a gesture disables", () => {
    const { map, counts } = makeView();
    map.dragPan.disable();
    map.scrollZoom.disable();
    map.scrollZoom.disable();
    assert.deepEqual(counts(), { suspended: 1, resumed: 0 });
    assert.equal(map.dragPan.isEnabled(), false);
    map.dragPan.enable();
    assert.deepEqual(counts(), { suspended: 1, resumed: 0 });
    map.scrollZoom.enable();
    assert.deepEqual(counts(), { suspended: 1, resumed: 1 });
    // The view has no box zoom, so there is nothing to suspend.
    assert.equal(map.boxZoom.isEnabled(), false);
  });
  it("reads clicks from the view and unprojects through it", () => {
    const { map, fire, handlers } = makeView();
    const points: unknown[] = [];
    let stopped = false;
    const listener = (event: { point: unknown; preventDefault(): void }) => {
      points.push(event.point);
      event.preventDefault();
    };
    map.on("dblclick", listener);
    fire("double-click", { x: 4, y: 5, stopPropagation: () => (stopped = true) });
    assert.deepEqual(points, [{ x: 4, y: 5 }]);
    assert.equal(stopped, true, "a handled double click does not zoom");
    assert.deepEqual(map.unproject([20, 30]), { lng: 2, lat: 3 });
    map.off("dblclick", listener);
    assert.equal(handlers.get("double-click")?.size, 0);
  });
});
