import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { mountMapControlInPanel } from "../packages/plugins/src/plugins/dockable-map-control";
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
    const app = { getMap: () => ({ getContainer: () => mapContainer }) } as GeoLibreAppAPI;

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
    const app = { getMap: () => ({ getContainer: () => mapContainer }) } as GeoLibreAppAPI;

    const cleanup = mountMapControlInPanel(app, control as never, host);

    assert.ok(cleanup);
    assert.equal(host.firstElementChild?.className, "vantor-panel");
    cleanup();
  });
});
