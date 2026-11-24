import { act, fireEvent, i18n, render, screen, useAppStore } from "./helpers/dom";
import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";

const { CogoTracePanel } =
  await import("../apps/geolibre-desktop/src/components/layout/CogoTracePanel");
const { useCogoTool } = await import("../apps/geolibre-desktop/src/lib/cogo-store");

it("constructs a line from a typed traverse and saves it as a layer", () => {
  useAppStore.setState({ primaryRenderer: "maplibre" });
  useCogoTool.getState().openCogo({ lng: -83.92, lat: 35.96 });
  const view = render(
    createElement(CogoTracePanel, {
      mapControllerRef: { current: null },
      mapReadyGeneration: 0,
    }),
  );
  try {
    fireEvent.change(screen.getByLabelText(i18n.t("cogo.geometry")), { target: { value: "line" } });
    fireEvent.change(screen.getByLabelText(i18n.t("cogo.bearing")), { target: { value: "90" } });
    fireEvent.change(screen.getByLabelText(i18n.t("cogo.distance")), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("cogo.addLeg") }));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("cogo.saveLayer") }));
    const layer = useAppStore
      .getState()
      .layers.find((item) => item.geojson?.features[0]?.geometry.type === "LineString");
    assert.ok(layer?.geojson);
    const geometry = layer.geojson.features[0].geometry;
    assert.equal(geometry.type, "LineString");
    if (geometry.type !== "LineString") throw Error("Expected line geometry");
    assert.equal(geometry.coordinates.length, 2);
    assert.ok(geometry.coordinates[1][0] > geometry.coordinates[0][0]);
  } finally {
    view.unmount();
    act(() => useCogoTool.getState().closeCogo());
  }
});
