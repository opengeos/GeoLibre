import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import {
  mountMapControlInPanel,
  unmountMapControlFromPanel,
} from "../packages/plugins/src/plugins/dockable-map-control";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

const originalDocument = globalThis.document;
const originalHTMLElement = globalThis.HTMLElement;

afterEach(() => {
  Object.assign(globalThis, {
    document: originalDocument,
    HTMLElement: originalHTMLElement,
  });
});

function installDom() {
  const { document, window } = parseHTML("<html><body><main id='map'></main></body></html>");
  Object.assign(globalThis, { document, HTMLElement: window.HTMLElement });
  return document;
}

function fakeMap(mapContainer: HTMLElement) {
  let removeListener: (() => void) | null = null;
  return {
    getContainer: () => mapContainer,
    on: (type: string, listener: () => void) => {
      if (type === "remove") removeListener = listener;
    },
    off: (type: string, listener: () => void) => {
      if (type === "remove" && removeListener === listener) removeListener = null;
    },
    emitRemove: () => removeListener?.(),
  };
}

describe("mountMapControlInPanel", () => {
  it("moves an appended vendor panel into the native host and cleans it up", () => {
    const document = installDom();
    const mapContainer = document.querySelector<HTMLElement>("#map")!;
    const host = document.createElement("div");
    document.body.appendChild(host);
    let removed = false;
    const control = {
      onAdd: () => {
        const toggle = document.createElement("button");
        const panel = document.createElement("section");
        panel.className = "national-map-panel";
        mapContainer.appendChild(panel);
        return toggle;
      },
      onRemove: () => {
        removed = true;
      },
    };
    const map = fakeMap(mapContainer);
    const app = { getMap: () => map } as unknown as GeoLibreAppAPI;

    const cleanup = mountMapControlInPanel(app, control as never, host);

    assert.ok(cleanup);
    assert.equal(host.querySelectorAll(".national-map-panel").length, 1);
    assert.equal(mapContainer.querySelectorAll(".national-map-panel").length, 0);
    cleanup();
    assert.equal(removed, true);
    assert.equal(host.childElementCount, 0);
  });

  it("extracts Vantor's nested panel from the returned control wrapper", () => {
    const document = installDom();
    const mapContainer = document.querySelector<HTMLElement>("#map")!;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const control = {
      onAdd: () => {
        const wrapper = document.createElement("div");
        const panel = document.createElement("section");
        panel.className = "vantor-panel";
        wrapper.appendChild(panel);
        return wrapper;
      },
      onRemove: () => undefined,
    };
    const map = fakeMap(mapContainer);
    const app = { getMap: () => map } as unknown as GeoLibreAppAPI;

    const cleanup = mountMapControlInPanel(app, control as never, host);

    assert.ok(cleanup);
    assert.equal(host.firstElementChild?.className, "vantor-panel");
    cleanup();
  });

  it("cleans up the control when MapLibre removes the map", () => {
    const document = installDom();
    const mapContainer = document.querySelector<HTMLElement>("#map")!;
    const host = document.createElement("div");
    let removeCalls = 0;
    const control = {
      onAdd: () => {
        const toggle = document.createElement("button");
        const panel = document.createElement("section");
        mapContainer.appendChild(panel);
        return toggle;
      },
      onRemove: () => {
        removeCalls += 1;
      },
    };
    const map = fakeMap(mapContainer);
    const app = { getMap: () => map } as unknown as GeoLibreAppAPI;

    const cleanup = mountMapControlInPanel(app, control as never, host);
    assert.ok(cleanup);
    map.emitRemove();
    cleanup();

    assert.equal(removeCalls, 1);
    assert.equal(host.childElementCount, 0);
  });

  it("supports synchronous plugin teardown before the panel effect unmounts", () => {
    const document = installDom();
    const mapContainer = document.querySelector<HTMLElement>("#map")!;
    const host = document.createElement("div");
    let removeCalls = 0;
    const control = {
      onAdd: () => {
        const toggle = document.createElement("button");
        const panel = document.createElement("section");
        mapContainer.appendChild(panel);
        return toggle;
      },
      onRemove: () => {
        removeCalls += 1;
      },
    };
    const map = fakeMap(mapContainer);
    const app = { getMap: () => map } as unknown as GeoLibreAppAPI;

    const cleanup = mountMapControlInPanel(app, control as never, host);
    assert.ok(cleanup);
    unmountMapControlFromPanel(control as never);
    cleanup();

    assert.equal(removeCalls, 1);
    assert.equal(host.childElementCount, 0);
  });

  it("reports a vendor panel mount failure to the caller", () => {
    const document = installDom();
    const mapContainer = document.querySelector<HTMLElement>("#map")!;
    const host = document.createElement("div");
    let failed = false;
    const control = {
      onAdd: () => document.createElement("button"),
      onRemove: () => undefined,
    };
    const map = fakeMap(mapContainer);
    const app = { getMap: () => map } as unknown as GeoLibreAppAPI;

    const cleanup = mountMapControlInPanel(app, control as never, host, () => {
      failed = true;
    });

    assert.equal(cleanup, null);
    assert.equal(failed, true);
  });
});
