import { act, cleanup, fireEvent, i18n, render, screen, useAppStore, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createElement } from "react";
import { GPS_CAPTURE_FLAG, GPS_TRACK_FLAG } from "../apps/geolibre-desktop/src/lib/gps-tracking";

const { GpsTrackingDialog } =
  await import("../apps/geolibre-desktop/src/components/layout/GpsTrackingDialog");
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function installDevice() {
  let emit!: PositionCallback;
  let watches = 0;
  const cleared: number[] = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      userAgent: "GPS dialog test",
      geolocation: {
        watchPosition(callback: PositionCallback) {
          emit = callback;
          watches += 1;
          return watches;
        },
        clearWatch(id: number) {
          cleared.push(id);
        },
      },
    },
  });
  return {
    watches: () => watches,
    cleared,
    fix(index: number, accuracy = 2) {
      emit({
        coords: {
          longitude: -83 + index * 0.001,
          latitude: 35,
          accuracy,
          heading: null,
          speed: null,
          altitude: null,
          altitudeAccuracy: null,
          toJSON: () => ({}),
        },
        timestamp: 1000 + index * 1000,
        toJSON: () => ({}),
      });
    },
  };
}

const mapControllerRef = { current: null };

function dialog(open = true) {
  return createElement(GpsTrackingDialog, { open, onOpenChange: () => {}, mapControllerRef });
}

function click(
  key: "record" | "pause" | "resume" | "saveTrack" | "start" | "stop" | "capturePoint",
) {
  fireEvent.click(screen.getByRole("button", { name: i18n.t(`gps.${key}`) }));
}

afterEach(() => {
  cleanup();
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  else Reflect.deleteProperty(globalThis, "navigator");
});

it("records pause-separated segments without a map and publishes only the saved track", async () => {
  const device = installDevice();
  render(dialog());
  await act(async () => click("record"));
  const layers = useAppStore.getState().layers;
  act(() => {
    device.fix(0);
    device.fix(1);
  });
  assert.equal(useAppStore.getState().layers === layers, true, "live fixes are not project layers");
  act(() => click("pause"));
  act(() => device.fix(2));
  act(() => click("resume"));
  act(() => {
    device.fix(3);
    device.fix(4);
  });
  act(() => click("saveTrack"));
  const saved = useAppStore.getState().layers.find((layer) => layer.metadata[GPS_TRACK_FLAG]);
  assert.ok(saved);
  const geometry = saved.geojson?.features[0].geometry;
  assert.equal(geometry?.type, "MultiLineString");
  if (geometry?.type !== "MultiLineString") throw new Error("Expected segmented track");
  assert.deepEqual(geometry.coordinates, [
    [
      [-83, 35],
      [-82.999, 35],
    ],
    [
      [-82.997, 35],
      [-82.996, 35],
    ],
  ]);
  assert.equal(useAppStore.getState().layers.length, layers.length + 1);
  assert.equal(device.watches(), 1);
  await act(async () => click("stop"));
  assert.deepEqual(device.cleared, [1]);
});

it("keeps tracking while the dialog is closed, then captures into the live renamed layer", async () => {
  const device = installDevice();
  const view = render(dialog());
  await act(async () => click("start"));
  act(() => device.fix(0));
  act(() => click("capturePoint"));
  const captured = useAppStore.getState().layers.find((layer) => layer.metadata[GPS_CAPTURE_FLAG]);
  assert.ok(captured);
  act(() => useAppStore.getState().updateLayer(captured.id, { name: "Survey points" }));
  view.rerender(dialog(false));
  act(() => device.fix(1));
  assert.equal(device.watches(), 1, "dialog visibility does not restart hardware");
  assert.equal(device.cleared.length, 0);
  view.rerender(dialog());
  await waitFor(() => assert.ok(screen.getByRole("button", { name: i18n.t("gps.capturePoint") })));
  act(() => click("capturePoint"));
  const layers = useAppStore.getState().layers.filter((layer) => layer.metadata[GPS_CAPTURE_FLAG]);
  assert.equal(layers.length, 1);
  assert.equal(layers[0].name, "Survey points");
  assert.equal(layers[0].geojson?.features.length, 2);
  view.unmount();
  assert.deepEqual(device.cleared, [1]);
  assert.equal(useAppStore.getState().gpsStatus, null);
});
