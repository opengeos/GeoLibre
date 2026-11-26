import { act, fireEvent, render, screen, useAppStore, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { BUILT_IN_STYLE_PRESETS, DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";

// Loaded after the harness so the panel's CSS imports and Vite globals resolve.
const { StyleManagerPanel } =
  await import("../apps/geolibre-desktop/src/components/panels/StyleManagerPanel");

const parcels = {
  id: "parcels",
  name: "Parcels",
  type: "geojson",
  visible: true,
  opacity: 1,
  style: { ...DEFAULT_LAYER_STYLE, fillColor: "#123456" },
  geojson: { type: "FeatureCollection", features: [] },
} as unknown as GeoLibreLayer;

function openPanel(selectLayer: boolean) {
  act(() => {
    useAppStore.setState({
      layers: selectLayer ? [parcels] : [],
      selectedLayerId: selectLayer ? "parcels" : null,
    });
    useAppStore.getState().setStyleManagerOpen(true);
  });
  return render(createElement(StyleManagerPanel));
}

const text = () => document.body.textContent ?? "";
const firstPreset = BUILT_IN_STYLE_PRESETS[0]!;

describe("StyleManagerPanel", () => {
  it("stays hidden until opened", () => {
    render(createElement(StyleManagerPanel));
    assert.equal(screen.queryByRole("region", { name: "Style manager" }), null);
    assert.ok(!text().includes("Built-in presets"));
  });

  it("lists the built-in presets and filters them by name or tag", () => {
    openPanel(false);
    assert.ok(text().includes("Built-in presets"));
    assert.ok(text().includes(firstPreset.name));
    assert.ok(text().includes("Select a vector layer to save or apply styles."));
    fireEvent.change(screen.getByRole("textbox", { name: "Search styles and tags…" }), {
      target: { value: "no style is called this" },
    });
    assert.ok(text().includes("No saved styles match"));
  });

  it("applies a preset to the selected layer", () => {
    openPanel(true);
    const apply = screen.getAllByRole("button", { name: "Apply" })[0]!;
    assert.equal(apply.hasAttribute("disabled"), false);
    fireEvent.click(apply);
    assert.ok(text().includes(`Applied "${firstPreset.name}" to Parcels.`), text());
    const layer = useAppStore.getState().layers.find((l) => l.id === "parcels")!;
    assert.notDeepEqual(layer.style, parcels.style);
  });

  it("saves the selected layer's style to the library or the project, then deletes it", async () => {
    openPanel(true);
    fireEvent.click(screen.getByRole("button", { name: "Save current style…" }));
    const name = screen.getByLabelText("Name") as HTMLInputElement;
    assert.equal(name.value, "Parcels");
    fireEvent.change(name, { target: { value: "Blue parcels" } });
    fireEvent.change(screen.getByLabelText("Tags"), {
      target: { value: "cadastre, blue, cadastre" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save style" }));
    const saved = useAppStore.getState().styleLibrary;
    assert.equal(saved.length, 1);
    assert.equal(saved[0]!.name, "Blue parcels");
    assert.deepEqual(saved[0]!.tags, ["cadastre", "blue"]);
    assert.ok(text().includes("My library"));

    fireEvent.click(screen.getByRole("button", { name: "Save current style…" }));
    fireEvent.change(screen.getByLabelText("Store in"), { target: { value: "project" } });
    fireEvent.click(screen.getByRole("button", { name: "Save style" }));
    assert.equal(useAppStore.getState().projectStyleLibrary.length, 1);
    assert.ok(text().includes("This project"));

    const projectEntry = useAppStore.getState().projectStyleLibrary[0]!.name;
    // Delete the project entry (its section renders first) through its menu.
    const menus = screen.getAllByRole("button", { name: "Preset actions" });
    fireEvent.pointerDown(menus[0]!, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    await waitFor(() => assert.equal(useAppStore.getState().projectStyleLibrary.length, 0));
    assert.deepEqual(
      useAppStore.getState().styleLibrary.map((entry) => entry.name),
      ["Blue parcels"],
    );
    assert.ok(text().includes(`Deleted "${projectEntry}".`));
  });

  it("closes from the header", () => {
    openPanel(false);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    assert.equal(useAppStore.getState().ui.styleManagerOpen, false);
  });
});
