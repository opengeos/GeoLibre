import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_DESKTOP_LAYOUT_SETTINGS,
  normalizeDesktopSettings,
} from "../apps/geolibre-desktop/src/hooks/useDesktopSettings";

// The Browser and Comments right panels used to be session-only: their Settings
// → Layout toggles moved the panel registry but nothing was persisted, so every
// launch reopened them (GeoLibre#1935). They are now layout settings like the
// Layers/Style panels, which means they have to round-trip through
// normalizeDesktopSettings and keep defaulting to on for existing users whose
// stored settings predate the keys.
describe("dockable panel layout settings", () => {
  it("defaults both dockable panels to visible", () => {
    assert.equal(DEFAULT_DESKTOP_LAYOUT_SETTINGS.browserPanelVisible, true);
    assert.equal(DEFAULT_DESKTOP_LAYOUT_SETTINGS.commentsPanelVisible, true);
  });

  it("keeps a disabled panel disabled across a load", () => {
    const layout = normalizeDesktopSettings({
      layout: { browserPanelVisible: false, commentsPanelVisible: false },
    }).layout;
    assert.equal(layout.browserPanelVisible, false);
    assert.equal(layout.commentsPanelVisible, false);
  });

  it("falls back to the defaults for settings saved before the keys existed", () => {
    const layout = normalizeDesktopSettings({
      layout: { layerPanelVisible: false, stylePanelVisible: true, toolbarLabels: true },
    }).layout;
    assert.equal(layout.layerPanelVisible, false);
    assert.equal(layout.browserPanelVisible, true);
    assert.equal(layout.commentsPanelVisible, true);
  });

  it("rejects non-boolean values from tampered storage", () => {
    const layout = normalizeDesktopSettings({
      layout: { browserPanelVisible: "no", commentsPanelVisible: 0 },
    }).layout;
    assert.equal(layout.browserPanelVisible, true);
    assert.equal(layout.commentsPanelVisible, true);
  });
});

// The compact Layers panel (#3045) is a per-user display choice, so it lives in
// the layout settings and must survive a reload without flipping existing users.
describe("compact layer list setting", () => {
  it("defaults to the full layer cards", () => {
    assert.equal(DEFAULT_DESKTOP_LAYOUT_SETTINGS.compactLayerList, false);
    assert.equal(normalizeDesktopSettings({ layout: {} }).layout.compactLayerList, false);
  });

  it("keeps compact mode on across a load", () => {
    const layout = normalizeDesktopSettings({ layout: { compactLayerList: true } }).layout;
    assert.equal(layout.compactLayerList, true);
  });

  it("rejects a non-boolean value from tampered storage", () => {
    const layout = normalizeDesktopSettings({ layout: { compactLayerList: "yes" } }).layout;
    assert.equal(layout.compactLayerList, false);
  });
});
