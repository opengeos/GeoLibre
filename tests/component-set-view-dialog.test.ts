import { fireEvent, render, screen } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import type { MapEngine } from "@geolibre/map";

// Loaded after the harness so the dialog's CSS imports and Vite globals resolve.
const { SetViewDialog } =
  await import("../apps/geolibre-desktop/src/components/layout/SetViewDialog");

/** A stand-in engine with a fixed camera that records fly-to requests. */
function fakeEngine() {
  const flights: Array<{ center: [number, number]; zoom: number; pitch: number; bearing: number }> =
    [];
  const engine = {
    readView: () => ({
      center: [-0.12775, 51.507351],
      zoom: 9.87654,
      pitch: 30.04,
      bearing: -12.36,
    }),
    flyTo: (options: (typeof flights)[number]) => void flights.push(options),
  } as unknown as MapEngine;
  return { engine, flights };
}

function renderDialog(engine: MapEngine) {
  let open = true;
  render(
    createElement(SetViewDialog, {
      open: true,
      onOpenChange: (next: boolean) => (open = next),
      mapControllerRef: { current: engine },
    }),
  );
  return () => open;
}

const value = (label: string) => (screen.getByLabelText(label) as HTMLInputElement).value;
const text = () => document.body.textContent ?? "";

describe("SetViewDialog", () => {
  it("seeds the fields from the current camera, rounded", () => {
    renderDialog(fakeEngine().engine);
    assert.equal(value("Longitude"), "-0.12775");
    assert.equal(value("Latitude"), "51.507351");
    assert.equal(value("Zoom"), "9.877");
    assert.equal(value("Pitch"), "30");
    assert.equal(value("Bearing"), "-12.4");
  });

  it("flies to the entered view and closes", () => {
    const { engine, flights } = fakeEngine();
    const isOpen = renderDialog(engine);
    fireEvent.change(screen.getByLabelText("Longitude"), { target: { value: "2.3522" } });
    fireEvent.change(screen.getByLabelText("Latitude"), { target: { value: "48.8566" } });
    fireEvent.change(screen.getByLabelText("Zoom"), { target: { value: "12" } });
    fireEvent.change(screen.getByLabelText("Pitch"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    assert.deepEqual(flights, [{ center: [2.3522, 48.8566], zoom: 12, pitch: 0, bearing: -12.4 }]);
    assert.equal(isOpen(), false);
  });

  it("rejects an out-of-range latitude without moving the map", () => {
    const { engine, flights } = fakeEngine();
    const isOpen = renderDialog(engine);
    fireEvent.change(screen.getByLabelText("Latitude"), { target: { value: "95" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    assert.ok(
      text().includes("Enter a valid longitude (−180 to 180), latitude (−90 to 90), and zoom."),
    );
    assert.equal(flights.length, 0);
    assert.equal(isOpen(), true);
  });

  it("fills the center from a pasted coordinate string and reports one it cannot read", () => {
    renderDialog(fakeEngine().engine);
    fireEvent.click(screen.getByRole("button", { name: /Paste coordinates/ }));
    const paste = screen.getByLabelText("Coordinate string");
    fireEvent.change(paste, { target: { value: "40.7128, -74.0060" } });
    fireEvent.click(screen.getByRole("button", { name: "Process input" }));
    assert.equal(value("Longitude"), "-74.006");
    assert.equal(value("Latitude"), "40.7128");
    assert.ok(text().includes("Filled the longitude and latitude fields below."));
    fireEvent.change(paste, { target: { value: "somewhere nice" } });
    fireEvent.click(screen.getByRole("button", { name: "Process input" }));
    assert.ok(text().includes("Could not read those coordinates."));
  });

  it("converts the center between DD, DMS and DDM and flies to a DMS entry", () => {
    const { engine, flights } = fakeEngine();
    renderDialog(engine);
    fireEvent.click(screen.getByRole("radio", { name: "DMS" }));
    assert.equal(value("Latitude Degrees"), "51");
    assert.equal(value("Latitude Minutes"), "30");
    fireEvent.click(screen.getByRole("radio", { name: "DDM" }));
    assert.equal(value("Latitude Degrees"), "51");
    fireEvent.click(screen.getByRole("radio", { name: "DD" }));
    // The DMS/DDM round trip keeps the center within a few centimetres.
    assert.ok(Math.abs(Number(value("Latitude")) - 51.507351) < 1e-5, value("Latitude"));

    fireEvent.click(screen.getByRole("radio", { name: "DMS" }));
    fireEvent.change(screen.getByLabelText("Latitude Minutes"), { target: { value: "75" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    assert.ok(text().includes("Enter valid degrees, minutes (0 to 59)"));
    fireEvent.change(screen.getByLabelText("Latitude Minutes"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Latitude Seconds"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    assert.equal(flights.length, 1);
    assert.equal(flights[0]!.center[1], 51);
  });
});
