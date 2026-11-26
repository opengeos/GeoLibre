import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";

// GeoLibre swaps basemaps with setStyle(..., { diff: false }), which drops every
// source and layer. maplibre-gl-components 0.32 made MeasureControl re-add its
// geometry source and layers, and replay the measurements, on `style.load`;
// GeoLibre used to heal that itself through private methods (GeoLibre#3471).
// This drives the real control so a regression upstream fails here.

describe("MeasureControl after a basemap swap", () => {
  it("re-adds its source and layers and redraws the geometry on style.load", async () => {
    const { document, window } = parseHTML("<!doctype html><html><body></body></html>");
    const globals = globalThis as Record<string, unknown>;
    const previous = { document: globals.document, window: globals.window };
    globals.document = document;
    globals.window = window;
    try {
      const { MeasureControl } = await import("maplibre-gl-components");
      const sources = new Map<string, { setData: (data: unknown) => void }>();
      const layers = new Set<string>();
      const listeners = new Map<string, Set<() => void>>();
      const drawn: unknown[] = [];
      const container = document.createElement("div");
      const map = new Proxy(
        {
          isStyleLoaded: () => true,
          getContainer: () => container,
          getCanvasContainer: () => container,
          getCanvas: () => document.createElement("canvas"),
          addSource: (id: string) => {
            sources.set(id, { setData: (data) => drawn.push(data) });
          },
          getSource: (id: string) => sources.get(id),
          addLayer: (layer: { id: string }) => layers.add(layer.id),
          getLayer: (id: string) => (layers.has(id) ? { id } : undefined),
          on: (type: string, listener: () => void) => {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type)!.add(listener);
          },
          off: (type: string, listener: () => void) => listeners.get(type)?.delete(listener),
          once: () => {},
          getZoom: () => 3,
        } as Record<string, unknown>,
        { get: (target, key) => (key in target ? target[key as string] : () => undefined) },
      );
      const control = new MeasureControl({ collapsed: true });
      control.onAdd(map as never);
      const sourceId = control.getSourceId();
      assert.ok(sources.has(sourceId), "the control adds its source on mount");
      const ownLayers = [...layers];
      assert.ok(ownLayers.length > 0, "and its layers");

      // setStyle without diffing drops everything.
      sources.clear();
      layers.clear();
      drawn.length = 0;
      for (const listener of listeners.get("style.load") ?? []) listener();

      assert.ok(sources.has(sourceId), "the source is back after style.load");
      assert.deepEqual([...layers].sort(), ownLayers.sort(), "and so are its layers");
      assert.ok(drawn.length > 0, "and the geometry is pushed to it again");
      control.onRemove();
      assert.equal(listeners.get("style.load")?.size ?? 0, 0, "onRemove stops listening");
    } finally {
      globals.document = previous.document;
      globals.window = previous.window;
    }
  });
});
