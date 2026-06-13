import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  maplibreReverseGeocodePlugin,
  REVERSE_GEOCODE_PLUGIN_ID,
  restoreReverseGeocode,
} from "../packages/plugins/src/plugins/maplibre-reverse-geocode";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

/** A minimal fake MapLibre map recording click-listener registration. */
function fakeMap() {
  const handlers: Record<string, Set<(...args: unknown[]) => void>> = {};
  const canvas = { style: { cursor: "grab" } };
  return {
    handlers,
    canvas,
    getCanvas: () => canvas,
    on: (type: string, handler: (...args: unknown[]) => void) => {
      (handlers[type] ??= new Set()).add(handler);
    },
    off: (type: string, handler: (...args: unknown[]) => void) => {
      handlers[type]?.delete(handler);
    },
    clickCount: () => handlers.click?.size ?? 0,
  };
}

function fakeApp(map: ReturnType<typeof fakeMap>): GeoLibreAppAPI {
  return { getMap: () => map } as unknown as GeoLibreAppAPI;
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
    assert.equal(map.canvas.style.cursor, "crosshair");

    maplibreReverseGeocodePlugin.deactivate(app);
    assert.equal(map.clickCount(), 0);
    // The original cursor is restored.
    assert.equal(map.canvas.style.cursor, "grab");
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
});
