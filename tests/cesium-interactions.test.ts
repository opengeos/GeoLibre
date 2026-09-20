import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { parseHTML } from "linkedom";
import { Cartesian2, Event as CesiumEvent, ScreenSpaceEventType } from "@cesium/engine";
import { useAppStore } from "../packages/core/src/store";
import { IDENTIFY_ALL_LAYERS_ID } from "../packages/core/src/store";
import type { GeoLibreLayer } from "../packages/core/src/types";
import { installCesiumInteractions } from "../packages/map/src/cesium-interactions";

const original = {
  window: globalThis.window,
  document: globalThis.document,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
};
let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  Object.assign(globalThis, original);
});

function setup() {
  const { window, document } = parseHTML("<html><body><div><canvas></canvas></div></body></html>");
  const host = document.querySelector("div")!;
  Object.defineProperties(host, {
    clientWidth: { configurable: true, value: 500 },
    clientHeight: { configurable: true, value: 500 },
  });
  Object.defineProperties(window.HTMLElement.prototype, {
    offsetWidth: { configurable: true, get: () => 280 },
    offsetHeight: { configurable: true, get: () => 100 },
  });
  const frames = new Map<number, FrameRequestCallback>();
  Object.assign(globalThis, {
    window,
    document,
    requestAnimationFrame: (fn: FrameRequestCallback) => {
      frames.set(1, fn);
      return 1;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  });
  const actions = new Map<number, (event: unknown) => void>();
  let destroyed = false;
  let queries = 0;
  let highlights = 0;
  let identifyFeatureId: string | null = "0";
  let pointer: { coordinates: [number, number]; elevation: number | null } | null = {
    coordinates: [-83.9, 35.9],
    elevation: -12,
  };
  const layers = [false, true, true].map(
    (click, index): GeoLibreLayer => ({
      id: String(index),
      name: `Layer ${index}`,
      type: "geojson",
      source: {},
      metadata: {},
      visible: true,
      opacity: 1,
      style: {},
      popup: { click, hover: true, titleField: "name" },
    }),
  );
  useAppStore.setState({
    layers,
    selectedLayerId: null,
    selectedFeatureId: null,
    selectedFeatureIds: [],
    identifyLayerId: IDENTIFY_ALL_LAYERS_ID,
  });
  const camera = { moveStart: new CesiumEvent(), moveEnd: new CesiumEvent() };
  cleanup = installCesiumInteractions(
    {
      Cartesian2,
      ScreenSpaceEventType,
      ScreenSpaceEventHandler: class {
        setInputAction(fn: (event: unknown) => void, type: number) {
          actions.set(type, fn);
        }
        destroy() {
          destroyed = true;
          actions.clear();
        }
      },
    } as never,
    { canvas: document.querySelector("canvas"), camera } as never,
    {
      identifyAtScreen: () => {
        queries++;
        if (identifyFeatureId === null) return [];
        return layers.map((layer) => ({
          layerId: layer.id,
          featureId: identifyFeatureId,
          properties: { name: layer.name },
          geometry: null,
        }));
      },
      highlightFeature: () => {
        highlights++;
      },
      readView: () => ({ zoom: 3 }),
      readPointerAtScreen: () => pointer,
    } as never,
    () => "Fermer",
  );
  return {
    document,
    camera,
    frames,
    setPointer: (value: typeof pointer) => {
      pointer = value;
    },
    setIdentifyHits: (value: boolean) => {
      identifyFeatureId = value ? "0" : null;
    },
    setIdentifyFeatureId: (value: string) => {
      identifyFeatureId = value;
    },
    flush: () => {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(0);
    },
    click: () =>
      actions.get(ScreenSpaceEventType.LEFT_CLICK)?.({ position: new Cartesian2(10, 10) }),
    clickAt: (x: number, y: number) =>
      actions.get(ScreenSpaceEventType.LEFT_CLICK)?.({ position: new Cartesian2(x, y) }),
    hover: () =>
      actions.get(ScreenSpaceEventType.MOUSE_MOVE)?.({ endPosition: new Cartesian2(10, 10) }),
    get queries() {
      return queries;
    },
    get highlights() {
      return highlights;
    },
    get destroyed() {
      return destroyed;
    },
  };
}

it("selects the first eligible hit, even when a disabled popup is topmost", () => {
  const f = setup();
  assert.equal(f.document.querySelector("canvas")!.style.cursor, "crosshair");
  f.click();
  assert.equal(useAppStore.getState().selectedLayerId, "1");
  assert.equal(useAppStore.getState().selectedFeatureId, "0");
  assert.equal(f.document.querySelectorAll(".geolibre-identify-popup-root").length, 2);
  const button = f.document.querySelector("button")!;
  assert.equal(button.getAttribute("aria-label"), "Fermer");
  assert.equal(button.getAttribute("type"), "button");
  button.click();
  assert.equal(f.document.querySelector(".geolibre-identify-popup"), null);
});

it("clears the previous highlight when a later Identify click misses", () => {
  const f = setup();
  f.click();
  assert.equal(useAppStore.getState().selectedFeatureId, "0");
  assert.ok(f.document.querySelector(".geolibre-identify-popup"));

  f.setIdentifyHits(false);
  f.click();

  assert.equal(useAppStore.getState().selectedFeatureId, null);
  assert.deepEqual(useAppStore.getState().selectedFeatureIds, []);
  assert.equal(f.document.querySelector(".geolibre-identify-popup"), null);
});

it("replaces the selection and popup on a second successful Identify click", () => {
  const f = setup();
  f.click();
  f.setIdentifyFeatureId("next");
  f.click();

  assert.equal(useAppStore.getState().selectedFeatureId, "next");
  assert.equal(f.document.querySelectorAll(".geolibre-identify-popup").length, 1);
  assert.equal(f.document.querySelectorAll(".geolibre-identify-popup-root").length, 2);
});

it("flips a wide identify popup away from a point near the canvas edge", () => {
  const f = setup();
  f.clickAt(450, 250);
  const popup = f.document.querySelector<HTMLElement>(".geolibre-identify-popup")!;
  assert.equal(popup.style.maxWidth, "min(280px, 80%)");
  assert.equal(popup.style.left, "158px");
  assert.equal(popup.style.top, "262px");
});

it("keeps the Identify cursor in sync with the active tool", () => {
  const f = setup();
  const canvas = f.document.querySelector("canvas")!;
  assert.equal(canvas.style.cursor, "crosshair");
  useAppStore.setState({ identifyLayerId: null });
  assert.equal(canvas.style.cursor, "");
  useAppStore.setState({ identifyLayerId: IDENTIFY_ALL_LAYERS_ID });
  assert.equal(canvas.style.cursor, "crosshair");
  cleanup!();
  cleanup = undefined;
  assert.equal(canvas.style.cursor, "");
});

it("publishes cursor coordinates even with Identify active and honours elevation preferences", () => {
  const f = setup();
  const preferences = useAppStore.getState().preferences;
  useAppStore.setState({
    preferences: { ...preferences, map: { ...preferences.map, showPointerElevation: true } },
  });
  f.hover();
  f.flush();
  assert.deepEqual(useAppStore.getState().pointerCoords, [-83.9, 35.9]);
  assert.equal(useAppStore.getState().pointerElevation, -12);
  assert.equal(f.queries, 0);
  useAppStore.setState({
    preferences: { ...preferences, map: { ...preferences.map, showPointerElevation: false } },
  });
  assert.equal(useAppStore.getState().pointerElevation, null);
  f.setPointer(null);
  f.hover();
  f.flush();
  assert.equal(useAppStore.getState().pointerCoords, null);
});

it("clears cursor state and queued movement on pointer exit and renderer teardown", () => {
  const f = setup();
  f.hover();
  f.flush();
  f.hover();
  f.document.querySelector("canvas")!.dispatchEvent(new window.Event("mouseleave"));
  assert.equal(f.frames.size, 0);
  assert.equal(useAppStore.getState().pointerCoords, null);
  f.hover();
  f.flush();
  cleanup!();
  cleanup = undefined;
  assert.equal(useAppStore.getState().pointerCoords, null);
  assert.equal(useAppStore.getState().pointerElevation, null);
});

it("blanks the readout while the camera moves and restores it where the cursor rests", () => {
  const f = setup();
  f.hover();
  f.flush();
  f.camera.moveStart.raiseEvent();
  assert.equal(useAppStore.getState().pointerCoords, null);
  f.camera.moveEnd.raiseEvent();
  assert.deepEqual(useAppStore.getState().pointerCoords, [-83.9, 35.9]);
  // Once the pointer has left the canvas there is nothing to restore.
  f.document.querySelector("canvas")!.dispatchEvent(new window.Event("mouseleave"));
  f.camera.moveEnd.raiseEvent();
  assert.equal(useAppStore.getState().pointerCoords, null);
});

it("does not query or select on a click when Identify is off", () => {
  const f = setup();
  useAppStore.setState({ identifyLayerId: null });
  f.click();
  assert.equal(f.queries, 0);
  assert.equal(useAppStore.getState().selectedFeatureId, null);
  assert.equal(f.document.querySelector(".geolibre-identify-popup"), null);
});

it("cancels queued hover and detaches handlers and subscriptions on teardown", () => {
  const f = setup();
  useAppStore.setState({ identifyLayerId: null });
  f.hover();
  assert.equal(f.frames.size, 1);
  cleanup!();
  cleanup = undefined;
  assert.equal(f.frames.size, 0);
  assert.equal(f.destroyed, true);
  assert.equal(f.camera.moveStart.numberOfListeners, 0);
  assert.equal(f.camera.moveEnd.numberOfListeners, 0);
  const before = f.highlights;
  useAppStore.getState().selectFeature("after-destroy");
  assert.equal(f.highlights, before);
});
