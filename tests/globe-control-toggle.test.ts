import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { GlobeControl, type Map as MapLibreMap } from "maplibre-gl";
import {
  GLOBE_CONTROL_TOGGLE_SELECTOR,
  isGlobeControlToggleClick,
} from "../packages/map/src/globe-control-toggle";

/**
 * `GLOBE_CONTROL_TOGGLE_SELECTOR` mirrors class names that are internal to
 * `maplibre-gl` and not exported, so nothing but this file notices if they move.
 * Rather than restating the strings, these build a real `GlobeControl` and ask
 * it for its button, so a `maplibre-gl` bump that renames or restructures the
 * control fails here instead of silently ending projection persistence.
 */

let restoreGlobals: () => void;

/** A map stub with the surface `GlobeControl.onAdd` touches. */
function fakeMap(projection: "globe" | "mercator") {
  return {
    getProjection: () => ({ type: projection }),
    _getUIString: () => "Toggle globe",
    on: () => {},
    off: () => {},
  } as unknown as MapLibreMap;
}

/** The DOM `GlobeControl` renders for a map currently in `projection`. */
function globeControlContainer(projection: "globe" | "mercator"): Element {
  return new GlobeControl().onAdd(fakeMap(projection));
}

beforeEach(() => {
  // `GlobeControl.onAdd` builds its DOM through the ambient `document`.
  const { document, window } = parseHTML("<html><body></body></html>");
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  Object.assign(globalThis, { document, window });
  restoreGlobals = () => {
    Object.assign(globalThis, { document: previousDocument, window: previousWindow });
  };
});

afterEach(() => restoreGlobals());

describe("the maplibre-gl GlobeControl class mirror", () => {
  it("matches the toggle button in both projections", () => {
    // The control labels its button by what a click would *do*, swapping the
    // class on every projection change, so both spellings have to be covered.
    for (const projection of ["mercator", "globe"] as const) {
      const container = globeControlContainer(projection);
      assert.ok(
        container.querySelector(GLOBE_CONTROL_TOGGLE_SELECTOR),
        `no GlobeControl toggle matched ${GLOBE_CONTROL_TOGGLE_SELECTOR} in ${projection} (rendered ${container.innerHTML})`,
      );
    }
  });

  it("matches a click on the icon inside the button", () => {
    // The button holds a `<span>` icon that covers it, so the click target is
    // usually the span rather than the button itself.
    const icon = globeControlContainer("mercator").querySelector("span");
    assert.ok(icon, "GlobeControl no longer renders an icon inside its button");
    assert.equal(isGlobeControlToggleClick(icon), true);
  });

  it("ignores clicks elsewhere in the map container", () => {
    const { document } = parseHTML(
      '<div class="maplibregl-ctrl"><button class="maplibregl-ctrl-terrain"></button></div>',
    );
    assert.equal(isGlobeControlToggleClick(document.querySelector("button")), false);
    assert.equal(isGlobeControlToggleClick(null), false);
    // A non-Element target (the container itself receives events too).
    assert.equal(isGlobeControlToggleClick({} as EventTarget), false);
  });
});
