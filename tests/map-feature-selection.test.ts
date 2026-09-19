import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { useAppStore } from "@geolibre/core";
import {
  attachFeatureSelection,
  type FeatureSelectionMap,
  type FeatureSelectionState,
} from "../packages/map/src/map-feature-selection";
import {
  CAMERA_HANDLERS,
  FEATURE_SELECTION_EVENT,
} from "../packages/map/src/feature-selection";
import { geojsonLayer } from "./helpers/layer-fixtures";

type MapListener = (event: never) => void;

function withSelectionHarness(
  body: (harness: ReturnType<typeof makeHarness>) => void
): void {
  const dom = parseHTML(
    "<html><body><div id='map'><canvas></canvas></div></body></html>"
  );
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    Event: globalThis.Event,
    CustomEvent: globalThis.CustomEvent,
  };
  Object.assign(globalThis, {
    document: dom.document,
    window: dom.window,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
  });
  try {
    body(makeHarness(dom.document));
  } finally {
    Object.assign(globalThis, previous);
    useAppStore.setState({
      layers: [],
      layerGroups: [],
      selectedLayerId: null,
      selectedFeatureId: null,
      selectedFeatureIds: [],
    });
  }
}

function makeHarness(document: Document) {
  const container = document.querySelector("#map") as HTMLElement;
  const canvas = container.querySelector("canvas") as HTMLCanvasElement;
  canvas.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
    } as DOMRect);
  const listeners = new Map<string, Set<MapListener>>();
  const cameraEnabled = new Map(CAMERA_HANDLERS.map((name) => [name, true]));
  const map = {
    getCanvas: () => canvas,
    getContainer: () => container,
    unproject: ([x, y]: [number, number]) => ({ lng: x, lat: y }),
    on: (type: string, listener: MapListener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    off: (type: string, listener: MapListener) =>
      listeners.get(type)?.delete(listener),
    ...Object.fromEntries(
      CAMERA_HANDLERS.map((name) => [
        name,
        {
          isEnabled: () => cameraEnabled.get(name)!,
          disable: () => cameraEnabled.set(name, false),
          enable: () => cameraEnabled.set(name, true),
        },
      ])
    ),
  } as unknown as FeatureSelectionMap;
  const fire = (
    type: string,
    point: { x: number; y: number },
    modifiers = {}
  ) => {
    const event = {
      point,
      originalEvent: { shiftKey: false, altKey: false, ...modifiers },
      preventDefault() {},
    };
    for (const listener of listeners.get(type) ?? []) listener(event as never);
  };
  return { map, fire, listeners, cameraEnabled, canvas, container };
}

function seedLayer(): void {
  useAppStore.setState({
    layers: [
      geojsonLayer({
        id: "countries",
        geojson: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              id: "inside",
              properties: {},
              geometry: { type: "Point", coordinates: [1, 1] },
            },
            {
              type: "Feature",
              id: "outside",
              properties: {},
              geometry: { type: "Point", coordinates: [5, 5] },
            },
          ],
        },
      }),
    ],
    layerGroups: [],
    selectedLayerId: null,
    selectedFeatureId: null,
    selectedFeatureIds: [],
  });
}

function requestSelection(shape: "single" | "rectangle"): void {
  window.dispatchEvent(
    new CustomEvent(FEATURE_SELECTION_EVENT, {
      detail: { layerId: "countries", shape },
    })
  );
}

describe("attachFeatureSelection", () => {
  it("begins click selection, applies a match, and fully detaches", () => {
    withSelectionHarness(
      ({ map, fire, listeners, cameraEnabled, canvas, container }) => {
        seedLayer();
        const state: FeatureSelectionState = {
          active: { current: false },
          cancel: { current: null },
        };
        const detach = attachFeatureSelection(map, {
          state,
          featureIdAtPoint: () => "inside",
        });

        requestSelection("single");
        assert.equal(state.active.current, true);
        assert.equal(cameraEnabled.get("boxZoom"), false);
        assert.equal(canvas.style.cursor, "crosshair");
        assert.ok(container.querySelector("svg"));

        fire("click", { x: 1, y: 1 });
        assert.equal(state.active.current, true, "click selection stays armed");
        assert.equal(useAppStore.getState().selectedLayerId, "countries");
        assert.deepEqual(useAppStore.getState().selectedFeatureIds, ["inside"]);

        detach();
        assert.equal(state.active.current, false);
        assert.equal(state.cancel.current, null);
        assert.equal(cameraEnabled.get("boxZoom"), true);
        assert.equal(canvas.style.cursor, "");
        assert.equal(container.querySelector("svg"), null);
        assert.ok(
          [...listeners.values()].every((registered) => registered.size === 0)
        );
      }
    );
  });

  it("finishes a rectangle as a one-shot gesture and restores every camera handler", () => {
    withSelectionHarness(
      ({ map, fire, listeners, cameraEnabled, container }) => {
        seedLayer();
        const state: FeatureSelectionState = {
          active: { current: false },
          cancel: { current: null },
        };
        const detach = attachFeatureSelection(map, {
          state,
          featureIdAtPoint: () => null,
        });

        requestSelection("rectangle");
        assert.ok(
          CAMERA_HANDLERS.every((name) => cameraEnabled.get(name) === false)
        );
        fire("mousedown", { x: 0, y: 0 });
        fire("mousemove", { x: 2, y: 2 });
        fire("mouseup", { x: 2, y: 2 });

        assert.deepEqual(useAppStore.getState().selectedFeatureIds, ["inside"]);
        assert.equal(state.active.current, false);
        assert.equal(container.querySelector("svg"), null);
        assert.ok(
          CAMERA_HANDLERS.every((name) => cameraEnabled.get(name) === true)
        );
        assert.ok(
          [...listeners.values()].every((registered) => registered.size === 0)
        );
        detach();
      }
    );
  });
});
