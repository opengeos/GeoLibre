import assert from "node:assert/strict";
import test from "node:test";
import type { FeatureCollection } from "geojson";
import {
  drawMapLibreBounds,
  normalizeDrawLongitude,
  snapBoundsPointToAspect,
} from "../packages/map/src/engine/draw-bounds";
import { createMapEngineHandleForTesting } from "../packages/map/src/engine/handle";
import { pickMapLibrePoint } from "../packages/map/src/engine/pick-point";
import { MapLibreTransientOverlays } from "../packages/map/src/engine/transient-overlays";
import type { MapMarkerEventMap, MapMarkerHandle } from "../packages/map/src/engine/types";
import { createTestMapEngine } from "./engine-test-fakes";

class FakeWindow extends EventTarget {}

class FakeGestureMap {
  readonly canvas = {
    style: { cursor: "grab" },
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  };
  readonly dragPan = this.toggle(true);
  readonly boxZoom = this.toggle(true);
  readonly scrollZoom = this.toggle(true);
  readonly doubleClickZoom = this.toggle(true);
  private readonly listeners = new Map<string, Set<(payload: never) => void>>();

  getCanvas() {
    return this.canvas;
  }

  on(event: string, handler: (payload: never) => void): void {
    const handlers = this.listeners.get(event) ?? new Set();
    handlers.add(handler);
    this.listeners.set(event, handlers);
  }

  off(event: string, handler: (payload: never) => void): void {
    this.listeners.get(event)?.delete(handler);
  }

  emit(event: string, payload: unknown): void {
    for (const handler of [...(this.listeners.get(event) ?? [])]) handler(payload as never);
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  unproject([x, y]: [number, number]) {
    return { lng: x / 10, lat: y / 10 };
  }

  private toggle(initial: boolean) {
    let enabled = initial;
    return {
      isEnabled: () => enabled,
      enable: () => {
        enabled = true;
      },
      disable: () => {
        enabled = false;
      },
    };
  }
}

async function withFakeWindow<T>(run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: new FakeWindow() });
  try {
    return await run();
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

const emptyCollection: FeatureCollection = { type: "FeatureCollection", features: [] };

test("point picking resolves a normalized point and restores its listener and cursor", async () => {
  await withFakeWindow(async () => {
    const map = new FakeGestureMap();
    const result = pickMapLibrePoint(map as never);
    assert.equal(map.canvas.style.cursor, "crosshair");

    map.emit("click", {
      lngLat: { lng: 8.55, lat: 47.37 },
      originalEvent: { button: 0 },
    });

    assert.deepEqual(await result, [8.55, 47.37]);
    assert.equal(map.listenerCount("click"), 0);
    assert.equal(map.canvas.style.cursor, "grab");
  });
});

test("point and bounds gestures are cancelable and restore navigation state", async () => {
  await withFakeWindow(async () => {
    const pointMap = new FakeGestureMap();
    const pointAbort = new AbortController();
    const point = pickMapLibrePoint(pointMap as never, { signal: pointAbort.signal });
    pointAbort.abort();
    assert.equal(await point, null);
    assert.equal(pointMap.listenerCount("click"), 0);

    const boundsMap = new FakeGestureMap();
    const boundsAbort = new AbortController();
    const previews: unknown[] = [];
    const bounds = drawMapLibreBounds(boundsMap as never, {
      signal: boundsAbort.signal,
      onPreview: (preview) => previews.push(preview),
    });
    assert.equal(boundsMap.dragPan.isEnabled(), false);
    assert.equal(boundsMap.boxZoom.isEnabled(), false);
    assert.equal(boundsMap.scrollZoom.isEnabled(), false);
    assert.equal(boundsMap.doubleClickZoom.isEnabled(), false);

    boundsAbort.abort();
    assert.equal(await bounds, null);
    assert.equal(boundsMap.dragPan.isEnabled(), true);
    assert.equal(boundsMap.boxZoom.isEnabled(), true);
    assert.equal(boundsMap.scrollZoom.isEnabled(), true);
    assert.equal(boundsMap.doubleClickZoom.isEnabled(), true);
    assert.equal(boundsMap.listenerCount("mousedown"), 0);
    assert.deepEqual(previews, [null]);
  });
});

test("bounds drawing commits geographic coordinates and aspect snapping is directional", async () => {
  await withFakeWindow(async () => {
    const map = new FakeGestureMap();
    const result = drawMapLibreBounds(map as never);
    map.emit("mousedown", {
      originalEvent: { button: 0, clientX: 10, clientY: 20 },
    });
    map.emit("mouseup", {
      originalEvent: { button: 0, clientX: 50, clientY: 80, shiftKey: false },
    });
    assert.deepEqual(await result, [1, 2, 5, 8]);
  });

  assert.deepEqual(snapBoundsPointToAspect({ x: 10, y: 10 }, { x: -10, y: 20 }, 2), {
    x: -10,
    y: 20,
  });
  assert.deepEqual(snapBoundsPointToAspect({ x: 0, y: 0 }, { x: 5, y: -10 }, 2), {
    x: 20,
    y: -10,
  });
  assert.equal(normalizeDrawLongitude(190), -170);
  assert.equal(normalizeDrawLongitude(-180), 180);
});

test("transient overlays update, hide, restore after style replacement, and clean up", () => {
  const sources = new Map<
    string,
    { data: FeatureCollection; setData(data: FeatureCollection): void }
  >();
  const layers = new Map<string, Record<string, unknown>>();
  const map = {
    isStyleLoaded: () => true,
    getSource: (id: string) => sources.get(id),
    addSource: (id: string, source: { data: FeatureCollection }) => {
      sources.set(id, {
        data: source.data,
        setData(data) {
          this.data = data;
        },
      });
    },
    removeSource: (id: string) => sources.delete(id),
    getLayer: (id: string) => layers.get(id),
    addLayer: (layer: Record<string, unknown> & { id: string }) => layers.set(layer.id, layer),
    removeLayer: (id: string) => layers.delete(id),
    setLayoutProperty: (id: string, property: string, value: unknown) => {
      const layer = layers.get(id);
      if (layer) layer.layout = { ...(layer.layout as object), [property]: value };
    },
    setPaintProperty: (id: string, property: string, value: unknown) => {
      const layer = layers.get(id);
      if (layer) layer.paint = { ...(layer.paint as object), [property]: value };
    },
  };
  const overlays = new MapLibreTransientOverlays(map as never);
  overlays.upsert({
    id: "presence",
    data: emptyCollection,
    style: { lineColorProperty: "color", lineDash: [2, 1] },
  });

  const sourceId = "geolibre-engine-overlay-presence";
  assert.deepEqual(overlays.ids(), ["presence"]);
  assert.equal(sources.has(sourceId), true);
  assert.deepEqual(
    (layers.get(`${sourceId}-line`)?.paint as Record<string, unknown>)["line-color"],
    ["get", "color"],
  );
  assert.deepEqual(
    (layers.get(`${sourceId}-line`)?.paint as Record<string, unknown>)["line-dasharray"],
    [2, 1],
  );

  const updated: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [0, 0] } },
    ],
  };
  overlays.upsert({ id: "presence", data: updated });
  assert.equal(sources.get(sourceId)?.data, updated);
  overlays.setVisible("presence", false);
  assert.deepEqual(layers.get(`${sourceId}-point`)?.layout, { visibility: "none" });

  sources.clear();
  layers.clear();
  overlays.restore();
  assert.equal(sources.get(sourceId)?.data, updated);
  assert.deepEqual(layers.get(`${sourceId}-line`)?.layout, { visibility: "none" });

  overlays.remove("presence");
  assert.deepEqual(overlays.ids(), []);
  assert.equal(sources.size, 0);
  assert.equal(layers.size, 0);
});

