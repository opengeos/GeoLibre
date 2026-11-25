import { act, fireEvent, screen, useAppStore } from "./helpers/dom";
import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement, type ComponentProps } from "react";
import { render } from "@testing-library/react";

const { ControlsMenu } =
  await import("../apps/geolibre-desktop/src/components/layout/toolbar/ControlsMenu");
const { useToolbarPanels } = await import("../apps/geolibre-desktop/src/hooks/useToolbarPanels");
const { createAppAPI } = await import("../apps/geolibre-desktop/src/hooks/usePlugins");
const { DEFAULT_EFFECTS_SETTINGS } =
  await import("../packages/plugins/src/plugins/maplibre-effects");

type Props = ComponentProps<typeof ControlsMenu>;
const noop = () => {};
const app = createAppAPI({ current: null });

function Menu({ directionsActive = false }: { directionsActive?: boolean }) {
  const panels = useToolbarPanels(app);
  const props: Props = {
    chrome: { buttonClass: "", buttonSize: "sm", iconClassName: "", renderLabel: (label) => label },
    controlsVisible: {
      navigation: false,
      fullscreen: false,
      compass: false,
      geolocate: false,
      globe: false,
      terrain: false,
      scale: false,
      attribution: false,
      logo: false,
      "maptoolkit-logo": false,
    },
    panels,
    effectsActive: false,
    layerControlActive: false,
    directionsActive,
    reverseGeocodeActive: false,
    graticuleActive: false,
    cloudsActive: false,
    precipitationActive: false,
    onToggleMapControl: noop,
    onToggleLayerControl: noop,
    onToggleEffects: noop,
    getEffectsSettings: () => ({ ...DEFAULT_EFFECTS_SETTINGS }),
    onPreviewEffectsSettings: noop,
    onCommitEffectsSettings: noop,
    onToggleDirections: noop,
    onToggleReverseGeocode: noop,
    onToggleGraticule: noop,
    onTogglePointerElevation: noop,
    onToggleClouds: noop,
    onTogglePrecipitation: noop,
    onOpenFieldCollection: noop,
    onOpenGpsTracking: noop,
    onOpenRecordTour: noop,
    onOpenRecordVideo: noop,
  };
  return createElement(ControlsMenu, props);
}

it("uses catalog engine capabilities and keeps an unsupported active plugin reachable", async () => {
  useAppStore.getState().setPrimaryRenderer("arcgis");
  const view = render(createElement(Menu));
  fireEvent.keyDown(screen.getByRole("button", { name: "Controls" }), { key: "Enter" });
  const directions = await screen.findByRole("menuitem", { name: "Directions" });
  assert.equal(directions.getAttribute("aria-disabled"), "true");
  assert.notEqual(
    screen.getByRole("menuitem", { name: "Layer control" }).getAttribute("aria-disabled"),
    "true",
  );
  assert.notEqual(
    screen.getByRole("menuitem", { name: "Reverse geocode" }).getAttribute("aria-disabled"),
    "true",
  );
  act(() => useAppStore.getState().setPrimaryRenderer("maplibre"));
  assert.notEqual(
    screen.getByRole("menuitem", { name: "Directions" }).getAttribute("aria-disabled"),
    "true",
  );
  act(() => useAppStore.getState().setPrimaryRenderer("arcgis"));
  view.rerender(createElement(Menu, { directionsActive: true }));
  assert.notEqual(
    screen.getByRole("menuitem", { name: /Directions.*✓/ }).getAttribute("aria-disabled"),
    "true",
  );
});
