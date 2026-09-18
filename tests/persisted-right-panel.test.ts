import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  __resetRightPanelRegistryForTests,
  closeRightPanel,
  collapseRightPanel,
  isRightPanelCollapsed,
  isRightPanelVisible,
  openRightPanel,
  registerRightPanel,
} from "../packages/plugins/src/right-panel-registry";
import {
  applyRightPanelVisibility,
  registerPersistedRightPanel,
} from "../apps/geolibre-desktop/src/lib/persisted-right-panel";
import { useDesktopSettingsStore } from "../apps/geolibre-desktop/src/hooks/useDesktopSettings";

// The Browser and Comments right panels persist their visibility so a panel the
// user turned off stays off across restarts (GeoLibre#1935). The setting and the
// registry have to agree in both directions: the panel is seeded from the
// setting at registration, and every later visibility change (Settings toggle or
// the panel's own close button) is written back.
const PANEL_ID = "comments";
const KEY = "commentsPanelVisible";

function registration(id = PANEL_ID) {
  return { id, title: "Comments", dock: "replace-style" as const, render: () => {} };
}

function setStoredVisibility(visible: boolean): void {
  const { desktopSettings, setDesktopSettings } = useDesktopSettingsStore.getState();
  setDesktopSettings({
    ...desktopSettings,
    layout: { ...desktopSettings.layout, [KEY]: visible },
  });
}

function storedVisibility(): boolean {
  return useDesktopSettingsStore.getState().desktopSettings.layout[KEY];
}

beforeEach(() => {
  __resetRightPanelRegistryForTests();
  setStoredVisibility(true);
});

afterEach(() => {
  __resetRightPanelRegistryForTests();
  setStoredVisibility(true);
});

describe("applyRightPanelVisibility", () => {
  it("opens the panel collapsed onto its rail", () => {
    registerRightPanel(registration());
    applyRightPanelVisibility(PANEL_ID, true);
    assert.equal(isRightPanelVisible(PANEL_ID), true);
    assert.equal(isRightPanelCollapsed(), true);
  });

  it("leaves an expanded panel expanded when re-applying `true`", () => {
    registerRightPanel(registration());
    openRightPanel(PANEL_ID);
    assert.equal(isRightPanelCollapsed(), false);
    // Saving the Settings dialog re-applies every layout row, including rows the
    // user never touched; that must not collapse a panel they had expanded.
    applyRightPanelVisibility(PANEL_ID, true);
    assert.equal(isRightPanelCollapsed(), false);
  });

  it("closes the panel", () => {
    registerRightPanel(registration());
    applyRightPanelVisibility(PANEL_ID, true);
    applyRightPanelVisibility(PANEL_ID, false);
    assert.equal(isRightPanelVisible(PANEL_ID), false);
  });
});

describe("registerPersistedRightPanel", () => {
  it("seeds a visible panel from the setting, collapsed", () => {
    const dispose = registerPersistedRightPanel(registration(), KEY);
    assert.equal(isRightPanelVisible(PANEL_ID), true);
    assert.equal(isRightPanelCollapsed(), true);
    dispose();
  });

  it("leaves a disabled panel closed instead of reopening it on every launch", () => {
    setStoredVisibility(false);
    const dispose = registerPersistedRightPanel(registration(), KEY);
    assert.equal(isRightPanelVisible(PANEL_ID), false);
    assert.equal(storedVisibility(), false);
    dispose();
  });

  it("persists a close that came from the panel's own header", () => {
    const dispose = registerPersistedRightPanel(registration(), KEY);
    closeRightPanel(PANEL_ID);
    assert.equal(storedVisibility(), false);
    dispose();
  });

  it("persists a reopen", () => {
    setStoredVisibility(false);
    const dispose = registerPersistedRightPanel(registration(), KEY);
    applyRightPanelVisibility(PANEL_ID, true);
    assert.equal(storedVisibility(), true);
    dispose();
  });

  it("does not treat collapsing to the rail as turning the panel off", () => {
    const dispose = registerPersistedRightPanel(registration(), KEY);
    openRightPanel(PANEL_ID);
    collapseRightPanel(PANEL_ID);
    assert.equal(storedVisibility(), true);
    dispose();
  });

  it("does not treat being displaced by another panel as a close", () => {
    const dispose = registerPersistedRightPanel(registration(), KEY);
    registerRightPanel(registration("other"));
    openRightPanel("other");
    assert.equal(storedVisibility(), true);
    dispose();
  });

  it("does not persist `false` when the shell unmounts", () => {
    // The disposer unregisters, which emits a snapshot with the panel gone. That
    // teardown must not be mistaken for the user turning the panel off, or the
    // setting would flip to false on every reload.
    const dispose = registerPersistedRightPanel(registration(), KEY);
    dispose();
    assert.equal(storedVisibility(), true);
  });
});
