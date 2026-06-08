import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
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
    const options = layoutOptionsFromLocation(DEFAULT_DESKTOP_LAYOUT_SETTINGS);
    assert.equal(options.toolbarVisible, true);
    assert.equal(options.statusBarVisible, true);
    assert.equal(options.layerPanelVisible, true);
    assert.equal(options.stylePanelVisible, true);
    assert.equal(options.attributePanelVisible, true);
  });

  it("hides every chrome element when maponly is set as a bare flag", () => {
    withSearch("?maponly");
    const options = layoutOptionsFromLocation(DEFAULT_DESKTOP_LAYOUT_SETTINGS);
    assert.equal(options.toolbarVisible, false);
    assert.equal(options.statusBarVisible, false);
    assert.equal(options.layerPanelVisible, false);
    assert.equal(options.stylePanelVisible, false);
    assert.equal(options.attributePanelVisible, false);
  });

  it("accepts truthy maponly values", () => {
    for (const value of ["true", "1", "yes", "on"]) {
      withSearch(`?maponly=${value}`);
      const options = layoutOptionsFromLocation(DEFAULT_DESKTOP_LAYOUT_SETTINGS);
      assert.equal(options.toolbarVisible, false, `maponly=${value}`);
      assert.equal(options.statusBarVisible, false, `maponly=${value}`);
      assert.equal(options.layerPanelVisible, false, `maponly=${value}`);
      assert.equal(options.stylePanelVisible, false, `maponly=${value}`);
      assert.equal(options.attributePanelVisible, false, `maponly=${value}`);
    }
  });

  it("returns defaults when window is undefined (SSR)", () => {
    delete (globalThis as { window?: unknown }).window;
    const options = layoutOptionsFromLocation(DEFAULT_DESKTOP_LAYOUT_SETTINGS);
    assert.equal(options.toolbarVisible, true);
    assert.equal(options.statusBarVisible, true);
    assert.equal(options.compact, false);
    assert.equal(options.layerPanelVisible, true);
    assert.equal(options.stylePanelVisible, true);
    assert.equal(options.attributePanelVisible, true);
  });

  it("ignores maponly with a non-truthy value", () => {
    withSearch("?maponly=false");
    const options = layoutOptionsFromLocation(DEFAULT_DESKTOP_LAYOUT_SETTINGS);
    assert.equal(options.toolbarVisible, true);
    assert.equal(options.statusBarVisible, true);
    assert.equal(options.layerPanelVisible, true);
  });

  it("leaves the toolbar and status bar visible for panels=none", () => {
    withSearch("?panels=none");
    const options = layoutOptionsFromLocation(DEFAULT_DESKTOP_LAYOUT_SETTINGS);
    assert.equal(options.toolbarVisible, true);
    assert.equal(options.statusBarVisible, true);
    assert.equal(options.layerPanelVisible, false);
    assert.equal(options.stylePanelVisible, false);
    assert.equal(options.attributePanelVisible, false);
  });
});
