import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  collapseCompactAttribution,
  watchForCompactAttribution,
} from "../packages/map/src/collapsed-attribution-control";

/** Minimal stand-in for the control's container: node:test has no DOM. */
function makeContainer(...initial: string[]) {
  const classes = new Set(initial);
  return {
    classes,
    element: {
      classList: {
        contains: (name: string) => classes.has(name),
        remove: (name: string) => classes.delete(name),
        add: (...names: string[]) => names.forEach((n) => classes.add(n)),
      },
    } as unknown as HTMLElement,
  };
}

/**
 * Install a fake MutationObserver that hands the test the callback, so it can
 * replay MapLibre mutating the container's class list.
 */
function withFakeObserver() {
  let callback = () => {};
  let connected = false;
  const state = {
    // A disconnected observer never fires again, so model that rather than
    // letting a test drive a callback the browser would no longer call.
    fire: () => {
      if (connected) callback();
    },
    disconnects: 0,
    observed: 0,
  };
  class FakeMutationObserver {
    constructor(cb: () => void) {
      callback = cb;
    }
    observe() {
      state.observed += 1;
      connected = true;
    }
    disconnect() {
      state.disconnects += 1;
      connected = false;
    }
  }
  (globalThis as Record<string, unknown>).MutationObserver = FakeMutationObserver;
  return state;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).MutationObserver;
});

describe("collapseCompactAttribution", () => {
  it("does nothing while MapLibre has yet to switch to compact mode", () => {
    const { element, classes } = makeContainer("maplibregl-ctrl-attrib");
    assert.equal(collapseCompactAttribution(element), false);
    assert.deepEqual([...classes], ["maplibregl-ctrl-attrib"]);
  });

  it("collapses the control once MapLibre expands it", () => {
    const { element, classes } = makeContainer("maplibregl-compact", "maplibregl-compact-show");
    assert.equal(collapseCompactAttribution(element), true);
    assert.equal(classes.has("maplibregl-compact-show"), false);
    // Compact mode itself stays on — that is what renders the toggle button.
    assert.equal(classes.has("maplibregl-compact"), true);
  });

  it("reports done for an already-collapsed compact control", () => {
    const { element } = makeContainer("maplibregl-compact");
    assert.equal(collapseCompactAttribution(element), true);
  });
});

describe("watchForCompactAttribution", () => {
  it("collapses the expansion that arrives with the first attribution", () => {
    const observer = withFakeObserver();
    const { element, classes } = makeContainer();

    const unwatch = watchForCompactAttribution(element);
    assert.ok(unwatch, "watches a control that is not yet compact");
    assert.equal(observer.observed, 1);

    // MapLibre adds both classes together once a source reports attribution.
    element.classList.add("maplibregl-compact", "maplibregl-compact-show");
    observer.fire();

    assert.equal(classes.has("maplibregl-compact-show"), false);
    assert.equal(observer.disconnects, 1, "stops watching after the one expansion");
  });

  it("leaves a later user expansion alone", () => {
    const observer = withFakeObserver();
    const { element, classes } = makeContainer();

    watchForCompactAttribution(element);
    element.classList.add("maplibregl-compact", "maplibregl-compact-show");
    observer.fire();

    // The user clicks the toggle; the watch is over, so it stays open.
    element.classList.add("maplibregl-compact-show");
    observer.fire();
    assert.equal(classes.has("maplibregl-compact-show"), true);
  });

  it("skips the watch when the control is already compact", () => {
    const observer = withFakeObserver();
    const { element } = makeContainer("maplibregl-compact", "maplibregl-compact-show");
    assert.equal(watchForCompactAttribution(element), null);
    assert.equal(observer.observed, 0);
  });

  it("degrades gracefully where MutationObserver is unavailable", () => {
    const { element } = makeContainer();
    assert.equal(watchForCompactAttribution(element), null);
  });
});
