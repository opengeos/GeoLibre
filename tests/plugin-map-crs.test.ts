import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type * as maplibregl from "maplibre-gl";
import { MAP_CRS_CHANGE_EVENT } from "../packages/core/src/map-crs";
import {
  getActiveMapCrs,
  setActiveMapCrs,
  type ResolvedMapCrs,
} from "../packages/map/src/active-map-crs";
import { createPluginMapCrsApi } from "../apps/geolibre-desktop/src/lib/plugin-map-crs";

const UTM32: ResolvedMapCrs = {
  id: "EPSG:25832",
  code: "EPSG:25832",
  definition: "+proj=utm +zone=32 +ellps=GRS80 +units=m +no_defs",
  tileMatrixSet: { origin: [0, 0], extentAtZoom0: 1 },
};

const MARS: ResolvedMapCrs = {
  id: "mars-equirectangular",
  code: "IAU_2015:49910",
  wmsSrs: "EPSG:4326",
  definition: "+proj=eqc +R=3396190 +units=m +no_defs",
  tileMatrixSet: { origin: [0, 0], extentAtZoom0: 1 },
};

/** An engine whose CRS the test sets, standing in for the MapLibre controller. */
function fakeEngine(initial: ResolvedMapCrs | null = null) {
  let crs = initial;
  return {
    getMapCrs: () => crs,
    set(next: ResolvedMapCrs | null) {
      crs = next;
    },
  };
}

describe("plugin map CRS API", () => {
  const originalWindow = (globalThis as { window?: unknown }).window;
  afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
  });

  it("reports null without an engine or on an engine that draws no other CRS", () => {
    assert.equal(createPluginMapCrsApi({ getEngine: () => null }).getMapCrs(), null);
    assert.equal(createPluginMapCrsApi({ getEngine: () => ({}) }).getMapCrs(), null);
    assert.equal(createPluginMapCrsApi({ getEngine: () => fakeEngine() }).getMapCrs(), null);
  });

  it("hands out the id, code and server label, never the grid or definition", () => {
    const engine = fakeEngine(UTM32);
    const api = createPluginMapCrsApi({ getEngine: () => engine });
    assert.deepEqual(api.getMapCrs(), { id: "EPSG:25832", code: "EPSG:25832" });
    engine.set(MARS);
    assert.deepEqual(api.getMapCrs(), {
      id: "mars-equirectangular",
      code: "IAU_2015:49910",
      wmsSrs: "EPSG:4326",
    });
  });

  it("calls back only when the value changes, and stops after unsubscribe", () => {
    const target = new EventTarget();
    const engine = fakeEngine();
    const api = createPluginMapCrsApi({ getEngine: () => engine, eventTarget: target });
    const seen: unknown[] = [];
    const stop = api.onMapCrsChange((crs) => seen.push(crs));
    assert.deepEqual(seen, [], "no immediate call");

    target.dispatchEvent(new Event(MAP_CRS_CHANGE_EVENT));
    assert.deepEqual(seen, [], "an event without a change is dropped");

    engine.set(UTM32);
    target.dispatchEvent(new Event(MAP_CRS_CHANGE_EVENT));
    target.dispatchEvent(new Event(MAP_CRS_CHANGE_EVENT));
    engine.set(null);
    target.dispatchEvent(new Event(MAP_CRS_CHANGE_EVENT));
    assert.deepEqual(seen, [{ id: "EPSG:25832", code: "EPSG:25832" }, null]);

    stop();
    engine.set(MARS);
    target.dispatchEvent(new Event(MAP_CRS_CHANGE_EVENT));
    assert.equal(seen.length, 2);
  });

  it("is told by the map when it enters and leaves a CRS", () => {
    const target = new EventTarget();
    (globalThis as { window?: unknown }).window = target;
    const map = {} as maplibregl.Map;
    const api = createPluginMapCrsApi({
      getEngine: () => ({ getMapCrs: () => getActiveMapCrs(map) ?? null }),
      eventTarget: target,
    });
    const seen: unknown[] = [];
    const stop = api.onMapCrsChange((crs) => seen.push(crs?.code ?? null));
    setActiveMapCrs(map, UTM32);
    setActiveMapCrs(map, UTM32);
    setActiveMapCrs(map, MARS);
    setActiveMapCrs(map, null);
    stop();
    assert.deepEqual(seen, ["EPSG:25832", "IAU_2015:49910", null]);
  });
});
