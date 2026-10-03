import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { maplibreElevationProfilePlugin as plugin } from "../packages/plugins/src/plugins/elevation-profile";
import type { GeoLibreAppAPI, GeoLibreRightPanelRegistration } from "../packages/plugins/src/types";

const originalDocument = globalThis.document;
const originalHTMLElement = globalThis.HTMLElement;

function installDom() {
  const { document, window } = parseHTML("<html><body><main id='map'></main></body></html>");
  Object.assign(globalThis, { document, HTMLElement: window.HTMLElement });
  return document;
}

function fakeHost(document: Document, withDock = true) {
  const mapContainer = document.querySelector<HTMLElement>("#map")!;
  const map = {
    getContainer: () => mapContainer,
    getCanvas: () => ({ style: {} as Record<string, string> }),
    doubleClickZoom: { enable() {}, disable() {} },
    on() {},
    off() {},
    getLayer: () => undefined,
    getSource: () => undefined,
  };
  const controls: Array<{ onAdd(map: unknown): HTMLElement; onRemove(): void }> = [];
  const calls: string[] = [];
  let panel: GeoLibreRightPanelRegistration | null = null;
  const host = {
    mapContainer,
    controls,
    calls,
    get panel() {
      return panel;
    },
    addMapControl: (control: (typeof controls)[number]) => {
      mapContainer.appendChild(control.onAdd(map));
      controls.push(control);
      return true;
    },
    removeMapControl: (control: (typeof controls)[number]) => {
      control.onRemove();
      controls.splice(controls.indexOf(control), 1);
    },
    ...(withDock
      ? {
          registerRightPanel: (registration: GeoLibreRightPanelRegistration) => {
            panel = registration;
            return () => {
              panel = null;
            };
          },
          openRightPanel: (id: string) => {
            calls.push(`open:${id}`);
            return true;
          },
          collapseRightPanel: (id: string) => calls.push(`collapse:${id}`),
          closeRightPanel: (id: string) => calls.push(`close:${id}`),
        }
      : {}),
  };
  return host as unknown as GeoLibreAppAPI & typeof host;
}

afterEach(() => {
  Object.assign(globalThis, {
    document: originalDocument,
    HTMLElement: originalHTMLElement,
  });
});

describe("Elevation Profile docked panel", () => {
  it("opens its panel in the side dock and keeps the control on the map", () => {
    const document = installDom();
    const host = fakeHost(document);
    try {
      assert.notEqual(plugin.activate(host), false);
      assert.equal(host.controls.length, 1, "the control stays mounted for the map layers");
      assert.deepEqual(host.calls, ["open:elevation-profile-panel"]);
      assert.equal(host.panel?.deactivatePluginOnClose, true);
      assert.equal(
        host.mapContainer.querySelector(".elevation-profile-panel"),
        null,
        "nothing floats over the map",
      );
      assert.ok(host.mapContainer.querySelector(".elevation-profile--docked"));

      const dock = document.createElement("div");
      const cleanup = host.panel!.render(dock);
      const docked = dock.querySelector(".elevation-profile-panel--docked");
      assert.ok(docked, "the dock adopts the panel");
      assert.equal(docked.querySelector(".elevation-profile-header"), null);
      assert.ok(docked.querySelector(".elevation-profile-actions"));

      // Another panel displacing this one releases the element but keeps the
      // control (and its drawn line) alive.
      if (typeof cleanup === "function") cleanup();
      assert.equal(dock.childElementCount, 0);
      assert.equal(host.controls.length, 1);
    } finally {
      plugin.deactivate(host);
    }
    assert.equal(host.controls.length, 0);
    assert.equal(host.panel, null);
    assert.ok(host.calls.includes("close:elevation-profile-panel"));
  });

  it("restores a collapsed dock from the project and saves the dock state", () => {
    const document = installDom();
    const host = fakeHost(document);
    try {
      plugin.applyProjectState?.(host, { collapsed: true, unitSystem: "imperial" });
      assert.notEqual(plugin.activate(host), false);
      assert.deepEqual(host.calls, [
        "open:elevation-profile-panel",
        "collapse:elevation-profile-panel",
      ]);
      host.panel!.onCollapse?.();
      assert.equal((plugin.getProjectState?.() as { collapsed: boolean }).collapsed, true);
      host.panel!.onOpen?.();
      const state = plugin.getProjectState?.() as { collapsed: boolean; unitSystem: string };
      assert.equal(state.collapsed, false);
      assert.equal(state.unitSystem, "imperial");
    } finally {
      plugin.deactivate(host);
      plugin.applyProjectState?.(host, undefined);
    }
  });

  it("refuses to activate on a host without a dock", () => {
    const document = installDom();
    const host = fakeHost(document, false);
    assert.equal(plugin.activate(host), false);
    assert.equal(host.controls.length, 0);
  });
});
