import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { createEmptyProject, useAppStore } from "@geolibre/core";
import {
  __resetRightPanelRegistryForTests,
  collapseRightPanel,
  getActiveRightPanel,
  isRightPanelCollapsed,
  openRightPanel,
  registerRightPanel,
} from "@geolibre/plugins/right-panel-registry";
import {
  __resetFloatingPanelRegistryForTests,
  isFloatingPanelOpen,
  registerFloatingPanel,
} from "@geolibre/plugins/floating-panel-registry";
import {
  isStartupPanelGateOpen,
  isStartupProjectFresh,
  openStartupPanel,
  type StartupPanelGate,
} from "../apps/geolibre-desktop/src/lib/startup-panel";

describe("openStartupPanel", () => {
  beforeEach(() => {
    __resetRightPanelRegistryForTests();
    __resetFloatingPanelRegistryForTests();
    useAppStore.setState({ projectPath: null, projectLoaded: false });
    useAppStore.getState().newProject({ name: "Untitled" });
  });

  it("opens an already registered right panel immediately", () => {
    registerRightPanel({
      id: "org-gis-panel",
      title: "GIS Tools",
      render: () => undefined,
    });

    const dispose = openStartupPanel("org-gis-panel", () => true);
    assert.equal(getActiveRightPanel(), "org-gis-panel");
    assert.equal(isRightPanelCollapsed(), false);
    dispose();
  });

  it("expands an already active right panel if it was collapsed", () => {
    registerRightPanel({
      id: "org-gis-panel",
      title: "GIS Tools",
      render: () => undefined,
    });

    // Make the panel active and then collapse it to its rail
    openRightPanel("org-gis-panel");
    assert.equal(getActiveRightPanel(), "org-gis-panel");

    collapseRightPanel("org-gis-panel");
    assert.equal(isRightPanelCollapsed(), true);

    // openStartupPanel re-expands the collapsed active panel
    let openedCalled = false;
    openStartupPanel(
      "org-gis-panel",
      () => true,
      () => {
        openedCalled = true;
      },
    );
    assert.equal(isRightPanelCollapsed(), false);
    assert.equal(openedCalled, true);
  });

  it("opens an already registered floating panel immediately", () => {
    registerFloatingPanel({
      id: "org-floating-panel",
      title: "GIS Overview",
      render: () => undefined,
    });

    const dispose = openStartupPanel("org-floating-panel", () => true);
    assert.equal(isFloatingPanelOpen("org-floating-panel"), true);
    dispose();
  });

  it("opens a right panel that registers asynchronously", () => {
    const dispose = openStartupPanel("async-panel", () => true);
    assert.equal(getActiveRightPanel(), null);

    registerRightPanel({
      id: "async-panel",
      title: "Async GIS",
      render: () => undefined,
    });

    assert.equal(getActiveRightPanel(), "async-panel");
    assert.equal(isRightPanelCollapsed(), false);
    dispose();
  });

  it("opens a floating panel that registers asynchronously", () => {
    const dispose = openStartupPanel("async-floating", () => true);
    assert.equal(isFloatingPanelOpen("async-floating"), false);

    registerFloatingPanel({
      id: "async-floating",
      title: "Async Floating",
      render: () => undefined,
    });

    assert.equal(isFloatingPanelOpen("async-floating"), true);
    dispose();
  });

  it("does not open when project is not fresh", () => {
    registerRightPanel({
      id: "existing-panel",
      title: "Existing Panel",
      render: () => undefined,
    });

    const dispose = openStartupPanel("existing-panel", () => false);
    assert.equal(getActiveRightPanel(), null);
    dispose();
  });

  it("cancels waiting when the freshness predicate turns false before registration", () => {
    let fresh = true;
    const dispose = openStartupPanel("late-panel", () => fresh);

    // The predicate reports a non-fresh project while waiting
    fresh = false;

    // Another panel emits an update
    registerRightPanel({
      id: "other-panel",
      title: "Other",
      render: () => undefined,
    });

    // Late panel finally registers
    registerRightPanel({
      id: "late-panel",
      title: "Late Panel",
      render: () => undefined,
    });

    assert.equal(getActiveRightPanel(), null);
    dispose();
  });

  it("does not open when a saved project with no plugins key is loaded", () => {
    registerRightPanel({
      id: "org-gis-panel",
      title: "GIS Tools",
      render: () => undefined,
    });

    useAppStore.getState().loadProject(createEmptyProject("SavedWithoutPlugins"));
    const dispose = openStartupPanel("org-gis-panel", isStartupProjectFresh);
    assert.equal(getActiveRightPanel(), null);
    dispose();
  });

  it("opens when a fresh project is started", () => {
    registerRightPanel({
      id: "org-gis-panel",
      title: "GIS Tools",
      render: () => undefined,
    });

    useAppStore.getState().newProject({ name: "Untitled" });
    const dispose = openStartupPanel("org-gis-panel", isStartupProjectFresh);
    assert.equal(getActiveRightPanel(), "org-gis-panel");
    dispose();
  });

  it("does not open when a saved project finishes loading while waiting for panel registration", () => {
    useAppStore.getState().newProject({ name: "FreshStartup" });
    assert.equal(isStartupProjectFresh(), true);

    const dispose = openStartupPanel("late-panel", isStartupProjectFresh);

    // Asynchronous project restore completes and loads saved project while waiting
    useAppStore.getState().loadProject(createEmptyProject("SavedLoadedLater"));
    assert.equal(isStartupProjectFresh(), false);

    // Late panel finally registers after project was loaded
    registerRightPanel({
      id: "late-panel",
      title: "Late Panel",
      render: () => undefined,
    });

    assert.equal(getActiveRightPanel(), null);
    dispose();
  });

  it("cancels waiting when a saved project loads, even if a new project is created before registration", () => {
    const dispose = openStartupPanel("late-after-new", isStartupProjectFresh);

    // Saved project loads (no longer fresh)
    useAppStore.getState().loadProject(createEmptyProject("SavedIntermediate"));
    assert.equal(isStartupProjectFresh(), false);

    // User then creates a new project
    useAppStore.getState().newProject({ name: "NewUntitled" });
    assert.equal(isStartupProjectFresh(), true);

    // Late panel registers
    registerRightPanel({
      id: "late-after-new",
      title: "Late After New",
      render: () => undefined,
    });

    assert.equal(getActiveRightPanel(), null);
    dispose();
  });

  it("stops waiting when another right panel opens before registration", () => {
    let displaced = false;
    const dispose = openStartupPanel(
      "late-panel",
      () => true,
      undefined,
      () => {
        displaced = true;
      },
    );

    // The user opens a different panel while the target is still unregistered
    registerRightPanel({ id: "user-panel", title: "User Panel", render: () => undefined });
    openRightPanel("user-panel");

    registerRightPanel({ id: "late-panel", title: "Late Panel", render: () => undefined });
    assert.equal(displaced, true);
    assert.equal(getActiveRightPanel(), "user-panel");
    dispose();
  });

  it("keeps the original baseline when a wait restarts after another panel opened", () => {
    registerRightPanel({ id: "user-panel", title: "User Panel", render: () => undefined });
    // The first wait began with no active panel; the user opened one before it restarted
    openRightPanel("user-panel");
    let displaced = false;
    const dispose = openStartupPanel(
      "late-panel",
      () => true,
      undefined,
      () => {
        displaced = true;
      },
      null,
    );

    registerRightPanel({ id: "late-panel", title: "Late Panel", render: () => undefined });
    assert.equal(displaced, true);
    assert.equal(getActiveRightPanel(), "user-panel");
    dispose();
  });

  it("still opens a late floating panel after a right panel opened while waiting", () => {
    let displaced = false;
    const dispose = openStartupPanel(
      "late-floating",
      () => true,
      undefined,
      () => {
        displaced = true;
      },
    );
    registerRightPanel({ id: "user-panel", title: "User Panel", render: () => undefined });
    openRightPanel("user-panel");
    registerFloatingPanel({ id: "late-floating", title: "Late Floating", render: () => undefined });
    assert.equal(displaced, false);
    assert.equal(isFloatingPanelOpen("late-floating"), true);
    assert.equal(getActiveRightPanel(), "user-panel");
    dispose();
  });

  it("still opens a late panel when no other right panel was opened", () => {
    const dispose = openStartupPanel("late-panel", () => true);
    registerRightPanel({ id: "other-panel", title: "Other", render: () => undefined });
    registerRightPanel({ id: "late-panel", title: "Late Panel", render: () => undefined });
    assert.equal(getActiveRightPanel(), "late-panel");
    dispose();
  });

  it("disposer cancels waiting before registration", () => {
    const dispose = openStartupPanel("cancelled-panel", () => true);
    dispose();

    registerRightPanel({
      id: "cancelled-panel",
      title: "Cancelled Panel",
      render: () => undefined,
    });

    assert.equal(getActiveRightPanel(), null);
  });

  it("ignores empty or blank panel ids", () => {
    assert.doesNotThrow(() => {
      const dispose1 = openStartupPanel("");
      dispose1();
      const dispose2 = openStartupPanel("   ");
      dispose2();
    });
  });
});

describe("isStartupPanelGateOpen", () => {
  const ready: StartupPanelGate = {
    viewer: false,
    panelsHidden: false,
    externalPluginsReady: true,
    mapReadyGeneration: 1,
    projectUrlSettled: true,
    startupProjectSettled: true,
  };

  it("opens once every readiness signal is set", () => {
    assert.equal(isStartupPanelGateOpen(ready), true);
  });

  it("stays closed while any signal blocks it", () => {
    const blockers: Partial<StartupPanelGate>[] = [
      { viewer: true },
      { panelsHidden: true },
      { externalPluginsReady: false },
      { mapReadyGeneration: 0 },
      { projectUrlSettled: false },
      { startupProjectSettled: false },
    ];
    for (const blocker of blockers) {
      assert.equal(
        isStartupPanelGateOpen({ ...ready, ...blocker }),
        false,
        JSON.stringify(blocker),
      );
    }
  });
});
