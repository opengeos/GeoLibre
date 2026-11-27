import { act, cleanup, render, screen, fireEvent, useAppStore, i18n, waitFor } from "./helpers/dom";
import { setSidecarFetch } from "@geolibre/processing";
import { MAX_CLIENT_VECTOR_BYTES } from "../apps/geolibre-desktop/src/lib/client-raster-inputs";
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { createElement } from "react";

const { RasterToolsDialog } =
  await import("../apps/geolibre-desktop/src/components/processing/RasterToolsDialog");

describe("Raster tools browser inputs", () => {
  it("rejects an oversized GeoJSON file before reading its bytes", async () => {
    let reads = 0;
    mock.method(HTMLInputElement.prototype, "click", function (this: HTMLInputElement) {
      Object.defineProperty(this, "files", {
        configurable: true,
        value: [
          {
            name: "large.geojson",
            size: MAX_CLIENT_VECTOR_BYTES + 1,
            arrayBuffer: async () => {
              reads += 1;
              return new ArrayBuffer(0);
            },
          },
        ],
      });
      this.dispatchEvent(new Event("change"));
    });
    try {
      useAppStore.getState().setRasterToolOpen("interpolate");
      render(createElement(RasterToolsDialog, { mapControllerRef: { current: null } }));
      fireEvent.click(screen.getByTitle(i18n.t("processing.filePicker.chooseInputFile")));
      await screen.findByText(i18n.t("toolbar.rasterTool.vectorMemoryLimit", { limit: 32 }));
      assert.equal(reads, 0);
      assert.equal((document.getElementById("raster-input") as HTMLInputElement).value, "");
    } finally {
      cleanup();
      mock.restoreAll();
    }
  });
  it("drops a primary file read after changing tools", async () => {
    const pending = Promise.withResolvers<ArrayBuffer>();
    mock.method(HTMLInputElement.prototype, "click", function (this: HTMLInputElement) {
      Object.defineProperty(this, "files", {
        configurable: true,
        value: [{ name: "points.geojson", arrayBuffer: () => pending.promise }],
      });
      this.dispatchEvent(new Event("change"));
    });
    try {
      useAppStore.getState().setRasterToolOpen("interpolate");
      render(createElement(RasterToolsDialog, { mapControllerRef: { current: null } }));
      fireEvent.click(screen.getByTitle(i18n.t("processing.filePicker.chooseInputFile")));
      fireEvent.click(screen.getByRole("button", { name: i18n.t("toolbar.rasterTool.sarDb") }));
      await screen.findByText(i18n.t("toolbar.rasterTool.clientOnlyHint"));
      await act(async () => pending.resolve(new ArrayBuffer(8)));
      assert.equal((document.getElementById("raster-input") as HTMLInputElement).value, "");
    } finally {
      cleanup();
      mock.restoreAll();
    }
  });
  it("keeps the newest primary file when reads finish out of order", async () => {
    const reads: ReturnType<typeof Promise.withResolvers<ArrayBuffer>>[] = [];
    mock.method(HTMLInputElement.prototype, "click", function (this: HTMLInputElement) {
      const pending = Promise.withResolvers<ArrayBuffer>();
      reads.push(pending);
      Object.defineProperty(this, "files", {
        configurable: true,
        value: [{ name: `${reads.length}.tif`, arrayBuffer: () => pending.promise }],
      });
      this.dispatchEvent(new Event("change"));
    });
    try {
      useAppStore.getState().setRasterToolOpen("sar-db");
      render(createElement(RasterToolsDialog, { mapControllerRef: { current: null } }));
      fireEvent.click(screen.getByTitle(i18n.t("processing.filePicker.chooseInputFile")));
      fireEvent.click(screen.getByTitle(i18n.t("processing.filePicker.chooseInputFile")));
      assert.equal(reads.length, 2);
      await act(async () => reads[1].resolve(new ArrayBuffer(8)));
      assert.equal((document.getElementById("raster-input") as HTMLInputElement).value, "2.tif");
      await act(async () => reads[0].resolve(new ArrayBuffer(8)));
      assert.equal((document.getElementById("raster-input") as HTMLInputElement).value, "2.tif");
    } finally {
      cleanup();
      mock.restoreAll();
    }
  });
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

  it("runs the compute on a worker with progress and a Cancel button", async () => {
    // A worker the test drives: it records the posted run and answers only
    // when told to, so the dialog's in-flight state can be inspected.
    const workers: ControlledWorker[] = [];
    class ControlledWorker {
      listeners = new Map<string, (event: { data: unknown }) => void>();
      posted: unknown[] = [];
      terminated = false;
      constructor() {
        workers.push(this);
      }
      addEventListener(type: string, listener: (event: { data: unknown }) => void) {
        this.listeners.set(type, listener);
      }
      removeEventListener() {}
      postMessage(message: unknown) {
        this.posted.push(message);
      }
      terminate() {
        this.terminated = true;
      }
      emit(data: unknown) {
        this.listeners.get("message")?.({ data });
      }
    }
    const originalWorker = globalThis.Worker;
    globalThis.Worker = ControlledWorker as unknown as typeof Worker;
    const footprint = new TextEncoder().encode(
      JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { height: 20 },
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [0, 0],
                  [0.0001, 0],
                  [0.0001, 0.0001],
                  [0, 0.0001],
                  [0, 0],
                ],
              ],
            },
          },
        ],
      }),
    );
    mock.method(HTMLInputElement.prototype, "click", function (this: HTMLInputElement) {
      Object.defineProperty(this, "files", {
        configurable: true,
        value: [
          {
            name: "buildings.geojson",
            size: footprint.byteLength,
            arrayBuffer: async () => footprint.slice().buffer,
          },
        ],
      });
      this.dispatchEvent(new Event("change"));
    });
    try {
      useAppStore.getState().setRasterToolOpen("building-shadows");
      render(createElement(RasterToolsDialog, { mapControllerRef: { current: null } }));
      fireEvent.click(screen.getByTitle(i18n.t("processing.filePicker.chooseInputFile")));
      await waitFor(() =>
        assert.equal(
          (document.getElementById("raster-input") as HTMLInputElement).value,
          "buildings.geojson",
        ),
      );
      fireEvent.click(screen.getByRole("button", { name: "Run" }));
      await waitFor(() => assert.equal(workers.length, 1));
      assert.equal((workers[0].posted[0] as { toolId: string }).toolId, "building-shadows");
      assert.ok(await screen.findByText(i18n.t("toolbar.rasterTool.computingInBackground")));

      await act(async () =>
        workers[0].emit({
          type: "progress",
          progress: { stage: "sun-positions", done: 3, total: 12 },
        }),
      );
      assert.ok(
        screen.getByText(i18n.t("toolbar.rasterTool.progressSunPositions", { done: 3, total: 12 })),
      );
      assert.equal(screen.getByRole("progressbar").getAttribute("aria-valuenow"), "25");

      fireEvent.click(screen.getByRole("button", { name: i18n.t("common.cancel") }));
      assert.ok(await screen.findByText(i18n.t("toolbar.rasterTool.cancelled")));
      assert.equal(workers[0].terminated, true);
      assert.equal(screen.queryByRole("progressbar"), null);
      assert.equal(screen.queryByRole("button", { name: i18n.t("common.cancel") }), null);
      assert.equal(
        (screen.getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled,
        false,
      );
    } finally {
      cleanup();
      mock.restoreAll();
      if (originalWorker === undefined) delete (globalThis as { Worker?: typeof Worker }).Worker;
      else globalThis.Worker = originalWorker;
    }
  });
});
