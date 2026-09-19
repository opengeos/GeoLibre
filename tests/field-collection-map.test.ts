import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { MapEngine, MapRenderSurface } from "@geolibre/map";
import {
  createFieldCollectionPreview,
  fieldCollectionEventLngLat,
  listenForFieldCollectionClicks,
} from "../apps/geolibre-desktop/src/lib/field-collection-map";

function withDom(body: (document: Document, window: Window) => void): void {
  const dom = parseHTML("<html><body><div id='map'><canvas></canvas></div></body></html>");
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    Event: globalThis.Event,
    ResizeObserver: globalThis.ResizeObserver,
  };
  class TestResizeObserver {
    observe() {}
    disconnect() {}
    unobserve() {}
  }
  Object.assign(globalThis, {
    document: dom.document,
    window: dom.window,
    Event: dom.window.Event,
    ResizeObserver: TestResizeObserver,
  });
  try {
    body(dom.document, dom.window as unknown as Window);
  } finally {
    Object.assign(globalThis, previous);
  }
}

function harness(document: Document) {
  const container = document.querySelector("#map") as HTMLElement;
  const canvas = container.querySelector("canvas") as HTMLCanvasElement;
  canvas.getBoundingClientRect = () => ({ left: 10, top: 20, width: 200, height: 100 }) as DOMRect;
  let projectionOffset = 0;
  let cameraListener = () => {};
  let stopped = false;
  const surface: MapRenderSurface = {
    getCanvas: () => canvas,
    getContainer: () => container,
    getBearing: () => 0,
    project: ([lng, lat]) => ({ x: lng * 10 + projectionOffset, y: lat * 10 }),
    unproject: ([x, y]) => ({ lng: x, lat: y }),
    redraw: () => {},
  };
  const engine = {
    getRenderSurface: () => surface,
    onCameraMove: (listener: () => void) => {
      cameraListener = listener;
      return () => {
        stopped = true;
      };
    },
  } as unknown as MapEngine;
  return {
    canvas,
    container,
    engine,
    surface,
    moveCamera(offset: number) {
      projectionOffset = offset;
      cameraListener();
    },
    wasStopped: () => stopped,
  };
}

describe("Field Collection renderer-neutral map bridge", () => {
  it("converts pointer pixels through the active render surface", () => {
    withDom((document) => {
      const { surface } = harness(document);
      assert.deepEqual(fieldCollectionEventLngLat(surface, { clientX: 14, clientY: 26 }), [4, 6]);
    });
  });

  it("captures clicks and restores the canvas cursor on teardown", () => {
    withDom((document, window) => {
      const { canvas, engine } = harness(document);
      canvas.style.cursor = "grab";
      const clicks: Array<[number, number]> = [];
      const stop = listenForFieldCollectionClicks(engine, {
        onClick: (coordinate) => clicks.push(coordinate),
      });
      assert.equal(canvas.style.cursor, "crosshair");
      const event = new window.Event("click", { bubbles: true });
      Object.assign(event, { clientX: 18, clientY: 29 });
      canvas.dispatchEvent(event);
      assert.deepEqual(clicks, [[8, 9]]);

      for (const [type, clientX, clientY] of [
        ["pointerdown", 20, 30],
        ["pointermove", 40, 50],
        ["pointerup", 40, 50],
      ] as const) {
        const pointer = new window.Event(type, { bubbles: true });
        Object.assign(pointer, { clientX, clientY });
        canvas.dispatchEvent(pointer);
      }
      const draggedClick = new window.Event("click", { bubbles: true });
      Object.assign(draggedClick, { clientX: 40, clientY: 50 });
      canvas.dispatchEvent(draggedClick);
      assert.deepEqual(clicks, [[8, 9]]);

      stop();
      assert.equal(canvas.style.cursor, "grab");
      canvas.dispatchEvent(event);
      assert.deepEqual(clicks, [[8, 9]]);
    });
  });

  it("draws and reprojects a polygon preview until removed", () => {
    withDom((document) => {
      const { container, engine, moveCamera, wasStopped } = harness(document);
      const preview = createFieldCollectionPreview(engine, "#ef4444");
      assert.ok(preview);
      preview.setGeometry("polygon", [
        [1, 1],
        [2, 1],
        [2, 2],
      ]);
      const svg = container.querySelector("[data-field-collection-preview='true']")!;
      assert.equal(svg.querySelector("polygon")?.getAttribute("points"), "10,10 20,10 20,20");
      assert.equal(
        svg.querySelector("polyline")?.getAttribute("points"),
        "10,10 20,10 20,20 10,10",
      );
      assert.equal(svg.querySelectorAll("circle").length, 3);

      moveCamera(5);
      assert.equal(svg.querySelector("polygon")?.getAttribute("points"), "15,10 25,10 25,20");
      assert.equal(
        svg.querySelector("polyline")?.getAttribute("points"),
        "15,10 25,10 25,20 15,10",
      );
      preview.remove();
      assert.equal(container.querySelector("[data-field-collection-preview='true']"), null);
      assert.equal(wasStopped(), true);
    });
  });
});
