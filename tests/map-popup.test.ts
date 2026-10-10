import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";

const { document } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document });

import * as maplibregl from "maplibre-gl";
import { createMapPopup } from "../packages/plugins/src/plugins/map-popup";

/**
 * A map that is not MapLibre's (the Mapbox map, or a control facade): it
 * projects longitude/latitude straight to pixels and records its listeners.
 */
function fakeMap(width = 400, height = 300) {
  const container = document.createElement("div");
  Object.defineProperty(container, "clientWidth", { value: width });
  Object.defineProperty(container, "clientHeight", { value: height });
  const listeners = new Map<string, Set<() => void>>();
  return {
    container,
    listeners,
    getCanvasContainer: () => container,
    project: (lngLat: [number, number]) => ({ x: lngLat[0], y: lngLat[1] }),
    on: (type: string, fn: () => void) =>
      void (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn),
    off: (type: string, fn: () => void) => void listeners.get(type)?.delete(fn),
    fire: (type: string) => listeners.get(type)?.forEach((fn) => fn()),
  };
}

const asMap = (map: ReturnType<typeof fakeMap>) => map as unknown as maplibregl.Map;

describe("createMapPopup", () => {
  it("places a popup above its coordinate on a map that is not MapLibre's", () => {
    const map = fakeMap();
    const popup = createMapPopup(asMap(map), { offset: 8, className: "extra" });
    assert.ok(!(popup instanceof maplibregl.Popup));
    popup.setLngLat([100, 50]).setText("hello").addTo(asMap(map));
    const root = map.container.firstElementChild as HTMLElement;
    assert.ok(root.classList.contains("maplibregl-popup"));
    assert.ok(root.classList.contains("mapboxgl-popup-anchor-bottom"));
    assert.ok(root.classList.contains("extra"));
    assert.equal(root.querySelector(".maplibregl-popup-content")?.textContent, "hello");
    assert.equal(root.style.transform, "translate(-50%, -100%) translate(100px, 42px)");
    assert.equal(popup.isOpen(), true);
  });

  it("follows the camera on every frame and hides off the canvas", () => {
    const map = fakeMap();
    const popup = createMapPopup(asMap(map)).setLngLat([10, 20]).addTo(asMap(map));
    const root = map.container.firstElementChild as HTMLElement;
    // The globe's control map answers far off screen for a point it cannot place.
    map.project = () => ({ x: -1e6, y: -1e6 });
    map.fire("render");
    assert.equal(root.style.display, "none");
    map.project = (lngLat: [number, number]) => ({ x: lngLat[0] + 5, y: lngLat[1] });
    map.fire("move");
    assert.equal(root.style.display, "");
    assert.equal(root.style.transform, "translate(-50%, -100%) translate(15px, 20px)");
    popup.remove();
  });

  it("closes from its close button and drops every listener", () => {
    const map = fakeMap();
    const popup = createMapPopup(asMap(map), { closeButton: true })
      .setLngLat([1, 1])
      .setDOMContent(document.createElement("span"))
      .addTo(asMap(map));
    const close = map.container.querySelector(".maplibregl-popup-close-button") as HTMLElement;
    close.click();
    assert.equal(popup.isOpen(), false);
    assert.equal(map.container.childElementCount, 0);
    for (const set of map.listeners.values()) assert.equal(set.size, 0);
  });
});
