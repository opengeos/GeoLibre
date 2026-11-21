import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_DESKTOP_LAYOUT_SETTINGS,
  normalizeDesktopSettings,
} from "../apps/geolibre-desktop/src/hooks/useDesktopSettings";
import {
  applyInterfaceSettings,
  parseInterfaceFile,
  serializeInterfaceFile,
} from "../apps/geolibre-desktop/src/lib/interface-settings-file";
import {
  DEFAULT_TOUCH_UI_MODE,
  isTouchUiMode,
  resolveMobileShell,
  resolveTouchUi,
} from "../apps/geolibre-desktop/src/lib/touch-ui";

describe("touch UI mode resolution", () => {
  it("validates allowed touch UI modes", () => {
    assert.equal(isTouchUiMode("auto"), true);
    assert.equal(isTouchUiMode("touch"), true);
    assert.equal(isTouchUiMode("desktop"), true);
    assert.equal(isTouchUiMode("mobile"), false);
    assert.equal(isTouchUiMode(true), false);
    assert.equal(isTouchUiMode(null), false);
  });

  it("enables touch ergonomics on coarse pointers or mobile OSes in auto mode", () => {
    assert.equal(
      resolveTouchUi({ mode: "auto", coarsePointer: true, mobilePlatform: false }),
      true,
    );
    assert.equal(
      resolveTouchUi({ mode: "auto", coarsePointer: false, mobilePlatform: true }),
      true,
    );
    assert.equal(
      resolveTouchUi({ mode: "auto", coarsePointer: false, mobilePlatform: false }),
      false,
    );
  });

  it("honors explicit touch and desktop overrides regardless of hardware", () => {
    assert.equal(
      resolveTouchUi({ mode: "touch", coarsePointer: false, mobilePlatform: false }),
      true,
    );
    assert.equal(
      resolveTouchUi({ mode: "desktop", coarsePointer: true, mobilePlatform: true }),
      false,
    );
  });

  it("activates the mobile phone shell only for touch UI on phone viewports outside embeds", () => {
    assert.equal(
      resolveMobileShell({
        mode: "auto",
        touchUi: true,
        mobileViewport: true,
        compact: false,
        panelsHidden: false,
      }),
      true,
    );
    // Tablets keep side drawers while retaining touch ergonomics.
    assert.equal(
      resolveMobileShell({
        mode: "auto",
        touchUi: true,
        mobileViewport: false,
        compact: false,
        panelsHidden: false,
      }),
      false,
    );
    // Narrow desktop windows without touch keep the scrollable desktop menubar.
    assert.equal(
      resolveMobileShell({
        mode: "auto",
        touchUi: false,
        mobileViewport: true,
        compact: false,
        panelsHidden: false,
      }),
      false,
    );
    // Explicit desktop override disables mobile shell on phones.
    assert.equal(
      resolveMobileShell({
        mode: "desktop",
        touchUi: false,
        mobileViewport: true,
        compact: false,
        panelsHidden: false,
      }),
      false,
    );
    // Compact / viewer / map-only embeds keep their dedicated embed chrome.
    assert.equal(
      resolveMobileShell({
        mode: "touch",
        touchUi: true,
        mobileViewport: true,
        compact: true,
        panelsHidden: false,
      }),
      false,
    );
    assert.equal(
      resolveMobileShell({
        mode: "touch",
        touchUi: true,
        mobileViewport: true,
        compact: false,
        panelsHidden: true,
      }),
      false,
    );
  });
});

describe("touchUiMode persistence and interface file round-trip", () => {
  it("defaults to auto and rejects tampered storage values", () => {
    assert.equal(DEFAULT_DESKTOP_LAYOUT_SETTINGS.touchUiMode, DEFAULT_TOUCH_UI_MODE);
    assert.equal(normalizeDesktopSettings({ layout: {} }).layout.touchUiMode, "auto");
    assert.equal(
      normalizeDesktopSettings({ layout: { touchUiMode: "touch" } }).layout.touchUiMode,
      "touch",
    );
    assert.equal(
      normalizeDesktopSettings({ layout: { touchUiMode: "desktop" } }).layout.touchUiMode,
      "desktop",
    );
    assert.equal(
      normalizeDesktopSettings({ layout: { touchUiMode: "tablet" } }).layout.touchUiMode,
      "auto",
    );
  });

  it("round-trips touchUiMode through interface export/import files", () => {
    const base = normalizeDesktopSettings({ layout: { touchUiMode: "touch" } });
    const serialized = serializeInterfaceFile(base);
    const parsed = parseInterfaceFile(serialized);
    const applied = applyInterfaceSettings(normalizeDesktopSettings({}), parsed);
    assert.equal(applied.layout.touchUiMode, "touch");
  });
});
