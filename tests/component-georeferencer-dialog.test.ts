import { act, fireEvent, render, screen, useAppStore, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import type { MapEngine } from "@geolibre/map";

const { GeoreferencerDialog } =
  await import("../apps/geolibre-desktop/src/components/layout/GeoreferencerDialog");

// happy-dom decodes no images, so stand in an Image that reports a fixed size.
const RealImage = globalThis.Image;
class SizedImage {
  naturalWidth = 400;
  naturalHeight = 200;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) {
    queueMicrotask(() => this.onload?.());
  }
}
beforeEach(() => {
  (globalThis as { Image: unknown }).Image = SizedImage;
});
afterEach(() => {
  (globalThis as { Image: unknown }).Image = RealImage;
});

/** An engine whose next map click the test triggers by hand. */
function fakeEngine() {
  let clickHandler: ((lngLat: [number, number]) => void) | null = null;
  const fitted: unknown[] = [];
  const engine = {
    getRenderSurface: () => ({ getCanvas: () => document.createElement("canvas") }),
    onMapClick: (handler: (lngLat: [number, number]) => void) => {
      clickHandler = handler;
      return () => {
        clickHandler = null;
      };
    },
    fitBounds: (bounds: unknown) => fitted.push(bounds),
  } as unknown as MapEngine;
  return { engine, click: (lngLat: [number, number]) => clickHandler?.(lngLat), fitted };
}

function renderDialog(engine: MapEngine) {
  let open = true;
  const view = render(
    createElement(GeoreferencerDialog, {
      open: true,
      onOpenChange: (next: boolean) => (open = next),
      mapControllerRef: { current: engine },
    }),
  );
  return { ...view, isOpen: () => open };
}

const text = () => document.body.textContent ?? "";

async function loadImage(name = "survey-sheet.png") {
  const input = document.querySelector('input[accept="image/*"]') as HTMLInputElement;
  const file = new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" });
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() => assert.ok(text().includes("Source image (400 × 200 px)")));
}

function clickImageAt(x: number, y: number) {
  const img = screen.getByRole("img") as HTMLImageElement;
  img.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200 }) as DOMRect;
  fireEvent.click(img, { clientX: x, clientY: y });
}

describe("GeoreferencerDialog", () => {
  it("links image points to map clicks, solves the fit and adds the image to the map", async () => {
    const { engine, click } = fakeEngine();
    renderDialog(engine);
    await loadImage();
    assert.equal(screen.getByRole("button", { name: "Add to map" }).hasAttribute("disabled"), true);

    // Three control points, 1° per 100 px, so the image spans a 4° by 2° box.
    for (const [px, py, lng, lat] of [
      [0, 0, -100, 42],
      [200, 0, -98, 42],
      [0, 100, -100, 41],
    ] as const) {
      clickImageAt(px, py);
      fireEvent.click(screen.getByRole("button", { name: "Link on map" }));
      act(() => click([lng, lat]));
    }
    await waitFor(() => assert.ok(text().includes("Control points (3)")));
    fireEvent.click(screen.getByRole("button", { name: "Add to map" }));

    const layer = useAppStore.getState().layers.find((l) => l.type === "image");
    assert.ok(layer);
    assert.equal(layer.name, "survey-sheet");
    const corners = (layer.source as { coordinates: [number, number][] }).coordinates;
    // The three points pin the affine fit, so the fourth corner follows.
    const rounded = corners.map(([x, y]) => [
      Math.round(x * 1000) / 1000,
      Math.round(y * 1000) / 1000,
    ]);
    assert.deepEqual(rounded, [
      [-100, 42],
      [-96, 42],
      [-96, 40],
      [-100, 40],
    ]);
    assert.equal((layer.metadata as { gcps: unknown[] }).gcps.length, 3);
  });

  it("returns to the dialog when Escape cancels a pending map link", async () => {
    const { engine } = fakeEngine();
    const dialog = renderDialog(engine);
    await loadImage();
    clickImageAt(100, 50);
    assert.ok(text().includes("Image point: 100, 50"));
    fireEvent.click(screen.getByRole("button", { name: "Link on map" }));
    assert.equal(dialog.isOpen(), false);
    fireEvent.keyDown(window, { key: "Escape" });
    assert.equal(dialog.isOpen(), true);
    // No control point was added; the picked image point is kept for another try.
    assert.ok(!text().includes("Control points (1)"));
    assert.ok(text().includes("Image point: 100, 50"));
  });

  it("imports control points from CSV and removes one", async () => {
    const { engine } = fakeEngine();
    renderDialog(engine);
    await loadImage();
    const input = document.querySelector('input[accept=".csv,.txt,text/csv"]') as HTMLInputElement;
    const csv = "px,py,lng,lat\n0,0,-100,42\n400,0,-96,42\n0,200,-100,40\nbad,row\n";
    fireEvent.change(input, {
      target: { files: [new File([csv], "gcps.csv", { type: "text/csv" })] },
    });
    await waitFor(() => assert.ok(text().includes("Imported 3 control point(s).")));
    assert.equal(
      screen.getByRole("button", { name: "Add to map" }).hasAttribute("disabled"),
      false,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]!);
    assert.ok(text().includes("Control points (2)"));
    assert.equal(screen.getByRole("button", { name: "Add to map" }).hasAttribute("disabled"), true);
  });

  it("warns when imported points fall outside the image, and rejects an empty file", async () => {
    const { engine } = fakeEngine();
    renderDialog(engine);
    await loadImage();
    const input = document.querySelector('input[accept=".csv,.txt,text/csv"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["5000,0,-100,42\n"], "far.csv", { type: "text/csv" })] },
    });
    await waitFor(() =>
      assert.ok(text().includes("Some control points fall outside the loaded image")),
    );
    fireEvent.change(input, {
      target: { files: [new File(["nothing useful\n"], "empty.csv", { type: "text/csv" })] },
    });
    await waitFor(() => assert.ok(text().includes("Couldn't read control points from that file.")));
  });

  it("zooms the image preview within its limits and clears everything", async () => {
    const { engine } = fakeEngine();
    renderDialog(engine);
    await loadImage();
    const zoomOut = screen.getByRole("button", { name: "Zoom out" });
    const level = () => zoomOut.nextElementSibling?.textContent;
    assert.equal(level(), "100%");
    assert.equal(zoomOut.hasAttribute("disabled"), true);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    assert.equal(level(), "150%");
    assert.equal(zoomOut.hasAttribute("disabled"), false);
    fireEvent.click(screen.getByRole("button", { name: "Reset zoom" }));
    assert.equal(level(), "100%");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    assert.ok(text().includes("Click to load an image"));
  });
});
