import { act, render, screen, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { loadH5wasm } from "../packages/plugins/src/plugins/local-netcdf";

// Loaded after the harness so its CSS imports and Vite globals are handled.
const { AddSpaceborneLidarDialog } =
  await import("../apps/geolibre-desktop/src/components/layout/AddSpaceborneLidarDialog");
const { requestSpaceborneLidarGranule } =
  await import("../apps/geolibre-desktop/src/lib/spaceborne-lidar-handoff");

interface WritableGroup {
  create_group(name: string): WritableGroup;
  create_dataset(args: { name: string; data: unknown }): unknown;
  create_attribute(name: string, data: unknown): void;
}

/** A two-segment ATL08 granule built in h5wasm's memory filesystem. */
async function atl08Bytes(): Promise<ArrayBuffer> {
  const mod = await loadH5wasm();
  const path = "dialog-fixture.h5";
  const file = new mod.File(path, "w") as unknown as WritableGroup & { close(): void };
  file.create_attribute("short_name", "ATL08");
  const beam = file.create_group("gt1l");
  beam.create_attribute("atlas_beam_type", "strong");
  const seg = beam.create_group("land_segments");
  seg.create_dataset({ name: "latitude", data: new Float32Array([10, 10.001]) });
  seg.create_dataset({ name: "longitude", data: new Float32Array([0, 0]) });
  seg.create_dataset({ name: "delta_time", data: new Float64Array([0, 1]) });
  seg.create_group("terrain").create_dataset({
    name: "h_te_best_fit",
    data: new Float32Array([100, 101]),
  });
  file.close();
  const fs = mod.FS as unknown as { readFile(p: string): Uint8Array; unlink(p: string): void };
  const bytes = fs.readFile(path);
  fs.unlink(path);
  return bytes.slice().buffer;
}

function renderDialog() {
  const appApi = { getViewBounds: () => [-1, 9, 1, 11] } as never;
  render(createElement(AddSpaceborneLidarDialog, { open: true, appApi, onOpenChange: () => {} }));
}

describe("AddSpaceborneLidarDialog", () => {
  it("offers a file and the sample granules before one is open", () => {
    renderDialog();
    assert.ok(screen.getByRole("button", { name: "Choose file" }));
    assert.ok(screen.getByRole("combobox", { name: "Sample data" }));
    assert.equal(screen.queryByTestId("spaceborne-lidar-product"), null);
  });

  it("opens a granule handed over by a plugin", async () => {
    renderDialog();
    const data = await atl08Bytes();
    act(() => requestSpaceborneLidarGranule({ data, fileName: "ATL08_test.h5" }));
    await waitFor(() => {
      assert.equal(
        screen.getByTestId("spaceborne-lidar-product").textContent,
        "ICESat-2 ATL08 Land and Vegetation Height",
      );
    });
    assert.ok(screen.getByText("ATL08_test.h5"));
    assert.ok(screen.getByRole("button", { name: "Add layer" }));
  });
});
