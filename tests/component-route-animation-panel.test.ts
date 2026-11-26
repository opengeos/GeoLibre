import { act, fireEvent, render, screen, useAppStore, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createElement } from "react";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import type { GeoLibreAppAPI } from "@geolibre/plugins";

// Loaded after the harness so the panel's CSS imports and Vite globals resolve.
const { RouteAnimationPanel } =
  await import("../apps/geolibre-desktop/src/components/panels/RouteAnimationPanel");
const routeAnimation = await import("@geolibre/plugins/maplibre-route-animation");

// No map: the panel and its settings work, the marker engine just stays detached.
const noMapApp = { getMap: () => null, getMapboxMap: () => null } as unknown as GeoLibreAppAPI;

afterEach(() => {
  routeAnimation.closeRouteAnimationPanel();
  routeAnimation.setRouteAnimationSettings({
    layerId: null,
    playing: false,
    progress: 0,
    loop: false,
  });
});

function layer(id: string, name: string, geometry: unknown): GeoLibreLayer {
  return {
    id,
    name,
    type: "geojson",
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    geojson: {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: {}, geometry }],
    },
  } as unknown as GeoLibreLayer;
}

const trail = layer("trail", "Ridge trail", {
  type: "LineString",
  coordinates: [
    [-83.5, 35.5],
    [-83.4, 35.6],
    [-83.3, 35.7],
  ],
});
const peaks = layer("peaks", "Peaks", { type: "Point", coordinates: [-83.5, 35.5] });

function renderPanel() {
  return render(createElement(RouteAnimationPanel, { mapControllerRef: { current: null } }));
}

const layerSelect = () => screen.getAllByRole("combobox")[0] as HTMLSelectElement;
const optionLabels = () => Array.from(layerSelect().options).map((option) => option.textContent);

describe("RouteAnimationPanel", () => {
  it("renders only while the panel is open", () => {
    renderPanel();
    assert.equal(screen.queryByRole("button", { name: "Close" }), null);
    act(() => routeAnimation.openRouteAnimationPanel(noMapApp));
    assert.ok(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    assert.equal(routeAnimation.isRouteAnimationPanelVisible(), false);
    assert.equal(screen.queryByRole("button", { name: "Close" }), null);
  });

  it("offers only line layers and explains when there are none", async () => {
    act(() => useAppStore.setState({ layers: [peaks] }));
    act(() => routeAnimation.openRouteAnimationPanel(noMapApp));
    renderPanel();
    await waitFor(() => assert.deepEqual(optionLabels(), ["No line layers in the project"]));
    act(() => useAppStore.setState({ layers: [peaks, trail] }));
    await waitFor(() => assert.deepEqual(optionLabels(), ["Select a line layer…", "Ridge trail"]));
  });

  it("selects a route, plays and pauses it, and toggles looping", async () => {
    act(() => useAppStore.setState({ layers: [trail] }));
    act(() => routeAnimation.openRouteAnimationPanel(noMapApp));
    renderPanel();
    await waitFor(() => assert.equal(optionLabels().length, 2));
    fireEvent.change(layerSelect(), { target: { value: "trail" } });
    assert.equal(routeAnimation.getRouteAnimationSnapshot().layerId, "trail");

    const play = screen.getAllByRole("button", { name: "Play" })[0]!;
    fireEvent.click(play);
    assert.equal(routeAnimation.getRouteAnimationSnapshot().playing, true);
    fireEvent.click(screen.getAllByRole("button", { name: "Pause" })[0]!);
    assert.equal(routeAnimation.getRouteAnimationSnapshot().playing, false);

    const loopBefore = routeAnimation.getRouteAnimationSnapshot().loop;
    fireEvent.click(screen.getByRole("button", { name: "Loop animation" }));
    assert.equal(routeAnimation.getRouteAnimationSnapshot().loop, !loopBefore);
  });

  it("clears the selection when its layer is removed from the project", async () => {
    act(() => useAppStore.setState({ layers: [trail] }));
    act(() => routeAnimation.openRouteAnimationPanel(noMapApp));
    routeAnimation.setRouteAnimationSettings({ layerId: "trail" });
    renderPanel();
    await waitFor(() => assert.equal(layerSelect().value, "trail"));
    act(() => useAppStore.setState({ layers: [] }));
    await waitFor(() => assert.equal(routeAnimation.getRouteAnimationSnapshot().layerId, null));
  });

  it("collapses to the header", () => {
    act(() => routeAnimation.openRouteAnimationPanel(noMapApp));
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
    assert.ok(screen.getByRole("button", { name: "Expand" }));
    assert.equal(screen.queryAllByRole("combobox").length, 0);
  });
});
