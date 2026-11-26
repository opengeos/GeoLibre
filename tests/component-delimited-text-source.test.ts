import { fireEvent, mockFetch, render, screen, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement, createRef, useState } from "react";
import type { GeoLibreLayer } from "@geolibre/core";
import type { AddDataShellContextValue } from "../apps/geolibre-desktop/src/components/layout/add-data/context";

const [{ DelimitedTextSource }, { AddDataShellProvider }] = await Promise.all([
  import("../apps/geolibre-desktop/src/components/layout/add-data/sources/DelimitedTextSource"),
  import("../apps/geolibre-desktop/src/components/layout/add-data/context"),
]);

const CSV_URL = "https://data.example.com/cities.csv";

/** Render the source inside a minimal Add Data shell that records added layers. */
function renderSource() {
  const added: GeoLibreLayer[] = [];
  let closed = 0;
  function Shell() {
    const [isSubmitting, setIsSubmitting] = useState(false);
    const shell: AddDataShellContextValue = {
      mapControllerRef: createRef(),
      addLayer: (layer) => void added.push(layer),
      existingLayers: [],
      isSubmitting,
      setIsSubmitting,
      closeDialog: () => void (closed += 1),
      targetGroupId: null,
      martin: {
        server: null,
        setServer: () => {},
        sources: [],
        setSources: () => {},
        selectedSourceId: "",
        setSelectedSourceId: () => {},
        status: null,
        setStatus: () => {},
        markLayerAdded: () => {},
        resetOnOpen: () => {},
        stopTransient: () => {},
      },
    };
    return createElement(
      AddDataShellProvider,
      { value: shell },
      createElement(DelimitedTextSource),
    );
  }
  render(createElement(Shell));
  return { added, closed: () => closed };
}

function serve(body: string, status = 200) {
  const requested: string[] = [];
  mockFetch(async (input) => {
    requested.push(String(input));
    return new Response(body, { status, headers: { "Content-Type": "text/csv" } });
  });
  return requested;
}

const text = () => document.body.textContent ?? "";
const urlInput = () => screen.getByRole("textbox", { name: "Delimited text URL" });

describe("DelimitedTextSource", () => {
  it("retrieves columns, detects coordinates and adds a point layer", async () => {
    const requested = serve(
      "city,lat,lon,pop\nAmes,42.03,-93.62,66000\nOmaha,41.26,-95.94,486000\n",
    );
    const { added, closed } = renderSource();
    fireEvent.change(urlInput(), { target: { value: CSV_URL } });
    fireEvent.click(screen.getByRole("button", { name: "Retrieve columns" }));
    await waitFor(() => assert.ok(text().includes("Retrieved 4 columns.")));
    assert.deepEqual(requested, [CSV_URL]);
    assert.equal((screen.getByLabelText("Longitude field") as HTMLSelectElement).value, "lon");
    assert.equal((screen.getByLabelText("Latitude field") as HTMLSelectElement).value, "lat");

    fireEvent.click(screen.getByRole("button", { name: "Add layer" }));
    await waitFor(() => assert.equal(added.length, 1));
    const layer = added[0]!;
    assert.equal(layer.geojson?.features.length, 2);
    const first = layer.geojson!.features[0]!;
    assert.deepEqual((first.geometry as { coordinates: number[] }).coordinates, [-93.62, 42.03]);
    assert.equal(first.properties?.city, "Ames");
    assert.equal(closed(), 1);
  });

  it("adds a file without coordinate columns as an attribute table", async () => {
    serve("code;label\nA;Alpha\nB;Beta\n");
    const { added } = renderSource();
    fireEvent.change(urlInput(), { target: { value: CSV_URL } });
    fireEvent.change(screen.getByLabelText("Delimiter"), { target: { value: "semicolon" } });
    fireEvent.click(screen.getByRole("button", { name: "Retrieve columns" }));
    await waitFor(() => assert.ok(text().includes("No coordinate columns detected")));
    fireEvent.click(screen.getByRole("button", { name: "Add layer" }));
    await waitFor(() => assert.equal(added.length, 1));
    assert.ok(text().length > 0);
    const features = added[0]!.geojson?.features ?? [];
    assert.equal(features.length, 2);
    assert.equal(features[0]!.geometry, null);
    assert.equal(features[1]!.properties?.label, "Beta");
  });

  it("needs a URL and reports a failed download", async () => {
    serve("nope", 404);
    const { added } = renderSource();
    const retrieve = screen.getByRole("button", { name: "Retrieve columns" });
    assert.equal(retrieve.hasAttribute("disabled"), true);
    fireEvent.change(urlInput(), { target: { value: CSV_URL } });
    fireEvent.click(retrieve);
    await waitFor(() => assert.ok(/404/.test(text())), text());
    fireEvent.click(screen.getByRole("button", { name: "Add layer" }));
    await waitFor(() => assert.ok(/404/.test(text())));
    assert.equal(added.length, 0);
  });
});
