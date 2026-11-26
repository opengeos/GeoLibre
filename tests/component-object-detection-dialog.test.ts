import { act, fireEvent, render, screen, useAppStore, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import type { MapEngine } from "@geolibre/map";

const { ObjectDetectionDialog } =
  await import("../apps/geolibre-desktop/src/components/processing/ObjectDetectionDialog");
type Services =
  import("../apps/geolibre-desktop/src/components/processing/ObjectDetectionDialog").ObjectDetectionServices;

/** A 100 x 100 GeoTIFF raster at 1 m per pixel, origin (500000, 4100000). */
const RASTER = {
  bands: [new Float32Array(100 * 100)],
  width: 100,
  height: 100,
  originX: 500000,
  originY: 4100000,
  resX: 1,
  resY: 1,
};

/** Fake decoders, model runtime and picker that record what they were given. */
function fakeServices(
  options: {
    file?: string;
    detections?: Array<{
      bbox: [number, number, number, number];
      classIndex: number;
      score: number;
    }>;
    photoLocation?: [number, number] | null;
    ort?: boolean;
    modelFails?: boolean;
  } = {},
) {
  const calls: Array<{ op: string; detail?: unknown }> = [];
  const services: Services = {
    isOrtAvailable: () => options.ort ?? true,
    readRasterData: (async () => {
      calls.push({ op: "readRaster" });
      return RASTER;
    }) as unknown as Services["readRasterData"],
    readDetectionImage: (async (_bytes: ArrayBuffer, mime: string) => {
      calls.push({ op: "readPhoto", detail: mime });
      return { ...RASTER, originX: 0, originY: 0 };
    }) as unknown as Services["readDetectionImage"],
    readPhotoLocation: async () =>
      options.photoLocation === undefined ? [-122.4, 37.8] : options.photoLocation,
    fetchDetectionModel: async (url) => {
      calls.push({ op: "fetchModel", detail: url });
      if (options.modelFails) throw new Error("offline");
      return new ArrayBuffer(4);
    },
    detectObjects: (async (_raster: unknown, _model: unknown, settings: unknown) => {
      calls.push({ op: "detect", detail: settings });
      return (
        options.detections ?? [
          { bbox: [10, 10, 20, 20], classIndex: 2, score: 0.91 },
          { bbox: [40, 40, 60, 50], classIndex: 2, score: 0.8 },
          { bbox: [70, 5, 90, 25], classIndex: 0, score: 0.66 },
        ]
      );
    }) as unknown as Services["detectObjects"],
    openLocalDataFile: (async () => ({
      data: new ArrayBuffer(16),
      path: `/imagery/${options.file ?? "parking.tif"}`,
    })) as Services["openLocalDataFile"],
    // Identity: the test raster's coordinates are kept as they are.
    reprojectToWgs84: async (collection) => {
      calls.push({ op: "reproject" });
      return collection;
    },
  };
  return { services, calls };
}

function renderDialog(services: Services) {
  act(() => useAppStore.getState().setObjectDetectionOpen(true));
  const fitted: unknown[] = [];
  const engine = { fitBounds: (bounds: unknown) => fitted.push(bounds) } as unknown as MapEngine;
  render(createElement(ObjectDetectionDialog, { mapControllerRef: { current: engine }, services }));
  return fitted;
}

const text = () => document.body.textContent ?? "";
const detect = () => fireEvent.click(screen.getByRole("button", { name: "Detect" }));
const layerNames = () => useAppStore.getState().layers.map((layer) => layer.name);

describe("ObjectDetectionDialog", () => {
  it("keeps Detect disabled until an image is chosen", async () => {
    renderDialog(fakeServices().services);
    const detectButton = () => screen.getByRole("button", { name: "Detect" });
    assert.equal(detectButton().hasAttribute("disabled"), true);
    fireEvent.click(screen.getByTitle("Choose image"));
    await waitFor(() => assert.equal(detectButton().hasAttribute("disabled"), false));
  });

  it("detects objects in a GeoTIFF with the built-in model and adds one layer per class", async () => {
    const { services, calls } = fakeServices();
    const fitted = renderDialog(services);
    fireEvent.click(screen.getByTitle("Choose image"));
    await waitFor(() =>
      assert.equal(
        (screen.getByLabelText(/Image \(GeoTIFF/) as HTMLInputElement).value,
        "parking.tif",
      ),
    );
    fireEvent.change(screen.getByLabelText("Class names (comma-separated, optional)"), {
      target: { value: "person, bicycle, car" },
    });
    detect();
    await waitFor(() => assert.ok(text().includes("Added 3 detection(s) across 2 class(es).")));
    assert.deepEqual(
      calls.map((c) => c.op),
      ["readRaster", "fetchModel", "detect", "reproject"],
    );
    assert.equal((calls[2]!.detail as { confidenceThreshold: number }).confidenceThreshold, 0.25);
    assert.deepEqual(layerNames().sort(), ["Detection: car", "Detection: person"]);
    const cars = useAppStore.getState().layers.find((l) => l.name === "Detection: car")!;
    assert.equal(cars.geojson?.features.length, 2);
    // The union of the three boxes (pixel x 10-90, y 5-50) through the 1 m geotransform.
    assert.deepEqual(fitted[0], [500010, 4099950, 500090, 4099995]);
  });

  it("places detections in a geotagged photo at its GPS location", async () => {
    const { services, calls } = fakeServices({
      file: "street.jpg",
      detections: [{ bbox: [1, 1, 5, 5], classIndex: 0, score: 0.7 }],
    });
    renderDialog(services);
    fireEvent.click(screen.getByTitle("Choose image"));
    await waitFor(() =>
      assert.equal(
        (screen.getByLabelText(/Image \(GeoTIFF/) as HTMLInputElement).value,
        "street.jpg",
      ),
    );
    detect();
    await waitFor(() => assert.ok(text().includes("Added 1 detection(s) across 1 class(es).")));
    assert.equal(calls[0]!.detail, "image/jpeg");
    assert.ok(!calls.some((c) => c.op === "reproject"));
    const layer = useAppStore.getState().layers[0]!;
    const point = layer.geojson!.features[0]!.geometry as { type: string; coordinates: number[] };
    assert.equal(point.type, "Point");
    assert.deepEqual(point.coordinates, [-122.4, 37.8]);
  });

  it("reports a photo without GPS coordinates", async () => {
    renderDialog(fakeServices({ file: "indoor.jpg", photoLocation: null }).services);
    fireEvent.click(screen.getByTitle("Choose image"));
    await waitFor(() =>
      assert.equal(
        (screen.getByLabelText(/Image \(GeoTIFF/) as HTMLInputElement).value,
        "indoor.jpg",
      ),
    );
    detect();
    await waitFor(() => assert.ok(text().includes("This photo has no usable GPS coordinates.")));
  });

  it("reports when nothing is detected", async () => {
    renderDialog(fakeServices({ detections: [] }).services);
    fireEvent.click(screen.getByTitle("Choose image"));
    await waitFor(() =>
      assert.equal(
        (screen.getByLabelText(/Image \(GeoTIFF/) as HTMLInputElement).value,
        "parking.tif",
      ),
    );
    detect();
    await waitFor(() => assert.ok(text().includes("No objects detected.")));
    assert.equal(useAppStore.getState().layers.length, 0);
  });

  it("reports a model that cannot be downloaded, and needs a local model file when chosen", async () => {
    renderDialog(fakeServices({ modelFails: true }).services);
    fireEvent.click(screen.getByTitle("Choose image"));
    await waitFor(() =>
      assert.equal(
        (screen.getByLabelText(/Image \(GeoTIFF/) as HTMLInputElement).value,
        "parking.tif",
      ),
    );
    detect();
    await waitFor(() => assert.ok(text().includes("Could not download the model.")));
    // A local model source needs its own file before Detect is enabled.
    fireEvent.change(document.getElementById("det-model-source")!, { target: { value: "local" } });
    assert.equal(screen.getByRole("button", { name: "Detect" }).hasAttribute("disabled"), true);
    fireEvent.click(screen.getByTitle("Choose model"));
    await waitFor(() =>
      assert.equal(screen.getByRole("button", { name: "Detect" }).hasAttribute("disabled"), false),
    );
  });

  it("explains when the ONNX runtime is unavailable", () => {
    renderDialog(fakeServices({ ort: false }).services);
    assert.ok(text().includes("Object detection is unavailable in this build."));
  });
});