test("deferred marker handles forward drag events, rotation, and cleanup", async () => {
  const adapter = createTestMapEngine();
  const listeners = new Map<keyof MapMarkerEventMap, (payload: never) => void>();
  const rotations: number[] = [];
  let removed = 0;
  let unsubscribed = 0;
  const nativeMarker: MapMarkerHandle = {
    setLngLat: () => undefined,
    getLngLat: () => [8.55, 47.37],
    setDraggable: () => undefined,
    setRotation: (rotation) => rotations.push(rotation),
    on: (event, handler) => {
      listeners.set(event, handler as (payload: never) => void);
      return () => {
        listeners.delete(event);
        unsubscribed += 1;
      };
    },
    remove: () => {
      removed += 1;
    },
  };
  Object.assign(adapter.interactions, { createMarker: () => nativeMarker });
  const handle = createMapEngineHandleForTesting("maplibre", async () => adapter);
  await handle.mount({} as HTMLElement, {
    center: [0, 0],
    zoom: 2,
    bearing: 0,
    pitch: 0,
  });

  const marker = handle.interactions.createMarker({ lngLat: [8.55, 47.37], draggable: true });
  const drags: Array<[number, number]> = [];
  marker.on("drag", ({ lngLat }) => drags.push(lngLat));
  marker.setRotation(42);
  listeners.get("drag")?.({ lngLat: [8.56, 47.38] } as never);
  marker.remove();

  assert.deepEqual(rotations, [42]);
  assert.deepEqual(drags, [[8.56, 47.38]]);
  assert.equal(unsubscribed, 1);
  assert.equal(removed, 1);
});
