import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { IControl, Map as MapLibreMap } from "maplibre-gl";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";
import { getStyleMap } from "../packages/plugins/src/plugins/style-map";
import {
  mountMapControlInPanel,
  unmountMapControlFromPanel,
} from "../packages/plugins/src/plugins/dockable-map-control";

// The Plugins menu greyed out most plugins on the Mapbox renderer because they
// reached the map only through `app.getMap()`, which the Mapbox engine leaves
// null on purpose. `getStyleMap` is the shared door for plugins that declare
// Mapbox support, and the docked-panel bridge every Web Services panel mounts
// through is its first consumer.

describe("getStyleMap", () => {
  it("prefers the MapLibre map, falls back to the Mapbox map, else null", () => {
    const maplibre = { kind: "maplibre" } as unknown as MapLibreMap;
    const mapbox = { kind: "mapbox" };
    assert.equal(getStyleMap(null), null);
    assert.equal(getStyleMap({} as GeoLibreAppAPI), null);
    assert.equal(
      getStyleMap({
        getMap: () => null,
        getMapboxMap: () => null,
      } as unknown as GeoLibreAppAPI),
      null,
    );
    assert.equal(
      getStyleMap({
        getMap: () => maplibre,
        getMapboxMap: () => mapbox,
      } as unknown as GeoLibreAppAPI),
      maplibre,
    );
    assert.equal(
      getStyleMap({
        getMap: () => null,
        getMapboxMap: () => mapbox,
      } as unknown as GeoLibreAppAPI),
      mapbox,
    );
  });
});

describe("docked map controls on a Mapbox-only host", () => {
  function makeHost() {
    const { document, HTMLElement } = parseHTML("<!doctype html><html><body></body></html>");
    // The bridge tells panel content from the toolbar button with instanceof.
    (globalThis as { HTMLElement?: unknown }).HTMLElement = HTMLElement;
    const mapContainer = document.createElement("div");
    document.body.appendChild(mapContainer);
    const handlers = new Map<string, Set<() => void>>();
    const map = {
      getContainer: () => mapContainer,
      on: (event: string, handler: () => void) => {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event)!.add(handler);
      },
      off: (event: string, handler: () => void) => handlers.get(event)?.delete(handler),
    };
    const app = {
      getMap: () => null,
      getMapboxMap: () => map,
    } as unknown as GeoLibreAppAPI;
    return { document, mapContainer, map, app, handlers };
  }

  it("mounts the control's panel into the dock through the Mapbox map", () => {
    const { document, mapContainer, map, app } = makeHost();
    const dock = document.createElement("div");
    const seen: unknown[] = [];
    const control: IControl = {
      onAdd: (added) => {
        seen.push(added);
        // The Web Services controls append their floating panel as a sibling
        // under the map container and return only the toolbar button.
        const panel = document.createElement("div");
        panel.className = "service-panel";
        mapContainer.appendChild(panel);
        return document.createElement("button") as unknown as HTMLElement;
      },
      onRemove: (removed) => {
        seen.push(removed);
      },
    };
    const cleanup = mountMapControlInPanel(app, control, dock as unknown as HTMLElement);
    assert.ok(cleanup, "the control mounted although only a Mapbox map is exposed");
    assert.deepEqual(seen, [map], "onAdd received the Mapbox map");
    assert.equal(dock.querySelector(".service-panel") !== null, true);
    assert.ok(dock.classList.contains("geolibre-docked-map-control"));
    unmountMapControlFromPanel(control);
    assert.deepEqual(seen, [map, map], "onRemove received the same map");
    assert.equal(dock.children.length, 0);
  });

  it("reports a mount failure when neither 2D map is available", () => {
    const { document } = makeHost();
    const dock = document.createElement("div");
    let failed = false;
    const cleanup = mountMapControlInPanel(
      {
        getMap: () => null,
        getMapboxMap: () => null,
      } as unknown as GeoLibreAppAPI,
      {
        onAdd: () => document.createElement("div") as unknown as HTMLElement,
        onRemove: () => {},
      },
      dock as unknown as HTMLElement,
      () => {
        failed = true;
      },
    );
    assert.equal(cleanup, null);
    assert.equal(failed, true);
  });
});
