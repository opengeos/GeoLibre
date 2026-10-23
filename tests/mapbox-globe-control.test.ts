import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { MapboxGlobeControl } from "../packages/map/src/mapbox-globe-control";
import { isGlobeControlToggleClick } from "../packages/map/src/globe-control-toggle";

// mapbox-gl has no GlobeControl, so the Mapbox renderer gets this stand-in. It
// mirrors MapLibre's control DOM on purpose: the app's stylesheet, its blue
// "globe on" icon override and the click-to-persist selector all key off those
// class names, so the tests pin them rather than treating them as incidental.

type Handler = () => void;

/** The slice of a mapbox-gl map the control touches, with a settable projection. */
function fakeMap(initial: "globe" | "mercator") {
  let projection: string = initial;
  const handlers = new Map<string, Set<Handler>>();
  const calls: string[] = [];
  return {
    calls,
    handlers,
    getProjection: () => ({ name: projection }),
    setProjection: (next: string) => {
      projection = next;
      calls.push(`setProjection:${next}`);
    },
    on: (event: string, handler: Handler) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
    },
    off: (event: string, handler: Handler) => {
      handlers.get(event)?.delete(handler);
    },
    fire: (event: string) => {
      for (const handler of handlers.get(event) ?? []) handler();
    },
  };
}

let restoreGlobals: () => void;

beforeEach(() => {
  const { document, window } = parseHTML("<html><body></body></html>");
  const previous = { document: globalThis.document, window: globalThis.window };
  Object.assign(globalThis, { document, window });
  restoreGlobals = () => Object.assign(globalThis, previous);
});

afterEach(() => restoreGlobals());

describe("MapboxGlobeControl", () => {
  it("renders MapLibre's globe button markup so its stylesheet and click selector apply", () => {
    const map = fakeMap("mercator");
    const container = new MapboxGlobeControl().onAdd(map);
    assert.equal(container.className, "maplibregl-ctrl maplibregl-ctrl-group mapboxgl-ctrl");
    const button = container.querySelector("button")!;
    assert.equal(button.type, "button");
    assert.ok(button.classList.contains("maplibregl-ctrl-globe"));
    assert.ok(!button.classList.contains("maplibregl-ctrl-globe-enabled"));
    assert.equal(button.title, "Enable globe");
    assert.equal(button.getAttribute("aria-label"), "Enable globe");
    const icon = button.querySelector(".maplibregl-ctrl-icon")!;
    assert.equal(icon.getAttribute("aria-hidden"), "true");
    // The same selector MapCanvas uses to persist MapLibre's GlobeControl
    // clicks must match here, on the button and on the icon inside it.
    assert.equal(isGlobeControlToggleClick(button), true);
    assert.equal(isGlobeControlToggleClick(icon), true);
  });

  it("toggles the projection on click and swaps the button state", () => {
    const map = fakeMap("mercator");
    const control = new MapboxGlobeControl();
    const button = control.onAdd(map).querySelector("button")!;
    button.click();
    assert.deepEqual(map.calls, ["setProjection:globe"]);
    assert.equal(control.isGlobe(), true);
    assert.ok(button.classList.contains("maplibregl-ctrl-globe-enabled"));
    assert.ok(!button.classList.contains("maplibregl-ctrl-globe"));
    assert.equal(button.title, "Disable globe");
    assert.equal(isGlobeControlToggleClick(button), true);
    button.click();
    assert.deepEqual(map.calls, ["setProjection:globe", "setProjection:mercator"]);
    assert.ok(button.classList.contains("maplibregl-ctrl-globe"));
    assert.equal(button.title, "Enable globe");
  });

  it("starts from the map's live projection and follows changes made elsewhere", () => {
    const map = fakeMap("globe");
    const control = new MapboxGlobeControl({ enableLabel: "On", disableLabel: "Off" });
    const button = control.onAdd(map).querySelector("button")!;
    assert.ok(button.classList.contains("maplibregl-ctrl-globe-enabled"));
    assert.equal(button.title, "Off");
    // A projection applied by the engine (Settings dialog, project load) is
    // reported through update(); a new style's projection arrives on style.load.
    map.setProjection("mercator");
    assert.ok(button.classList.contains("maplibregl-ctrl-globe-enabled"));
    control.update();
    assert.ok(button.classList.contains("maplibregl-ctrl-globe"));
    assert.equal(button.title, "On");
    map.setProjection("globe");
    map.fire("style.load");
    assert.ok(button.classList.contains("maplibregl-ctrl-globe-enabled"));
    map.setProjection("mercator");
    map.fire("styledata");
    assert.ok(button.classList.contains("maplibregl-ctrl-globe"));
  });

  it("detaches everything on remove", () => {
    const map = fakeMap("mercator");
    const control = new MapboxGlobeControl();
    const container = control.onAdd(map);
    document.body.appendChild(container);
    const button = container.querySelector("button")!;
    control.onRemove();
    assert.equal(container.isConnected, false);
    assert.equal(map.handlers.get("styledata")?.size ?? 0, 0);
    assert.equal(map.handlers.get("style.load")?.size ?? 0, 0);
    button.click();
    assert.deepEqual(map.calls, []);
    assert.equal(control.isGlobe(), false);
    // update() after removal is a no-op rather than a crash.
    control.update();
  });
});
