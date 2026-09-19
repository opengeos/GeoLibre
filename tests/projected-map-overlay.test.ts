import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { MapEngine } from "../packages/map/src/map-engine";
import {
  mountProjectedElement,
  mountProjectedExtent,
} from "../apps/geolibre-desktop/src/lib/projected-map-overlay";

const originalDocument = globalThis.document;
const originalResizeObserver = globalThis.ResizeObserver;

class TestResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  const { document } = parseHTML("<html><body><div id='map'></div></body></html>");
  Object.assign(globalThis, { document, ResizeObserver: TestResizeObserver });
});

afterEach(() => {
  Object.assign(globalThis, {
    document: originalDocument,
    ResizeObserver: originalResizeObserver,
  });
});

function engineHarness() {
  const container = document.querySelector<HTMLElement>("#map")!;
  const listeners = new Set<() => void>();
  const engine = {
    getRenderSurface: () => ({
      getContainer: () => container,
      project: ([lng, lat]: [number, number]) => ({ x: lng * 2, y: lat * 3 }),
    }),
    onCameraMove: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onCameraIdle: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as MapEngine;
  return { container, engine, listeners };
}

describe("projected map overlays", () => {
  it("positions, updates, and removes a renderer-neutral marker", () => {
    const { container, engine, listeners } = engineHarness();
    const element = document.createElement("div");
    const handle = mountProjectedElement(engine, element, [10, 5], "bottom");
    assert.equal(element.style.transform, "translate(20px, 15px) translate(-50%, -100%)");
    assert.equal(element.parentElement, container);

    handle.setCoordinate([4, 6]);
    assert.equal(element.style.transform, "translate(8px, 18px) translate(-50%, -100%)");
    handle.remove();
    assert.equal(element.parentElement, null);
    assert.equal(listeners.size, 0);
  });

  it("updates a projected extent without replacing its SVG", () => {
    const { container, engine, listeners } = engineHarness();
    const handle = mountProjectedExtent(engine, [1, 2, 3, 4], "#2563eb");
    const svg = container.querySelector(".geolibre-collab-viewport")!;
    const polygon = svg.querySelector("polygon")!;
    assert.equal(polygon.getAttribute("points"), "2,6 6,6 6,12 2,12");

    handle.setExtent([2, 3, 4, 5]);
    handle.setColor("#dc2626");
    assert.equal(polygon.getAttribute("points"), "4,9 8,9 8,15 4,15");
    assert.equal(polygon.getAttribute("stroke"), "#dc2626");
    handle.remove();
    assert.equal(svg.parentElement, null);
    assert.equal(listeners.size, 0);
  });
});
