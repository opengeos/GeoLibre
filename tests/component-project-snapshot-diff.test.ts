import { act, fireEvent, render, screen, useAppStore, waitFor, within } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import {
  createEmptyProject,
  DEFAULT_LAYER_STYLE,
  serializeProject,
  type GeoLibreLayer,
  type GeoLibreProject,
} from "@geolibre/core";
import type { ProjectHistorySnapshot } from "../apps/geolibre-desktop/src/lib/project-history-store";

// Loaded after the harness so its CSS imports and Vite globals are handled.
const { ProjectHistoryDialog } =
  await import("../apps/geolibre-desktop/src/components/layout/ProjectHistoryDialog");

function layer(id: string, over: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id,
    name: id,
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    ...over,
  };
}

function project(layers: GeoLibreLayer[]): GeoLibreProject {
  const styles: GeoLibreProject["styles"] = {};
  for (const item of layers) styles[item.id] = item.style;
  return { ...createEmptyProject("Demo"), layers, styles };
}

function snapshot(id: string, createdAt: string, value: GeoLibreProject): ProjectHistorySnapshot {
  return {
    id,
    createdAt,
    content: serializeProject(value),
    size: 0,
    name: value.name,
    layerCount: value.layers.length,
    basemap: value.basemapStyleUrl,
    camera: value.mapView,
  };
}

const older = snapshot("s1", "2026-01-01T10:00:00.000Z", project([layer("roads")]));
const newer = snapshot(
  "s2",
  "2026-01-01T11:00:00.000Z",
  project([layer("roads", { opacity: 0.5 }), layer("parks")]),
);

function renderDialog(current: GeoLibreProject, restored: string[] = []) {
  return render(
    createElement(ProjectHistoryDialog, {
      open: true,
      onOpenChange: () => {},
      snapshots: [newer, older],
      restoreError: null,
      onRestore: () => true,
      onRestoreLayer: (_snapshot: ProjectHistorySnapshot, layerId: string) => {
        restored.push(layerId);
        return true;
      },
      getCurrentProjectContent: () => serializeProject(current),
    }),
  );
}

describe("ProjectHistoryDialog compare", () => {
  it("compares a snapshot with the current project and restores one layer", async () => {
    const restored: string[] = [];
    renderDialog(
      project([
        layer("roads", {
          name: "Main roads",
          style: { ...DEFAULT_LAYER_STYLE, fillColor: "#ff0000" },
        }),
        layer("rivers"),
      ]),
      restored,
    );
    const compare = screen.getAllByRole("button", { name: /Compare the snapshot/ });
    fireEvent.click(compare[1]); // the older snapshot
    const view = screen.getByTestId("project-snapshot-diff");
    assert.ok(screen.getByText("Compare snapshots"));
    // The comparison runs asynchronously (in a worker in the app).
    await waitFor(() => assert.ok(within(view).getByText("rivers")));
    assert.ok(within(view).getByText("Main roads"));
    assert.ok(within(view).getByText("fillColor"));
    assert.ok(within(view).getByText("#ff0000"));

    fireEvent.click(within(view).getByRole("button", { name: /Restore the layer Main roads/ }));
    assert.deepEqual(restored, ["roads"]);
    assert.ok(within(view).getByRole("status").textContent?.includes("Main roads"));
  });

  it("compares two snapshots oldest to newest without offering layer restore", async () => {
    renderDialog(project([]));
    fireEvent.click(screen.getAllByRole("button", { name: /Compare the snapshot/ })[0]);
    const view = screen.getByTestId("project-snapshot-diff");
    fireEvent.change(within(view).getByLabelText("Compare with"), { target: { value: "s1" } });
    await waitFor(() => assert.ok(within(view).getByText("parks")));
    assert.ok(within(view).getByText("Added"));
    assert.equal(within(view).queryByRole("button", { name: /Restore the layer/ }), null);
    assert.ok(within(view).getByText(/1 change|2 changes/));
  });

  it("blames the current project when it cannot be built", async () => {
    render(
      createElement(ProjectHistoryDialog, {
        open: true,
        onOpenChange: () => {},
        snapshots: [older],
        restoreError: null,
        onRestore: () => true,
        getCurrentProjectContent: () => {
          throw new RangeError("Invalid string length");
        },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Compare the snapshot/ }));
    await waitFor(() =>
      assert.match(
        screen.getByRole("alert").textContent ?? "",
        /Could not read the current project/,
      ),
    );
  });

  it("re-reads the current project when the store's layers change (e.g. Undo)", async () => {
    let current = project([layer("roads"), layer("rivers")]);
    render(
      createElement(ProjectHistoryDialog, {
        open: true,
        onOpenChange: () => {},
        snapshots: [older],
        restoreError: null,
        onRestore: () => true,
        getCurrentProjectContent: () => serializeProject(current),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Compare the snapshot/ }));
    const view = screen.getByTestId("project-snapshot-diff");
    await waitFor(() => assert.ok(within(view).getByText("rivers")));

    current = project([layer("roads")]);
    act(() => useAppStore.setState({ layers: [layer("roads")] }));
    // Live changes are debounced before the comparison re-runs.
    await waitFor(() => assert.ok(within(view).getByText("No differences.")), { timeout: 2000 });
    assert.equal(within(view).queryByText("rivers"), null);
  });

  it("re-reads the current project after a non-layer edit such as a basemap switch", async () => {
    let current = project([layer("roads")]);
    render(
      createElement(ProjectHistoryDialog, {
        open: true,
        onOpenChange: () => {},
        snapshots: [older],
        restoreError: null,
        onRestore: () => true,
        getCurrentProjectContent: () => serializeProject(current),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Compare the snapshot/ }));
    const view = screen.getByTestId("project-snapshot-diff");
    await waitFor(() => assert.ok(within(view).getByText("No differences.")));

    current = { ...current, basemapStyleUrl: "https://example.com/style.json" };
    act(() => useAppStore.setState({ basemapStyleUrl: "https://example.com/style.json" }));
    await waitFor(() => assert.ok(within(view).getByText("basemapStyleUrl")), { timeout: 2000 });
  });

  it("leaves a compare view whose snapshot is no longer in the history", async () => {
    const props = {
      open: true,
      onOpenChange: () => {},
      restoreError: null,
      onRestore: () => true,
      getCurrentProjectContent: () => serializeProject(project([layer("roads")])),
    };
    const view = render(
      createElement(ProjectHistoryDialog, { ...props, snapshots: [newer, older] }),
    );
    fireEvent.click(screen.getAllByRole("button", { name: /Compare the snapshot/ })[1]);
    assert.ok(screen.getByTestId("project-snapshot-diff"));
    // A history refresh after autosave evicted the oldest snapshot.
    view.rerender(createElement(ProjectHistoryDialog, { ...props, snapshots: [newer] }));
    await waitFor(() => assert.equal(screen.queryByTestId("project-snapshot-diff"), null));
  });

  it("returns to the snapshot list", async () => {
    renderDialog(project([layer("roads")]));
    fireEvent.click(screen.getAllByRole("button", { name: /Compare the snapshot/ })[1]);
    await waitFor(() => assert.ok(screen.getByText("No differences.")));
    fireEvent.click(screen.getByRole("button", { name: "Back to snapshots" }));
    assert.equal(screen.queryByTestId("project-snapshot-diff"), null);
    assert.equal(screen.getAllByRole("button", { name: /Compare the snapshot/ }).length, 2);
  });
});
