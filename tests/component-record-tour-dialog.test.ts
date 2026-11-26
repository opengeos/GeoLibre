import { act, fireEvent, render, screen, useAppStore } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createElement } from "react";
import type { GeoLibreLayer } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";

// Loaded after the harness so the dialog's CSS imports and Vite globals resolve.
const { RecordTourDialog } =
  await import("../apps/geolibre-desktop/src/components/layout/RecordTourDialog");

const originalConfirm = window.confirm;
afterEach(() => {
  window.confirm = originalConfirm;
});

/** A stand-in engine whose camera the test moves between captures. */
function fakeEngine() {
  const view = {
    center: [-83.123456789, 35.987654321] as [number, number],
    zoom: 10,
    pitch: 0,
    bearing: 0,
  };
  const flights: unknown[] = [];
  const engine = {
    readView: () => ({ ...view, center: [...view.center] as [number, number] }),
    flyTo: (options: unknown) => flights.push(options),
  } as unknown as MapEngine;
  return { engine, view, flights };
}

function renderTour(engine: MapEngine | null, onOpenChange: (open: boolean) => void = () => {}) {
  return render(
    createElement(RecordTourDialog, {
      open: true,
      onOpenChange,
      mapControllerRef: { current: engine },
    }),
  );
}

const keyframeRows = () => screen.queryAllByRole("button", { name: "Remove keyframe" });
const previewButtons = () => screen.getAllByTitle(/^Fly to this view/);

describe("RecordTourDialog", () => {
  it("renders nothing while closed", () => {
    render(
      createElement(RecordTourDialog, {
        open: false,
        onOpenChange: () => {},
        mapControllerRef: { current: null },
      }),
    );
    assert.equal(screen.queryByRole("dialog", { name: "Record map tour" }), null);
  });

  it("starts empty with recording unavailable where the canvas cannot be recorded", () => {
    renderTour(fakeEngine().engine);
    assert.ok(screen.getByRole("dialog", { name: "Record map tour" }));
    assert.match(document.body.textContent ?? "", /add it as the first keyframe/);
    // happy-dom has no MediaRecorder.
    assert.match(document.body.textContent ?? "", /This browser cannot record the map canvas/);
    assert.equal(screen.getByRole("button", { name: "Record" }).hasAttribute("disabled"), true);
    assert.equal(screen.getByRole("button", { name: "Save setup" }).hasAttribute("disabled"), true);
    assert.match(document.body.textContent ?? "", /Add a LineString layer/);
  });

  it("captures, re-frames, reorders, previews and removes keyframes", () => {
    const { engine, view, flights } = fakeEngine();
    renderTour(engine);
    fireEvent.click(screen.getByRole("button", { name: "Add current view" }));
    view.zoom = 12;
    fireEvent.click(screen.getByRole("button", { name: "Add current view" }));
    assert.equal(keyframeRows().length, 2);
    assert.match(document.body.textContent ?? "", /2 keyframes/);
    assert.match(document.body.textContent ?? "", /About \d+(\.\d)?s/);
    assert.equal(
      screen.getByRole("button", { name: "Save setup" }).hasAttribute("disabled"),
      false,
    );

    // The first stop cannot move up and the last cannot move down.
    const up = screen.getAllByRole("button", { name: "Move keyframe up" });
    const down = screen.getAllByRole("button", { name: "Move keyframe down" });
    assert.equal(up[0]!.hasAttribute("disabled"), true);
    assert.equal(down[1]!.hasAttribute("disabled"), true);

    fireEvent.click(down[0]!);
    fireEvent.click(previewButtons()[0]!);
    assert.equal((flights[0] as { zoom: number }).zoom, 12);

    view.zoom = 5;
    fireEvent.click(screen.getAllByRole("button", { name: "Update to current map view" })[0]!);
    fireEvent.click(previewButtons()[0]!);
    assert.equal((flights[1] as { zoom: number }).zoom, 5);
    // Captured coordinates are rounded for compact display.
    const center = (flights[1] as { center: [number, number] }).center;
    assert.ok(String(center[0]).length < String(-83.123456789).length);

    fireEvent.click(screen.getAllByRole("button", { name: "Remove keyframe" })[0]!);
    assert.equal(keyframeRows().length, 1);
    assert.match(document.body.textContent ?? "", /1 keyframe(?!s)/);
    // The remaining stop is the one captured at zoom 10.
    assert.match(previewButtons()[0]!.title, /z10/);
  });

  it("does nothing on Add current view without a map", () => {
    renderTour(null);
    fireEvent.click(screen.getByRole("button", { name: "Add current view" }));
    assert.equal(keyframeRows().length, 0);
  });

  it("generates keyframes from a line layer and confirms before replacing", () => {
    const line = {
      id: "trail",
      name: "Trail",
      type: "geojson",
      visible: true,
      opacity: 1,
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {},
            geometry: {
              type: "LineString",
              coordinates: [
                [-83.5, 35.5],
                [-83.4, 35.6],
                [-83.3, 35.7],
              ],
            },
          },
        ],
      },
    } as unknown as GeoLibreLayer;
    act(() => useAppStore.setState({ layers: [line] }));
    const { engine } = fakeEngine();
    renderTour(engine);
    assert.ok(screen.getByRole("option", { name: "Trail (3 points)" }));
    fireEvent.change(screen.getByLabelText("Keyframes"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    assert.equal(keyframeRows().length, 4);
    assert.match(document.body.textContent ?? "", /Generated 4 keyframes from the path/);

    // Declining the replacement keeps the current tour.
    let asked = 0;
    window.confirm = () => {
      asked += 1;
      return false;
    };
    fireEvent.change(screen.getByLabelText("Keyframes"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    assert.equal(asked, 1);
    assert.equal(keyframeRows().length, 4);
    window.confirm = () => true;
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    assert.equal(keyframeRows().length, 2);
  });

  it("clamps the frame rate on blur and closes from the title bar", () => {
    let open = true;
    renderTour(fakeEngine().engine, (next) => (open = next));
    const fps = screen.getByLabelText("Frames per second") as HTMLInputElement;
    fireEvent.change(fps, { target: { value: "500" } });
    fireEvent.blur(fps);
    assert.equal(fps.value, "60");
    fireEvent.change(fps, { target: { value: "" } });
    fireEvent.blur(fps);
    assert.ok(Number(fps.value) > 0);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    assert.equal(open, false);
  });

  it("resizes with the keyboard from either bottom corner", () => {
    renderTour(fakeEngine().engine);
    const dialog = screen.getByRole("dialog", { name: "Record map tour" });
    dialog.getBoundingClientRect = () =>
      ({ left: 100, top: 80, width: 384, height: 500, right: 484, bottom: 580 }) as DOMRect;
    fireEvent.keyDown(screen.getByRole("button", { name: /bottom-right corner/ }), {
      key: "ArrowRight",
    });
    const grown = Number.parseFloat(dialog.style.width);
    assert.ok(grown > 384);
    assert.equal(dialog.style.left, "100px");
    fireEvent.keyDown(screen.getByRole("button", { name: /bottom-left corner/ }), {
      key: "ArrowLeft",
    });
    // Growing from the left moves the left edge and keeps the right edge.
    assert.ok(Number.parseFloat(dialog.style.left) < 100);
    // An unrelated key is ignored.
    const before = dialog.style.cssText;
    fireEvent.keyDown(screen.getByRole("button", { name: /bottom-left corner/ }), { key: "a" });
    assert.equal(dialog.style.cssText, before);
  });
});
