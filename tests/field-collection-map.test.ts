import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { MapEngine, MapRenderSurface } from "@geolibre/map";
import {
  createFieldCollectionMarker,
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
      surface.unproject = () => null;
      assert.equal(fieldCollectionEventLngLat(surface, { clientX: 14, clientY: 26 }), null);
    });
  });

  it("ignores clicks that have no map location", () => {
    withDom((document, window) => {
      const { canvas, engine, surface } = harness(document);
      surface.unproject = () => null;
      let clicks = 0;
      const stop = listenForFieldCollectionClicks(engine, {
        onClick: () => clicks++,
        onDoubleClick: () => clicks++,
      });
      for (const type of ["click", "dblclick"]) {
        const event = new window.Event(type, { bubbles: true });
        Object.assign(event, { clientX: 18, clientY: 29 });
        canvas.dispatchEvent(event);
      }
      assert.equal(clicks, 0);
      stop();
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

      for (const [type, clientX, clientY, pointerId] of [
        ["pointerdown", 20, 30, 1],
        ["pointermove", 80, 90, 2],
        ["pointerup", 20, 30, 1],
      ] as const) {
        const pointer = new window.Event(type, { bubbles: true });
        Object.assign(pointer, { clientX, clientY, pointerId });
        canvas.dispatchEvent(pointer);
      }
      canvas.dispatchEvent(event);
      assert.deepEqual(clicks, [
        [8, 9],
        [8, 9],
      ]);

      for (const [type, clientX, clientY] of [
        ["pointerdown", 20, 30],
        ["pointermove", 40, 50],
        ["pointerup", 40, 50],
      ] as const) {
        const pointer = new window.Event(type, { bubbles: true });
        Object.assign(pointer, { clientX, clientY, pointerId: 1 });
        canvas.dispatchEvent(pointer);
      }
      const draggedClick = new window.Event("click", { bubbles: true });
      Object.assign(draggedClick, { clientX: 40, clientY: 50 });
      canvas.dispatchEvent(draggedClick);
      assert.deepEqual(clicks, [
        [8, 9],
        [8, 9],
      ]);

      // A pinch: the second finger barely moves, but the click is still suppressed.
      for (const [type, clientX, clientY, pointerId] of [
        ["pointerdown", 20, 30, 1],
        ["pointerdown", 60, 70, 2],
        ["pointerup", 20, 30, 1],
        ["pointerup", 61, 70, 2],
      ] as const) {
        const pointer = new window.Event(type, { bubbles: true });
        Object.assign(pointer, { clientX, clientY, pointerId });
        canvas.dispatchEvent(pointer);
      }
      canvas.dispatchEvent(draggedClick);
      assert.deepEqual(clicks, [
        [8, 9],
        [8, 9],
      ]);

      // A pointer released off the canvas must not make the next tap look multi-touch.
      const down = new window.Event("pointerdown", { bubbles: true });
      Object.assign(down, { clientX: 20, clientY: 30, pointerId: 3 });
      canvas.dispatchEvent(down);
      const upOutside = new window.Event("pointerup", { bubbles: true });
      Object.assign(upOutside, { clientX: 300, clientY: 300, pointerId: 3 });
      document.body.dispatchEvent(upOutside);
      for (const type of ["pointerdown", "pointerup"] as const) {
        const pointer = new window.Event(type, { bubbles: true });
        Object.assign(pointer, { clientX: 18, clientY: 29, pointerId: 4 });
        canvas.dispatchEvent(pointer);
      }
      canvas.dispatchEvent(event);
      assert.deepEqual(clicks, [
        [8, 9],
        [8, 9],
        [8, 9],
      ]);

      stop();
      assert.equal(canvas.style.cursor, "grab");
      canvas.dispatchEvent(event);
      assert.equal(clicks.length, 3);
    });
  });

  it("keeps markers positioned as the camera moves until removed", () => {
    withDom((document) => {
      const { container, engine, moveCamera, wasStopped } = harness(document);
      const marker = createFieldCollectionMarker(engine, "#ef4444");
      assert.ok(marker);
      marker.setLngLat([1, 2]);
      const element = container.querySelector(".maplibregl-marker") as HTMLElement;
      assert.ok(element);
      assert.equal(element.style.transform, "translate(-50%, -50%) translate(10px, 6px)");

      moveCamera(5);
      assert.equal(element.style.transform, "translate(-50%, -50%) translate(15px, 6px)");
      marker.remove();
      assert.equal(container.querySelector(".maplibregl-marker"), null);
      assert.equal(wasStopped(), true);
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
