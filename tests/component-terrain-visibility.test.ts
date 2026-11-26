/**
 * The Earth model shared by the right-click viewshed and the Line of Sight
 * panel (issue #3530): the menu toggle and the panel's fields edit one
 * device-local setting, and it survives a reload through localStorage.
 */

import { act, fireEvent, i18n, render, screen, useAppStore, within } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createElement } from "react";

const { MapContextMenu } =
  await import("../apps/geolibre-desktop/src/components/layout/MapContextMenu");
const { DEFAULT_TERRAIN_VISIBILITY, readTerrainVisibility, useTerrainVisibility } =
  await import("../apps/geolibre-desktop/src/lib/terrain-visibility-settings");

afterEach(() => {
  act(() => useTerrainVisibility.getState().reset());
});

it("reads clamped settings and falls back on bad storage", () => {
  assert.deepEqual(readTerrainVisibility(), DEFAULT_TERRAIN_VISIBILITY);
  localStorage.setItem(
    "geolibre:terrain-visibility",
    JSON.stringify({ curvature: false, refractionCoefficient: 7, earthRadiusMeters: "x" }),
  );
  const stored = readTerrainVisibility();
  assert.equal(stored.curvature, false);
  assert.equal(stored.refractionCoefficient, 0.99, "clamped below 1");
  assert.equal(stored.earthRadiusMeters, DEFAULT_TERRAIN_VISIBILITY.earthRadiusMeters);
  localStorage.setItem("geolibre:terrain-visibility", "{broken");
  assert.deepEqual(readTerrainVisibility(), DEFAULT_TERRAIN_VISIBILITY);
});

it("persists an update", () => {
  act(() => useTerrainVisibility.getState().update({ refractionCoefficient: 0.2 }));
  assert.equal(useTerrainVisibility.getState().refractionCoefficient, 0.2);
  assert.equal(readTerrainVisibility().refractionCoefficient, 0.2);
  // An undefined key keeps the stored value rather than resetting it.
  act(() => useTerrainVisibility.getState().update({ refractionCoefficient: undefined }));
  assert.equal(useTerrainVisibility.getState().refractionCoefficient, 0.2);
});

it("toggles viewshed curvature from the right-click menu", async () => {
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  const engine = {
    getRenderSurface: () => ({
      getCanvas: () => canvas,
      unproject: () => ({ lng: -83.92, lat: 35.96 }),
    }),
    getZoom: () => 12,
  };
  useAppStore.setState({ primaryRenderer: "maplibre" });
  const view = render(
    createElement(MapContextMenu, {
      mapControllerRef: { current: engine as never },
      mapReadyGeneration: 0,
    }),
  );
  try {
    fireEvent.contextMenu(canvas, { clientX: 100, clientY: 100 });
    const trigger = await screen.findByRole("menuitem", { name: i18n.t("quickAnalysis.menu") });
    await act(async () => trigger.focus());
    fireEvent.keyDown(trigger, { key: "ArrowRight" });
    const menu = await screen.findByRole("menu", { name: i18n.t("quickAnalysis.menu") });
    const toggle = await within(menu).findByRole("menuitemcheckbox", {
      name: i18n.t("quickAnalysis.viewshedCurvature"),
    });
    assert.equal(toggle.getAttribute("aria-checked"), "true");
    fireEvent.click(toggle);
    assert.equal(useTerrainVisibility.getState().curvature, false);
    assert.equal(readTerrainVisibility().curvature, false);
    // The menu stays open so the change shows before a radius is picked.
    assert.equal(toggle.getAttribute("aria-checked"), "false");
  } finally {
    view.unmount();
    canvas.remove();
  }
});

it("toggles viewshed curvature from the touch long-press sheet", async () => {
  const { MapContextTouchSheet } =
    await import("../apps/geolibre-desktop/src/components/layout/mobile/MapContextTouchSheet");
  const noop = () => {};
  const view = render(
    createElement(MapContextTouchSheet, {
      open: true,
      onOpenChange: noop,
      coordLabel: "35.96, -83.92",
      hasExplorePlace: false,
      lineOfSightAvailable: true,
      viewshedBusy: false,
      bufferPresets: [],
      viewshedRadiiMeters: [2000],
      formatDistance: () => "",
      formatViewshedRadius: () => "2 km",
      onCopyCoords: noop,
      onExplorePlace: noop,
      onCopyGeoJson: noop,
      onCenterHere: noop,
      onZoomInHere: noop,
      onDirections: noop,
      onBufferHere: noop,
      onTravelTimeHere: noop,
      onViewshedHere: noop,
      onLineOfSightHere: noop,
      onOpenBufferProcessing: noop,
      onViewInGoogleMaps: noop,
      onViewInGoogleEarth: noop,
    }),
  );
  try {
    fireEvent.click(await screen.findByText(i18n.t("quickAnalysis.menu")));
    fireEvent.click(await screen.findByText(i18n.t("quickAnalysis.viewshedCurvature")));
    assert.equal(useTerrainVisibility.getState().curvature, false);
  } finally {
    view.unmount();
  }
});
