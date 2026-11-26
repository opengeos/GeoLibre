import { act, fireEvent, render, screen, useAppStore, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createElement } from "react";
import type { Feature } from "geojson";
import type { GeoLibreLayer } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";

const { LoadFeaturesIntoEditorDialog } =
  await import("../apps/geolibre-desktop/src/components/layout/LoadFeaturesIntoEditorDialog");
type Services =
  import("../apps/geolibre-desktop/src/components/layout/LoadFeaturesIntoEditorDialog").LoadFeaturesEditorServices;

afterEach(() => window.localStorage.clear());

/** A map whose style draws the "roads" store layer from a GeoJSON source. */
function fakeEngine(): MapEngine {
  const map = {
    getStyle: () => ({
      sources: { "roads-src": { type: "geojson" } },
      layers: [{ id: "roads-line", type: "line", source: "roads-src" }],
    }),
    getContainer: () => document.body,
  };
  return { kind: "maplibre", getMap: () => map } as unknown as MapEngine;
}

const roads = {
  id: "roads",
  name: "Roads",
  type: "geojson",
  visible: true,
  opacity: 1,
  metadata: { sourceId: "roads-src" },
} as unknown as GeoLibreLayer;

function feature(id: number): Feature {
  return {
    type: "Feature",
    id,
    properties: {},
    geometry: { type: "Point", coordinates: [id, id] },
  };
}

/** Editor services that record what the panel asked for. */
function fakeServices(options: { existing?: number; inView?: number; ready?: boolean } = {}) {
  const loads: Array<{ count: number; replace: boolean }> = [];
  const saves: Array<{ changedOnly: boolean; editorName?: string }> = [];
  const exported: string[] = [];
  const services: Services = {
    ensureEditorActive: async () => options.ready ?? true,
    getGeoEditorFeatureCount: () => options.existing ?? 0,
    hasViewImportBaseline: () => loads.length > 0,
    loadViewFeaturesIntoEditor: async (features, { replace }) => {
      loads.push({ count: features.length, replace });
      return { imported: features.length, dropped: 0 };
    },
    queryViewLayerFeatures: () =>
      Array.from({ length: options.inView ?? 3 }, (_, index) => feature(index + 1)),
    buildEditorSaveCollection: ({ changedOnly, editorName }) => {
      saves.push({ changedOnly, editorName });
      return {
        collection: { type: "FeatureCollection", features: [feature(1), feature(2)] },
        counts: { added: 1, modified: 1, deleted: 0 },
      };
    },
    exportVectorLayer: async (_collection, _format, baseName) => {
      exported.push(baseName);
      return `/tmp/${baseName}.geojson`;
    },
  };
  return { services, loads, saves, exported };
}

function renderPanel(services: Services, initialLayerId: string | null = "roads") {
  act(() => useAppStore.setState({ layers: [roads] }));
  return render(
    createElement(LoadFeaturesIntoEditorDialog, {
      open: true,
      onOpenChange: () => {},
      mapControllerRef: { current: fakeEngine() },
      initialLayerId,
      services,
    }),
  );
}

const text = () => document.body.textContent ?? "";
const load = () => fireEvent.click(screen.getByRole("button", { name: "Load features" }));

describe("LoadFeaturesIntoEditorDialog", () => {
  it("lists the vector layers drawn on the map and preselects the one it was opened for", () => {
    renderPanel(fakeServices().services);
    const select = screen.getByLabelText("Vector layer") as HTMLSelectElement;
    assert.equal(select.value, "roads");
    assert.deepEqual(
      Array.from(select.options, (o) => o.textContent),
      ["Select a layer…", "Roads"],
    );
  });

  it("keeps Load disabled until a layer is selected", () => {
    renderPanel(fakeServices().services, null);
    assert.equal(
      screen.getByRole("button", { name: "Load features" }).hasAttribute("disabled"),
      true,
    );
    fireEvent.change(screen.getByLabelText("Vector layer"), { target: { value: "roads" } });
    assert.equal(
      screen.getByRole("button", { name: "Load features" }).hasAttribute("disabled"),
      false,
    );
  });

  it("loads the visible features into an empty editor", async () => {
    const { services, loads } = fakeServices();
    renderPanel(services);
    load();
    await waitFor(() => assert.ok(text().includes('Loaded 3 feature(s) from "Roads".')));
    assert.deepEqual(loads, [{ count: 3, replace: true }]);
  });

  it("asks whether to append to or replace features already in the editor", async () => {
    const { services, loads } = fakeServices({ existing: 4 });
    renderPanel(services);
    load();
    await waitFor(() => assert.ok(text().includes("The editor already holds 4 feature(s).")));
    fireEvent.click(screen.getByRole("button", { name: "Append" }));
    await waitFor(() => assert.ok(text().includes('Appended 3 feature(s) from "Roads".')));
    assert.deepEqual(loads, [{ count: 3, replace: false }]);
  });

  it("warns before loading a very large set of features", async () => {
    const { services, loads } = fakeServices({ inView: 2500 });
    renderPanel(services);
    load();
    await waitFor(() => assert.ok(text().includes("may make the editor slow to respond")));
    assert.equal(loads.length, 0);
    fireEvent.click(screen.getByRole("button", { name: "Load anyway" }));
    await waitFor(() => assert.deepEqual(loads, [{ count: 2500, replace: true }]));
  });

  it("reports an empty view", async () => {
    renderPanel(fakeServices({ inView: 0 }).services);
    load();
    await waitFor(() =>
      assert.ok(text().includes("No features found in the current view for this layer.")),
    );
  });

  it("reports an editor that cannot start", async () => {
    renderPanel(fakeServices({ ready: false }).services);
    load();
    await waitFor(() => assert.ok(text().includes("Could not activate the GeoEditor.")));
  });

  it("saves every feature or only the changes, stamped with the remembered editor name", async () => {
    const { services, saves, exported } = fakeServices();
    renderPanel(services);
    fireEvent.change(screen.getByLabelText("Editor name", { selector: "input" }), {
      target: { value: "  Ana  " },
    });
    assert.equal(window.localStorage.getItem("geolibre-editor-name"), "Ana");
    // Nothing loaded yet, so there are no changes to save.
    assert.equal(
      screen.getByRole("button", { name: "Save changes" }).hasAttribute("disabled"),
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save all" }));
    await waitFor(() => assert.ok(text().includes("Saved 2 feature(s).")));
    assert.match(exported[0]!, /^features_\d{4}-\d{2}-\d{2}_/);

    load();
    await waitFor(() => assert.ok(text().includes("Loaded 3 feature(s)")));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      assert.ok(text().includes("Saved changes: 1 added, 1 modified, 0 deleted.")),
    );
    assert.match(exported[1]!, /^feature-changes_/);
    assert.deepEqual(
      saves.map((s) => s.changedOnly),
      [false, true],
    );
    // The panel hands over the name as typed; the save helper trims it into
    // the change metadata.
    assert.equal(saves[0]!.editorName, "  Ana  ");
  });
});
