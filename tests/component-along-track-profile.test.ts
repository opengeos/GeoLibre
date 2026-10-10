import { act, fireEvent, render, screen, useAppStore } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import type { GeoLibreLayer } from "@geolibre/core";

// Loaded after the harness so its CSS imports and Vite globals are handled.
const { AlongTrackProfileWindow } =
  await import("../apps/geolibre-desktop/src/components/layout/AlongTrackProfileWindow");
const { openAlongTrackProfile, closeAlongTrackProfile, getAlongTrackProfileLayerId } =
  await import("../apps/geolibre-desktop/src/lib/along-track-profile-store");

function footprint(id: number, beam: string, distance: number, ground: number, canopy: number) {
  return {
    type: "Feature",
    id,
    geometry: { type: "Point", coordinates: [-84 + distance / 100, 35] },
    properties: {
      beam,
      beam_type: beam === "gt1l" ? "strong" : "weak",
      time: "2023-06-29T23:02:40.000Z",
      distance_km: distance,
      h_te_best_fit: ground,
      h_canopy: canopy,
    },
  };
}

const LAYER = {
  id: "atl08",
  name: "ATL08 ATL08_test",
  type: "geojson",
  visible: true,
  opacity: 1,
  source: { type: "geojson" },
  style: {},
  metadata: { sourceKind: "spaceborne-lidar", product: "ATL08", beams: ["gt1l", "gt1r"] },
  geojson: {
    type: "FeatureCollection",
    features: [
      footprint(0, "gt1l", 0, 300, 10),
      footprint(1, "gt1l", 0.1, 302, 12),
      footprint(2, "gt1l", 0.2, 305, 15),
      footprint(3, "gt1r", 0, 310, 5),
      footprint(4, "gt1r", 0.1, 311, 6),
    ],
  },
} as unknown as GeoLibreLayer;

/** Render the window over a store holding the footprint layer. */
function renderWindow() {
  const markers: unknown[] = [];
  const engine = {
    showSearchResult: (geometry: unknown) => {
      markers.push(geometry);
      return () => undefined;
    },
  };
  act(() => {
    useAppStore.setState({ layers: [LAYER] });
    openAlongTrackProfile(LAYER.id);
  });
  render(
    createElement(AlongTrackProfileWindow, { mapControllerRef: { current: engine as never } }),
  );
  return { markers };
}

function beamSelect(): HTMLSelectElement {
  return screen.getByRole("combobox", { name: "Beam" }) as HTMLSelectElement;
}

describe("AlongTrackProfileWindow", () => {
  it("stays closed until a layer's profile is opened", () => {
    act(() => closeAlongTrackProfile());
    render(createElement(AlongTrackProfileWindow, { mapControllerRef: { current: null } }));
    assert.equal(screen.queryByTestId("along-track-profile-window"), null);
  });

  it("opens on the strong beam with ground and canopy top", () => {
    renderWindow();
    assert.ok(screen.getByTestId("along-track-profile-window"));
    assert.equal(beamSelect().value, "gt1l");
    const options = [...beamSelect().options].map((option) => option.textContent);
    assert.deepEqual(options, ["gt1l (strong) · 3", "gt1r (weak) · 2"]);
    assert.ok(screen.getByText("Ground"));
    assert.ok(screen.getByText("Canopy top"));
    assert.ok(screen.getByRole("img", { name: "Along-track profile of beam gt1l" }));
    act(() => closeAlongTrackProfile());
  });

  it("follows a footprint selected on another beam", () => {
    renderWindow();
    act(() => {
      useAppStore.getState().selectLayer(LAYER.id);
      useAppStore.getState().selectFeature("4");
    });
    assert.equal(beamSelect().value, "gt1r");
    act(() => closeAlongTrackProfile());
  });

  it("marks the hovered footprint on the map and selects it on click", async () => {
    const { markers } = renderWindow();
    const svg = screen.getByRole("img", { name: "Along-track profile of beam gt1l" });
    // The plot spans x = 58..584 of the default 600 px; the middle is 0.1 km.
    act(() => {
      fireEvent.pointerMove(svg, { clientX: 321, clientY: 100 });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    assert.deepEqual(markers.at(-1), { type: "Point", coordinates: [-84 + 0.001, 35] });
    act(() => {
      fireEvent.pointerDown(svg, { clientX: 321, clientY: 100, pointerId: 1 });
      fireEvent.pointerUp(svg, { clientX: 321, clientY: 100, pointerId: 1 });
    });
    const state = useAppStore.getState();
    assert.equal(state.selectedLayerId, LAYER.id);
    assert.equal(state.selectedFeatureId, "1");
    act(() => closeAlongTrackProfile());
  });

  it("closes itself when the layer is removed", () => {
    renderWindow();
    act(() => useAppStore.setState({ layers: [] }));
    assert.equal(screen.queryByTestId("along-track-profile-window"), null);
    assert.equal(getAlongTrackProfileLayerId(), null);
  });
});
