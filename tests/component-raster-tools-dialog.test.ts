import { act, cleanup, render, screen, fireEvent, useAppStore, i18n, waitFor } from "./helpers/dom";
import { setSidecarFetch } from "@geolibre/processing";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";

const { RasterToolsDialog } =
  await import("../apps/geolibre-desktop/src/components/processing/RasterToolsDialog");

describe("Raster tools browser inputs", () => {
  it("tracks a dispatched sidecar job to completion after permission is revoked", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    useAppStore.getState().resetAppCapabilities();
    useAppStore.setState({ processingHistory: [] });
    let started = 0;
    let polled = 0;
    const job = {
      id: "raster-permission-job",
      tool_id: "hillshade",
      status: "running",
      messages: [],
      outputs: {},
      created_at: "2026-01-01",
      updated_at: "2026-01-01",
    };
    setSidecarFetch(async (input) => {
      const url = String(input);
      if (url.endsWith("/raster/status"))
        return Response.json({ available: true, message: "Runtime available" });
      if (url.endsWith("/raster/run")) {
        started += 1;
        return Response.json(job);
      }
      if (url.endsWith(`/conversion/jobs/${job.id}`)) {
        polled += 1;
        return Response.json({ ...job, status: "succeeded" });
      }
      throw new Error(`Unexpected sidecar request ${url}`);
    });
    try {
      useAppStore.getState().setRasterToolOpen("hillshade");
      render(createElement(RasterToolsDialog, { mapControllerRef: { current: null } }));
      await waitFor(() =>
        assert.equal(
          (screen.getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled,
          false,
        ),
      );
      const input = document.getElementById("raster-input") as HTMLInputElement;
      const output = document.getElementById("raster-output") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "/tmp/input.tif" } });
      fireEvent.change(output, { target: { value: "/tmp/output.tif" } });
      fireEvent.click(screen.getByRole("button", { name: "Run" }));
      await waitFor(() => assert.equal(started, 1));
      await screen.findByText("running");
      act(() => useAppStore.getState().revokeAppPrivilege("processing:sidecar"));
      assert.equal(
        (document.getElementById("raster-input") as HTMLInputElement).value,
        "/tmp/input.tif",
      );
      assert.equal(
        (document.getElementById("raster-output") as HTMLInputElement).value,
        "/tmp/output.tif",
      );
      await waitFor(
        () => assert.equal(useAppStore.getState().processingHistory[0]?.status, "success"),
        { timeout: 4000 },
      );
      assert.equal(polled, 1);
      assert.equal(started, 1);
      assert.equal(
        (screen.getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled,
        true,
      );
    } finally {
      cleanup();
      setSidecarFetch(null);
      Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
      useAppStore.getState().resetAppCapabilities();
    }
  });
  it("keeps sidecar execution disabled when switching from SAR to a classic tool without permission", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    useAppStore.getState().revokeAppPrivilege("processing:sidecar");
    try {
      useAppStore.getState().setRasterToolOpen("sar-db");
      render(createElement(RasterToolsDialog, { mapControllerRef: { current: null } }));
      fireEvent.click(
        await screen.findByRole("button", { name: i18n.t("toolbar.rasterTool.reproject") }),
      );
      const option = await screen.findByRole("option", {
        name: i18n.t("toolbar.rasterTool.engineSidecar"),
      });
      assert.equal((option as HTMLOptionElement).disabled, true);
      await waitFor(() =>
        assert.equal(
          (
            screen.getByRole("option", {
              name: i18n.t("toolbar.rasterTool.engineClient"),
            }) as HTMLOptionElement
          ).selected,
          true,
        ),
      );
      assert.equal(
        screen.queryByRole("button", { name: i18n.t("toolbar.rasterTool.startServer") }),
        null,
      );
    } finally {
      Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
      useAppStore.getState().resetAppCapabilities();
    }
  });
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
