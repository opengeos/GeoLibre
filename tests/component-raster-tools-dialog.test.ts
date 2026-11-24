import { render, screen, fireEvent, useAppStore, i18n, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";

const { RasterToolsDialog } =
  await import("../apps/geolibre-desktop/src/components/processing/RasterToolsDialog");

describe("Raster tools browser inputs", () => {
  it("asks for GeoJSON zones alongside a GeoTIFF raster", async () => {
    useAppStore.getState().setRasterToolOpen("zonal");
    render(createElement(RasterToolsDialog, { mapControllerRef: { current: null } }));
    assert.ok(await screen.findByPlaceholderText(i18n.t("toolbar.rasterTool.chooseGeoJson")));
    assert.ok(screen.getByPlaceholderText(i18n.t("toolbar.rasterTool.chooseGeoTiff")));
  });
  it("uses a GeoJSON input for interpolation and resets to a raster input for SAR", async () => {
    useAppStore.getState().setRasterToolOpen("interpolate");
    render(createElement(RasterToolsDialog, { mapControllerRef: { current: null } }));

    const input = await screen.findByPlaceholderText(i18n.t("toolbar.rasterTool.chooseGeoJson"));
    assert.equal((input as HTMLInputElement).readOnly, true);
    const client = screen.getByRole("option", { name: i18n.t("toolbar.rasterTool.engineClient") });
    assert.equal((client as HTMLOptionElement).selected, true);
    assert.equal((screen.getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled, true);

    fireEvent.click(screen.getByRole("button", { name: i18n.t("toolbar.rasterTool.sarDb") }));
    await screen.findByText(i18n.t("toolbar.rasterTool.clientOnlyHint"));
    await waitFor(() =>
      assert.equal(screen.queryByPlaceholderText(i18n.t("toolbar.rasterTool.chooseGeoJson")), null),
    );
    assert.ok(screen.getByPlaceholderText(i18n.t("toolbar.rasterTool.chooseGeoTiff")));
    assert.equal(
      screen.queryByRole("option", { name: i18n.t("toolbar.rasterTool.engineSidecar") }),
      null,
    );
    assert.equal((screen.getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled, true);
  });
});
