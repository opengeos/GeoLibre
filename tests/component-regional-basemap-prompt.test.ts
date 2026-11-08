import { act, fireEvent, render, screen, useAppStore } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { renderHook } from "@testing-library/react";
import { createElement } from "react";

// Loaded after the harness so its CSS imports and Vite globals are handled.
const { RegionalBasemapPrompt } =
  await import("../apps/geolibre-desktop/src/components/layout/RegionalBasemapPrompt");
const { RegionalBasemapSection } =
  await import("../apps/geolibre-desktop/src/components/panels/RegionalBasemapSection");
const { CHINA_BASEMAPS, DEFAULT_BASEMAP, createEmptyProject } = await import("@geolibre/core");
const { useNotificationStore } = await import("../apps/geolibre-desktop/src/lib/notify");
const { useLastBasemapPersistence } =
  await import("../apps/geolibre-desktop/src/hooks/useLastBasemapPersistence");
const { readLastBasemap } = await import("../apps/geolibre-desktop/src/lib/last-basemap");
const { LAST_BASEMAP_STORAGE_KEY } = await import("../apps/geolibre-desktop/src/lib/storage-keys");

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
    // Selecting one auto-expands the section, so its buttons are rendered.
    const view = render(
      createElement(RegionalBasemapSection, { selectedId: AMAP.id, onSelect: () => {} }),
    );
    assert.ok(screen.queryByText("Regional"));
    for (const basemap of CHINA_BASEMAPS) {
      assert.ok(screen.queryByRole("button", { name: basemap.name }), basemap.id);
    }
    act(() => useAppStore.getState().setRegionalBasemapPolicy("block"));
    assert.equal(screen.queryByText("Regional"), null);
    for (const basemap of CHINA_BASEMAPS) {
      assert.equal(screen.queryByRole("button", { name: basemap.name }), null, basemap.id);
    }
    view.unmount();
  });
});

describe("useLastBasemapPersistence", () => {
  beforeEach(() => {
    window.localStorage.removeItem(LAST_BASEMAP_STORAGE_KEY);
    useAppStore.getState().newProject();
    useAppStore.getState().setRegionalBasemapPolicy("prompt");
  });
  afterEach(() => {
    useAppStore.getState().setRegionalBasemapPolicy("allow");
    useAppStore.getState().newProject();
  });

  it("remembers a regional basemap the user picked or accepted, not one a load applied", () => {
    const hook = renderHook(() => useLastBasemapPersistence());
    act(() => {
      useAppStore
        .getState()
        .loadProject(createEmptyProject("Embed", { basemapStyleUrl: AMAP.styleUrl }), null, {
          trustBasemap: true,
        });
    });
    assert.equal(useAppStore.getState().basemapStyleUrl, AMAP.styleUrl);
    assert.notEqual(readLastBasemap(), AMAP.styleUrl);

    // A live-collaboration snapshot writes the store directly, with no
    // generation bump; it must not be remembered either.
    act(() => useAppStore.setState({ basemapStyleUrl: DEFAULT_BASEMAP }));
    act(() => useAppStore.setState({ basemapStyleUrl: AMAP.styleUrl }));
    assert.notEqual(readLastBasemap(), AMAP.styleUrl);

    act(() => useAppStore.getState().setBasemapStyleUrl(DEFAULT_BASEMAP));
    act(() => useAppStore.getState().setBasemapStyleUrl(AMAP.styleUrl));
    assert.equal(readLastBasemap(), AMAP.styleUrl);

    openRegionalProject();
    act(() => useAppStore.getState().resolveRegionalBasemapHold(true));
    assert.equal(readLastBasemap(), AMAP.styleUrl);
    hook.unmount();
  });
});
