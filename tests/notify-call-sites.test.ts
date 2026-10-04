import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import i18next from "i18next";
import en from "../apps/geolibre-desktop/src/i18n/locales/en.json";
import { afterI18nInit } from "../apps/geolibre-desktop/src/lib/after-i18n-init";
import { clearDiagnostics } from "../apps/geolibre-desktop/src/lib/diagnostics";
import { clearNotifications, useNotificationStore } from "../apps/geolibre-desktop/src/lib/notify";
import { notifyPanelRenderFailed } from "../apps/geolibre-desktop/src/lib/panel-render-failure";

const visible = () => useNotificationStore.getState().notifications;

describe("notify call-site helpers", () => {
  beforeEach(() => {
    clearNotifications();
    clearDiagnostics();
  });
  afterEach(() => clearNotifications());

  it("afterI18nInit defers until i18next initializes, then runs once", async () => {
    // The helper reads the shared instance; drive that one when it is fresh.
    if (!i18next.isInitialized) {
      let runs = 0;
      afterI18nInit(() => runs++);
      assert.equal(runs, 0);
      await i18next.init({ lng: "en", resources: { en: { translation: en } } });
      assert.equal(runs, 1);
      i18next.emit("initialized", {});
      assert.equal(runs, 1);
    }
    // Already initialized: runs at once.
    let immediate = 0;
    afterI18nInit(() => immediate++);
    assert.equal(immediate, 1);
  });

  it("names a panel that failed to render, falling back to its id", () => {
    notifyPanelRenderFailed("my-panel", "Workbench", new Error("boom"));
    notifyPanelRenderFailed("other-panel", "  ", new Error("boom"));
    notifyPanelRenderFailed("my-panel", "Workbench", new Error("boom again"));
    const toasts = visible();
    assert.equal(toasts.length, 2);
    assert.ok(toasts.every((toast) => toast.kind === "error"));
    // A repeat merges into its toast and moves to the newest slot.
    const [other, workbench] = toasts;
    assert.match(other.message, /other-panel/);
    assert.match(workbench.message, /Workbench/);
    assert.equal(workbench.count, 2);
    // The thrown error reaches Diagnostics through the error toast's record.
    assert.match(workbench.diagnostic?.detail ?? "", /boom again/);
  });

  it("has an English string for every new notification key", () => {
    const keys = [
      "layerAccessDenied",
      "layerAccessDeniedHint",
      "layerTilesMissing",
      "layerTilesMissingHint",
      "projectHistoryLoadFailed",
      "projectRecoveryUnavailable",
      "autosaveFailed",
      "windowCloseGuardFailed",
      "windowCloseSaveFailed",
      "windowCloseFailed",
      "nativeProjectPathFailed",
      "kmlSuperOverlayReadFailed",
      "projectControlFailed",
      "pluginSnapshotFailed",
      "lidarRestoreFailed",
      "splattingRestoreFailed",
      "panelRenderFailed",
      "sharedSettingsFailed",
      "sharedLanguageFailed",
      "languageCatalogFailed",
    ] as const;
    for (const key of keys) assert.equal(typeof en.notifications[key], "string", key);
  });
});
