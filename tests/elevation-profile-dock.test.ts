import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { maplibreElevationProfilePlugin as plugin } from "../packages/plugins/src/plugins/elevation-profile";
import {
  __resetRightPanelRegistryForTests,
  closeRightPanel,
  collapseRightPanel,
  getRightPanel,
  openRightPanel,
  registerRightPanel,
} from "../packages/plugins/src/right-panel-registry";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

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
  // The dock operations go through the real registry (the one the app's
  // sidebars drive), so its hook timing is what the plugin sees.
  const calls: string[] = [];
  const host = {
    mapContainer,
    controls,
    calls,
    get panel() {
      return getRightPanel("elevation-profile-panel") ?? null;
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
          registerRightPanel,
          openRightPanel: (id: string) => {
            calls.push(`open:${id}`);
            return openRightPanel(id);
          },
          collapseRightPanel: (id: string) => {
            calls.push(`collapse:${id}`);
            collapseRightPanel(id);
          },
          closeRightPanel: (id: string) => {
            calls.push(`close:${id}`);
            closeRightPanel(id);
          },
        }
      : {}),
  };
  return host as unknown as GeoLibreAppAPI & typeof host;
}

afterEach(() => {
  __resetRightPanelRegistryForTests();
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
      assert.equal((plugin.getProjectState?.() as { collapsed: boolean }).collapsed, true);
      // Re-expanding from the rail fires no onOpen (the panel already owns the
      // dock), so the saved state has to come from the dock itself.
      openRightPanel("elevation-profile-panel");
      const state = plugin.getProjectState?.() as { collapsed: boolean; unitSystem: string };
      assert.equal(state.collapsed, false);
      assert.equal(state.unitSystem, "imperial");
      collapseRightPanel("elevation-profile-panel");
      assert.equal((plugin.getProjectState?.() as { collapsed: boolean }).collapsed, true);
    } finally {
      plugin.deactivate(host);
      plugin.applyProjectState?.(host, undefined);
    }
  });

  it("saves no project state while the plugin is untouched", () => {
    const document = installDom();
    const host = fakeHost(document);
    // New Project reset: caches the defaults but must not write them out.
    plugin.applyProjectState?.(host, undefined);
    assert.equal(plugin.getProjectState?.(), undefined);
    // A real drawn line is still saved.
    plugin.applyProjectState?.(host, {
      collapsed: false,
      unitSystem: "metric",
      line: [
        [0, 0],
        [1, 1],
      ],
      elevations: null,
    } as never);
    assert.ok(plugin.getProjectState?.());
    plugin.applyProjectState?.(host, undefined);
  });

  it("refuses to activate on a host without a dock", () => {
    const document = installDom();
    const host = fakeHost(document, false);
    assert.equal(plugin.activate(host), false);
    assert.equal(host.controls.length, 0);
  });

  it("renders its panel in the app language and re-labels on a language change", () => {
    const document = installDom();
    const catalogs: Record<string, Record<string, string>> = {
      en: {},
      de: {
        "toolbar.plugin.geolibre-elevation-profile": "Höhenprofil",
        "plugin.geolibre-elevation-profile.drawLine": "Linie zeichnen",
        "plugin.geolibre-elevation-profile.clear": "Leeren",
        "plugin.geolibre-elevation-profile.unitsTitle": "Einheiten: {{units}}",
      },
    };
    let locale = "en";
    const listeners = new Set<(next: string) => void>();
    const host = Object.assign(fakeHost(document), {
      translate: (key: string, fallback: string, params?: Record<string, string | number>) =>
        (catalogs[locale][key] ?? fallback).replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
          String(params?.[name] ?? ""),
        ),
      onLocaleChange: (listener: (next: string) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    // An earlier test's deactivate leaves the panel cached as expanded, and an
    // expanded control positions itself on the next frame.
    const originalRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = () => 0;
    try {
      assert.notEqual(plugin.activate(host), false);
      // The registry re-runs the title getter on every read.
      const title = () => host.panel!.title;
      assert.equal(title(), "Elevation Profile");
      const dock = document.createElement("div");
      host.panel!.render(dock);
      const buttons = () =>
        [...dock.querySelectorAll<HTMLButtonElement>(".elevation-profile-button")].map(
          (button) => button.textContent,
        );
      assert.equal(buttons()[0], "Draw line");

      locale = "de";
      for (const listener of listeners) listener("de");
      assert.equal(title(), "Höhenprofil");
      assert.equal(buttons()[0], "Linie zeichnen");
      assert.ok(buttons().includes("Leeren"));
      const unit = dock.querySelector<HTMLButtonElement>(".elevation-profile-unit")!;
      assert.match(unit.title, /^Einheiten: /);
    } finally {
      plugin.deactivate(host);
      plugin.applyProjectState?.(host, undefined);
      globalThis.requestAnimationFrame = originalRaf;
    }
    assert.equal(listeners.size, 0, "deactivate stops following the language");
  });
});
