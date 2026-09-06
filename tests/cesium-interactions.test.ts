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
        return layers.map((layer) => ({
          layerId: layer.id,
          featureId: "0",
          properties: { name: layer.name },
          geometry: null,
        }));
      },
      highlightFeature: () => {
        highlights++;
      },
      readView: () => ({ zoom: 3 }),
    } as never,
    () => "Fermer",
  );
  return {
    document,
    camera,
    frames,
    click: () =>
      actions.get(ScreenSpaceEventType.LEFT_CLICK)?.({ position: new Cartesian2(10, 10) }),
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
