import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ALL_DEPLOYMENT_CAPABILITIES, type DeploymentCapability } from "@geolibre/core";
import { DEFAULT_DESKTOP_LAYOUT_SETTINGS } from "../apps/geolibre-desktop/src/hooks/useDesktopSettings";
import { layoutOptionsFromLocation } from "../apps/geolibre-desktop/src/hooks/useLayoutOptions";

const originalWindow = (globalThis as { window?: unknown }).window;

function withSearch(search: string): void {
  (globalThis as { window?: unknown }).window = {
    location: { search },
  };
}

afterEach(() => {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
});

describe("layoutOptionsFromLocation", () => {
  it("keeps all chrome visible without query params", () => {
    withSearch("");
    const options = layoutOptionsFromLocation(
      DEFAULT_DESKTOP_LAYOUT_SETTINGS,
      ALL_DEPLOYMENT_CAPABILITIES,
    );
    assert.equal(options.toolbarVisible, true);
    assert.equal(options.statusBarVisible, true);
    assert.equal(options.layerPanelVisible, true);
    assert.equal(options.stylePanelVisible, true);
    assert.equal(options.attributePanelVisible, true);
    assert.equal(options.panelsHidden, false);
    assert.equal(options.panelsCollapsed, false);
    assert.equal(options.bottomPanelsUnderMap, true);
  });

  it("passes the bottom-panel placement setting through", () => {
    withSearch("");
    const options = layoutOptionsFromLocation(
      { ...DEFAULT_DESKTOP_LAYOUT_SETTINGS, bottomPanelsUnderMap: false },
      ALL_DEPLOYMENT_CAPABILITIES,
    );
    assert.equal(options.bottomPanelsUnderMap, false);
  });

  it("hides every chrome element when maponly is set as a bare flag", () => {
    withSearch("?maponly");
    const options = layoutOptionsFromLocation(
      DEFAULT_DESKTOP_LAYOUT_SETTINGS,
      ALL_DEPLOYMENT_CAPABILITIES,
    );
    assert.equal(options.toolbarVisible, false);
    assert.equal(options.statusBarVisible, false);
    assert.equal(options.layerPanelVisible, false);
    assert.equal(options.stylePanelVisible, false);
    assert.equal(options.attributePanelVisible, false);
    // Gates the whole side dock (plugin/Browser panels + shared rail), not just
    // the built-in Layers/Style panels.
    assert.equal(options.panelsHidden, true);
  });

  it("accepts truthy maponly values", () => {
    for (const value of ["true", "1", "yes", "on"]) {
      withSearch(`?maponly=${value}`);
      const options = layoutOptionsFromLocation(
        DEFAULT_DESKTOP_LAYOUT_SETTINGS,
        ALL_DEPLOYMENT_CAPABILITIES,
      );
      assert.equal(options.toolbarVisible, false, `maponly=${value}`);
      assert.equal(options.statusBarVisible, false, `maponly=${value}`);
      assert.equal(options.layerPanelVisible, false, `maponly=${value}`);
      assert.equal(options.stylePanelVisible, false, `maponly=${value}`);
      assert.equal(options.attributePanelVisible, false, `maponly=${value}`);
    }
  });

  it("returns defaults when window is undefined (SSR)", () => {
    delete (globalThis as { window?: unknown }).window;
    const options = layoutOptionsFromLocation(
      DEFAULT_DESKTOP_LAYOUT_SETTINGS,
      ALL_DEPLOYMENT_CAPABILITIES,
    );
    assert.equal(options.toolbarVisible, true);
    assert.equal(options.statusBarVisible, true);
    assert.equal(options.compact, false);
    assert.equal(options.layerPanelVisible, true);
    assert.equal(options.stylePanelVisible, true);
    assert.equal(options.attributePanelVisible, true);
    assert.equal(options.panelsHidden, false);
  });

  it("ignores maponly with a non-truthy value", () => {
    withSearch("?maponly=false");
    const options = layoutOptionsFromLocation(
      DEFAULT_DESKTOP_LAYOUT_SETTINGS,
      ALL_DEPLOYMENT_CAPABILITIES,
    );
    assert.equal(options.toolbarVisible, true);
    assert.equal(options.statusBarVisible, true);
    assert.equal(options.layerPanelVisible, true);
    assert.equal(options.panelsHidden, false);
  });

  it("leaves the toolbar and status bar visible for panels=none", () => {
    withSearch("?panels=none");
    const options = layoutOptionsFromLocation(
      DEFAULT_DESKTOP_LAYOUT_SETTINGS,
      ALL_DEPLOYMENT_CAPABILITIES,
    );
    assert.equal(options.toolbarVisible, true);
    assert.equal(options.statusBarVisible, true);
    assert.equal(options.layerPanelVisible, false);
    assert.equal(options.stylePanelVisible, false);
    assert.equal(options.attributePanelVisible, false);
    assert.equal(options.panelsHidden, true);
  });

  it("hides only the toolbar for toolbar=none", () => {
    withSearch("?toolbar=none");
    const options = layoutOptionsFromLocation(
      DEFAULT_DESKTOP_LAYOUT_SETTINGS,
      ALL_DEPLOYMENT_CAPABILITIES,
    );
    assert.equal(options.toolbarVisible, false);
    assert.equal(options.statusBarVisible, true);
    assert.equal(options.layerPanelVisible, true);
    assert.equal(options.stylePanelVisible, true);
    assert.equal(options.attributePanelVisible, true);
    assert.equal(options.panelsHidden, false);
  });

  it("accepts hidden toolbar aliases", () => {
    for (const value of ["hidden", "hide", "off"]) {
      withSearch(`?toolbar=${value}`);
      const options = layoutOptionsFromLocation(
        DEFAULT_DESKTOP_LAYOUT_SETTINGS,
        ALL_DEPLOYMENT_CAPABILITIES,
      );
      assert.equal(options.toolbarVisible, false, `toolbar=${value}`);
      assert.equal(options.layerPanelVisible, true, `toolbar=${value}`);
    }
  });

  it("starts side panels collapsed without hiding their rails", () => {
    withSearch("?panels=collapsed");
    const options = layoutOptionsFromLocation(
      DEFAULT_DESKTOP_LAYOUT_SETTINGS,
      ALL_DEPLOYMENT_CAPABILITIES,
    );
    assert.equal(options.toolbarVisible, true);
    assert.equal(options.layerPanelVisible, true);
    assert.equal(options.stylePanelVisible, true);
    assert.equal(options.attributePanelVisible, true);
    assert.equal(options.panelsHidden, false);
    assert.equal(options.panelsCollapsed, true);
  });

  it("provides read-only viewer chrome between the full app and maponly", () => {
    withSearch("?layout=viewer");
    const options = layoutOptionsFromLocation(
      DEFAULT_DESKTOP_LAYOUT_SETTINGS,
      ALL_DEPLOYMENT_CAPABILITIES,
    );
    assert.equal(options.viewer, true);
    assert.equal(options.compact, true);
    assert.equal(options.toolbarVisible, true);
    assert.equal(options.statusBarVisible, true);
    assert.equal(options.layerPanelVisible, true);
    assert.equal(options.stylePanelVisible, false);
    assert.equal(options.attributePanelVisible, false);
    assert.equal(options.panelsHidden, false);
  });

  it("forces the viewer layer legend on despite a persisted hidden setting", () => {
    withSearch("?layout=viewer");
    const options = layoutOptionsFromLocation(
      {
        ...DEFAULT_DESKTOP_LAYOUT_SETTINGS,
        layerPanelVisible: false,
      },
      ALL_DEPLOYMENT_CAPABILITIES,
    );
    assert.equal(options.layerPanelVisible, true);
  });

  describe("viewer drawing (?draw)", () => {
    const defaults = DEFAULT_DESKTOP_LAYOUT_SETTINGS;

    it("stays off unless the viewer asks for it", () => {
      withSearch("?layout=viewer");
      assert.equal(
        layoutOptionsFromLocation(defaults, ALL_DEPLOYMENT_CAPABILITIES).viewerDrawing,
        false,
      );
      withSearch("");
      assert.equal(
        layoutOptionsFromLocation(defaults, ALL_DEPLOYMENT_CAPABILITIES).viewerDrawing,
        false,
      );
    });

    it("turns on for a bare flag or a truthy value in the viewer", () => {
      for (const search of [
        "?layout=viewer&draw",
        "?layout=viewer&draw=true",
        "?layout=viewer&draw=1",
      ]) {
        withSearch(search);
        assert.equal(
          layoutOptionsFromLocation(defaults, ALL_DEPLOYMENT_CAPABILITIES).viewerDrawing,
          true,
          search,
        );
      }
    });

    it("ignores a falsy value and any layout other than the viewer", () => {
      for (const search of [
        "?layout=viewer&draw=false",
        "?layout=viewer&draw=no",
        "?layout=viewer&draw=off",
        "?layout=viewer&draw=0",
        "?layout=compact&draw",
        "?draw",
      ]) {
        withSearch(search);
        assert.equal(
          layoutOptionsFromLocation(defaults, ALL_DEPLOYMENT_CAPABILITIES).viewerDrawing,
          false,
          search,
        );
      }
    });

    it("is withheld when the deployment lacks project:edit", () => {
      withSearch("?layout=viewer&draw");
      const readOnly = new Set<DeploymentCapability>(["data:add", "export:data"]);
      assert.equal(layoutOptionsFromLocation(defaults, readOnly).viewerDrawing, false);
      const editable = new Set<DeploymentCapability>(["project:edit"]);
      assert.equal(layoutOptionsFromLocation(defaults, editable).viewerDrawing, true);
    });

    it("keeps the rest of the viewer chrome read-only", () => {
      withSearch("?layout=viewer&draw");
      const options = layoutOptionsFromLocation(defaults, ALL_DEPLOYMENT_CAPABILITIES);
      assert.equal(options.viewer, true);
      assert.equal(options.stylePanelVisible, false);
      assert.equal(options.attributePanelVisible, false);
    });
  });
});
