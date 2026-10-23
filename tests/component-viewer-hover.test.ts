import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { fireEvent, render, screen, useAppStore } from "./helpers/dom";

const { ViewerLayerPanel } =
  await import("../apps/geolibre-desktop/src/components/panels/ViewerLayerPanel");

it("lets a viewer pause and restore project hover tips", () => {
  useAppStore.getState().newProject({ name: "Viewer hovers" });
  const id = useAppStore.getState().addGeoJsonLayer("Rivers", {
    type: "FeatureCollection",
    features: [],
  });
  useAppStore.getState().setLayerPopup(id, { hover: true });
  render(createElement(ViewerLayerPanel, { mapControllerRef: { current: null } }));

  const toggle = screen.getByRole("checkbox", { name: "Hover tooltips" });
  fireEvent.click(toggle);
  assert.equal(useAppStore.getState().hoverTooltipsEnabled, false);
  assert.equal(useAppStore.getState().layers[0].popup?.hover, true);
  fireEvent.click(toggle);
  assert.equal(useAppStore.getState().hoverTooltipsEnabled, true);
});

it("hides the hover switch when no layer shows hover tips", () => {
  useAppStore.getState().newProject({ name: "No hovers" });
  useAppStore.getState().addGeoJsonLayer("Rivers", { type: "FeatureCollection", features: [] });
  render(createElement(ViewerLayerPanel, { mapControllerRef: { current: null } }));
  assert.equal(screen.queryByText("Hover tooltips"), null);
});
