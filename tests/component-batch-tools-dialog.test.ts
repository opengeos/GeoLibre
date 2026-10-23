import { act, fireEvent, render, screen, useAppStore, waitFor, within } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createElement } from "react";
import type { FeatureCollection } from "geojson";
import { geojsonLayer } from "./helpers/layer-fixtures";

// Loaded after the harness so its CSS imports and Vite globals are handled.
const { BatchToolsDialog } =
  await import("../apps/geolibre-desktop/src/components/processing/BatchToolsDialog");

function points(x: number): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: { n: 1 }, geometry: { type: "Point", coordinates: [x, 60] } },
      {
        type: "Feature",
        properties: { n: 2 },
        geometry: { type: "Point", coordinates: [x + 0.5, 60.2] },
      },
    ],
  };
}

const originalWorker = globalThis.Worker;
let terminated = 0;

afterEach(() => {
  if (originalWorker === undefined) delete (globalThis as { Worker?: typeof Worker }).Worker;
  else globalThis.Worker = originalWorker;
  terminated = 0;
});

/** A worker that loads but never finishes its run, standing in for a long one. */
class StalledWorker {
  private listeners: Array<(event: MessageEvent) => void> = [];
  constructor() {
    setTimeout(() => {
      for (const listener of this.listeners) listener({ data: { type: "ready" } } as MessageEvent);
    }, 0);
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    if (type === "message") this.listeners.push(listener);
  }
  removeEventListener() {}
  postMessage() {}
  terminate() {
    terminated += 1;
  }
}

/** Open the Batch dialog over two point layers, both selected as inputs. */
function openBatch(): HTMLElement {
  useAppStore.setState({
    layers: [
      geojsonLayer({ id: "a", name: "Wells A", geojson: points(10) }),
      geojsonLayer({ id: "b", name: "Wells B", geojson: points(20) }),
    ],
  });
  render(createElement(BatchToolsDialog, { mapControllerRef: { current: null } }));
  act(() => useAppStore.getState().setBatchToolsOpen(true));
  const dialog = screen.getByRole("dialog", { name: "Batch tools" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Select all" }));
  return dialog;
}

describe("BatchToolsDialog", () => {
  it("runs the tool over every selected layer", async () => {
    delete (globalThis as { Worker?: typeof Worker }).Worker;
    const dialog = openBatch();
    fireEvent.click(within(dialog).getByRole("button", { name: "Run batch" }));
    await waitFor(() => assert.ok(within(dialog).getByText(/Batch complete: 2\/2/)));
    assert.equal(useAppStore.getState().layers.length, 4);
  });

  it("cancels a batch: the worker stops and no further layers are added", async () => {
    globalThis.Worker = StalledWorker as unknown as typeof Worker;
    const dialog = openBatch();
    fireEvent.click(within(dialog).getByRole("button", { name: "Run batch" }));

    const cancel = await waitFor(() => within(dialog).getByRole("button", { name: "Cancel" }));
    fireEvent.click(cancel);

    await waitFor(() =>
      assert.ok(within(dialog).getByText("Cancelled. 0/2 layer(s) had already been added.")),
    );
    assert.equal(within(dialog).queryByRole("button", { name: "Cancel" }), null);
    assert.equal(
      (within(dialog).getByRole("button", { name: "Run batch" }) as HTMLButtonElement).disabled,
      false,
    );
    assert.equal(terminated, 1);
    assert.equal(useAppStore.getState().layers.length, 2);
    // The second input never started.
    assert.equal(within(dialog).queryByText(/on Wells B/), null);
  });

  it("stops the batch when the dialog closes", async () => {
    globalThis.Worker = StalledWorker as unknown as typeof Worker;
    const dialog = openBatch();
    fireEvent.click(within(dialog).getByRole("button", { name: "Run batch" }));
    await waitFor(() => within(dialog).getByRole("button", { name: "Cancel" }));

    act(() => useAppStore.getState().setBatchToolsOpen(false));

    await waitFor(() => assert.equal(terminated, 1));
    assert.equal(useAppStore.getState().layers.length, 2);
  });
});
