import { act, fireEvent, render, screen, useAppStore } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createElement } from "react";

// Loaded after the harness so its CSS imports and Vite globals are handled.
const { RegionalBasemapPrompt } =
  await import("../apps/geolibre-desktop/src/components/layout/RegionalBasemapPrompt");
const { RegionalBasemapSection } =
  await import("../apps/geolibre-desktop/src/components/panels/RegionalBasemapSection");
const { CHINA_BASEMAPS, DEFAULT_BASEMAP, createEmptyProject } = await import("@geolibre/core");
const { useNotificationStore } = await import("../apps/geolibre-desktop/src/lib/notify");

const AMAP = CHINA_BASEMAPS.find((basemap) => basemap.id === "amap-street")!;

function openRegionalProject() {
  act(() => {
    useAppStore
      .getState()
      .loadProject(createEmptyProject("Shared", { basemapStyleUrl: AMAP.styleUrl }));
  });
}

describe("RegionalBasemapPrompt", () => {
  beforeEach(() => {
    useAppStore.getState().newProject();
    useAppStore.getState().setRegionalBasemapPolicy("prompt");
  });
  afterEach(() => {
    useAppStore.getState().setRegionalBasemapPolicy("allow");
    useAppStore.getState().newProject();
  });

  it("names the provider and loads the basemap on Load", async () => {
    render(createElement(RegionalBasemapPrompt));
    openRegionalProject();
    const dialog = await screen.findByRole("dialog");
    assert.match(dialog.textContent ?? "", /Amap tiles \(高德地图\)/);
    assert.equal(useAppStore.getState().basemapStyleUrl, DEFAULT_BASEMAP);
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    assert.equal(useAppStore.getState().basemapStyleUrl, AMAP.styleUrl);
    assert.equal(useAppStore.getState().regionalBasemapHold, null);
  });

  it("keeps the default basemap on Use default basemap", async () => {
    render(createElement(RegionalBasemapPrompt));
    openRegionalProject();
    fireEvent.click(await screen.findByRole("button", { name: "Use default basemap" }));
    assert.equal(useAppStore.getState().basemapStyleUrl, DEFAULT_BASEMAP);
    assert.equal(useAppStore.getState().regionalBasemapHold, null);
    assert.equal(screen.queryByRole("dialog"), null);
  });

  it("shows a notice instead of a prompt when the deployment blocks them", () => {
    useAppStore.getState().setRegionalBasemapPolicy("block");
    render(createElement(RegionalBasemapPrompt));
    openRegionalProject();
    assert.equal(screen.queryByRole("dialog"), null);
    assert.equal(useAppStore.getState().basemapStyleUrl, DEFAULT_BASEMAP);
    assert.equal(useAppStore.getState().regionalBasemapHold, null);
    const notices = useNotificationStore.getState().notifications;
    assert.ok(notices.some((notice) => /this deployment disables/.test(notice.message)));
  });
});

describe("RegionalBasemapSection", () => {
  afterEach(() => useAppStore.getState().setRegionalBasemapPolicy("allow"));

  it("lists the regional basemaps unless the deployment disabled them", () => {
    const view = render(createElement(RegionalBasemapSection, { onSelect: () => {} }));
    assert.ok(screen.queryByText("Regional"));
    act(() => useAppStore.getState().setRegionalBasemapPolicy("block"));
    assert.equal(screen.queryByText("Regional"), null);
    view.unmount();
  });
});
