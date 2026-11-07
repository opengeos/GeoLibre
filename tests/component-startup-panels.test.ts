import "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { renderHook } from "@testing-library/react";
import { createEmptyProject, useAppStore } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import {
  __resetRightPanelRegistryForTests,
  getActiveRightPanel,
  openRightPanel,
  registerRightPanel,
} from "@geolibre/plugins/right-panel-registry";
import { __resetFloatingPanelRegistryForTests } from "@geolibre/plugins/floating-panel-registry";
import { setDeploymentPolicy } from "../apps/geolibre-desktop/src/lib/deployment-env";

const { useStartupPanels } =
  await import("../apps/geolibre-desktop/src/hooks/desktop-shell/useStartupPanels");

type Props = Parameters<typeof useStartupPanels>[0];

const mapControllerRef = { current: {} as MapEngine };
const ready: Props = {
  mapControllerRef,
  viewer: false,
  externalPluginsReady: true,
  mapReadyGeneration: 1,
  projectUrlSettled: true,
  startupProjectSettled: true,
};

function registerPanel(id: string): void {
  registerRightPanel({ id, title: id, render: () => undefined });
}

describe("useStartupPanels deployment openPanel", () => {
  const originalWarn = console.warn;

  beforeEach(() => {
    __resetRightPanelRegistryForTests();
    __resetFloatingPanelRegistryForTests();
    setDeploymentPolicy({ version: 1, plugins: { openPanel: "org-panel" } });
    console.warn = () => {};
  });

  afterEach(() => {
    setDeploymentPolicy(null);
    console.warn = originalWarn;
  });

  it("waits for the startup restore to settle before opening", () => {
    registerPanel("org-panel");
    const { rerender, unmount } = renderHook((props: Props) => useStartupPanels(props), {
      initialProps: { ...ready, startupProjectSettled: false } as Props,
    });
    assert.equal(getActiveRightPanel(), null);

    rerender({ ...ready });
    assert.equal(getActiveRightPanel(), "org-panel");
    unmount();
  });

  it("opens a late-registering panel in a fresh project", () => {
    const { unmount } = renderHook((props: Props) => useStartupPanels(props), {
      initialProps: ready,
    });
    registerPanel("org-panel");
    assert.equal(getActiveRightPanel(), "org-panel");
    unmount();
  });

  it("does not open after a saved project loads while waiting", () => {
    const { unmount } = renderHook((props: Props) => useStartupPanels(props), {
      initialProps: ready,
    });
    useAppStore.getState().loadProject(createEmptyProject("Saved"));
    registerPanel("org-panel");
    assert.equal(getActiveRightPanel(), null);
    unmount();
  });

  it("keeps the first baseline when the wait restarts after the user opened a panel", () => {
    const { rerender, unmount } = renderHook((props: Props) => useStartupPanels(props), {
      initialProps: ready,
    });
    // The map remounts: the gate closes and the pending wait is torn down
    rerender({ ...ready, mapReadyGeneration: 0 });
    registerPanel("user-panel");
    openRightPanel("user-panel");

    // The map is ready again and the wait restarts
    rerender({ ...ready, mapReadyGeneration: 2 });
    registerPanel("org-panel");
    assert.equal(getActiveRightPanel(), "user-panel");
    unmount();
  });

  it("is ignored in the viewer preset", () => {
    registerPanel("org-panel");
    const { unmount } = renderHook((props: Props) => useStartupPanels(props), {
      initialProps: { ...ready, viewer: true },
    });
    assert.equal(getActiveRightPanel(), null);
    unmount();
  });
});
