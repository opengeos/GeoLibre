import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setGeocodingFetch } from "@geolibre/core";
import {
  maplibreReverseGeocodePlugin,
  REVERSE_GEOCODE_PLUGIN_ID,
  restoreReverseGeocode,
} from "../packages/plugins/src/plugins/maplibre-reverse-geocode";
import type { MapEngineClient } from "../packages/map/src/engine/types";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

/** A minimal fake MapEngine client recording click-listener registration. */
function fakeMap() {
  const handlers: Record<string, Set<(...args: unknown[]) => void>> = {};
  const element = { style: { cursor: "grab" } } as HTMLElement;
  const popupCloseHandlers = new Map<string, () => void>();
  let popupShowCount = 0;
  return {
    handlers,
    element,
    viewport: { getElement: () => element },
    interactions: {
      showPopup: (options: { id: string; onClose?: () => void }) => {
        popupShowCount += 1;
        popupCloseHandlers.get(options.id)?.();
        if (options.onClose) popupCloseHandlers.set(options.id, options.onClose);
      },
      closePopup: (id: string) => {
        popupCloseHandlers.get(id)?.();
        popupCloseHandlers.delete(id);
      },
    },
    on: (type: string, handler: (...args: unknown[]) => void) => {
      (handlers[type] ??= new Set()).add(handler);
      return () => handlers[type]?.delete(handler);
    },
    clickCount: () => handlers.click?.size ?? 0,
    emitClick: (lngLat: [number, number]) => {
      for (const handler of handlers.click ?? []) handler({ lngLat });
    },
    closePopup: (id: string) => popupCloseHandlers.get(id)?.(),
    popupShowCount: () => popupShowCount,
  } as unknown as MapEngineClient & {
    readonly handlers: Record<string, Set<(...args: unknown[]) => void>>;
    readonly element: HTMLElement;
    clickCount(): number;
    emitClick(lngLat: [number, number]): void;
    closePopup(id: string): void;
    popupShowCount(): number;
  };
}

function fakeApp(map: ReturnType<typeof fakeMap>): GeoLibreAppAPI {
  return { map } as GeoLibreAppAPI;
}

describe("maplibreReverseGeocodePlugin", () => {
  it("is a Controls toggle that is off by default", () => {
    assert.equal(maplibreReverseGeocodePlugin.id, REVERSE_GEOCODE_PLUGIN_ID);
    assert.equal(maplibreReverseGeocodePlugin.activeByDefault, undefined);
    assert.equal(typeof maplibreReverseGeocodePlugin.activate, "function");
    assert.equal(typeof maplibreReverseGeocodePlugin.deactivate, "function");
  });

  it("registers a map click handler on activate and removes it on deactivate", () => {
    const map = fakeMap();
    const app = fakeApp(map);

    maplibreReverseGeocodePlugin.activate(app);
    assert.equal(map.clickCount(), 1);
    assert.equal(map.element.style.cursor, "crosshair");

    maplibreReverseGeocodePlugin.deactivate(app);
    assert.equal(map.clickCount(), 0);
    // The original cursor is restored.
    assert.equal(map.element.style.cursor, "grab");
  });

  it("restoreReverseGeocode(true) binds once and is idempotent for the same map", () => {
    const map = fakeMap();
    const app = fakeApp(map);

    restoreReverseGeocode(app, true);
    assert.equal(map.clickCount(), 1);
    // A second restore against the same map must not double-bind.
    restoreReverseGeocode(app, true);
    assert.equal(map.clickCount(), 1);

    restoreReverseGeocode(app, false);
    assert.equal(map.clickCount(), 0);
  });

  it("rebinds to a new map object after a map re-init", () => {
    const first = fakeMap();
    restoreReverseGeocode(fakeApp(first), true);
    assert.equal(first.clickCount(), 1);

    const second = fakeMap();
    restoreReverseGeocode(fakeApp(second), true);
    // The handler moves to the new map and leaves the old one clean.
    assert.equal(first.clickCount(), 0);
    assert.equal(second.clickCount(), 1);

    restoreReverseGeocode(fakeApp(second), false);
  });

  it("does not reopen a user-closed popup when its lookup resolves", async () => {
    const map = fakeMap();
    const app = fakeApp(map);
    let resolveFetch: ((response: Response) => void) | null = null;
    const originalDocument = globalThis.document;
    globalThis.document = {
      createElement: () =>
        ({
          style: {},
          appendChild: () => undefined,
          textContent: "",
        }) as unknown as HTMLElement,
    } as Document;
    setGeocodingFetch(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    try {
      maplibreReverseGeocodePlugin.activate(app);
      map.emitClick([8.55, 47.37]);
      assert.equal(map.popupShowCount(), 1);

      map.closePopup("geolibre-reverse-geocode-popup");
      assert.ok(resolveFetch);
      resolveFetch(new Response(JSON.stringify({ display_name: "Zürich", address: {} })));
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.equal(map.popupShowCount(), 1);
    } finally {
      maplibreReverseGeocodePlugin.deactivate(app);
      setGeocodingFetch(null);
      globalThis.document = originalDocument;
    }
  });
});
