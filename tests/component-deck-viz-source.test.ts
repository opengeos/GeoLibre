import { fireEvent, mockFetch, screen, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderAddDataSource } from "./helpers/add-data-shell";

const { DeckVizSource } =
  await import("../apps/geolibre-desktop/src/components/layout/add-data/sources/DeckVizSource");

const DATA_URL = "https://data.example.com/stations.csv";
const CSV = "name,longitude,latitude,riders\nUnion,-104.99,39.75,820\nMarket,-104.98,39.74,410\n";

function serve(body: string, status = 200) {
  const requested: string[] = [];
  mockFetch(async (input) => {
    requested.push(String(input));
    return new Response(body, { status });
  });
  return requested;
}

const text = () => document.body.textContent ?? "";
type VizMetadata = {
  vizConfig: { layerKind: string; fieldMapping: Record<string, unknown> };
  bounds?: number[];
};

function loadUrl(url: string) {
  fireEvent.change(screen.getByLabelText("Data URL", { selector: "input" }), {
    target: { value: url },
  });
  fireEvent.click(screen.getByRole("button", { name: "Load data" }));
}

describe("DeckVizSource", () => {
  it("loads a CSV, maps longitude and latitude automatically and adds a scatterplot", async () => {
    const requested = serve(CSV);
    const { added, closed } = renderAddDataSource(createElement(DeckVizSource, {}));
    assert.equal((screen.getByLabelText("Layer type") as HTMLSelectElement).value, "scatterplot");
    loadUrl(DATA_URL);
    await waitFor(() => assert.ok(text().includes("Loaded 2 rows · 4 columns.")));
    assert.deepEqual(requested, [DATA_URL]);
    assert.equal((screen.getByLabelText("Longitude") as HTMLSelectElement).value, "longitude");
    assert.equal((screen.getByLabelText("Latitude") as HTMLSelectElement).value, "latitude");

    fireEvent.click(screen.getByRole("button", { name: "Add layer" }));
    await waitFor(() => assert.equal(added.length, 1));
    const layer = added[0]!;
    assert.equal(layer.type, "deckgl-viz");
    assert.equal(layer.name, "Scatterplot");
    const metadata = layer.metadata as unknown as VizMetadata;
    assert.equal(metadata.vizConfig.layerKind, "scatterplot");
    assert.deepEqual(metadata.vizConfig.fieldMapping, { lng: "longitude", lat: "latitude" });
    assert.deepEqual(metadata.bounds, [-104.99, 39.74, -104.98, 39.75]);
    assert.equal((layer.source as { data: unknown[] }).data.length, 2);
    assert.equal(layer.sourcePath, DATA_URL);
    assert.equal(closed(), 1);
  });

  it("requires every required field to be mapped", async () => {
    serve("a,b\n1,2\n");
    const { added } = renderAddDataSource(createElement(DeckVizSource, {}));
    loadUrl(DATA_URL);
    await waitFor(() => assert.ok(text().includes("Loaded 1 row · 2 columns.")));
    fireEvent.click(screen.getByRole("button", { name: "Add layer" }));
    await waitFor(() =>
      assert.ok(text().includes("Map the required fields: Longitude, Latitude.")),
    );
    assert.equal(added.length, 0);
  });

  it("rejects GeoJSON for a tabular layer type and tabular data for the GeoJSON type", async () => {
    serve(JSON.stringify({ type: "FeatureCollection", features: [] }));
    renderAddDataSource(createElement(DeckVizSource, {}));
    loadUrl(DATA_URL);
    await waitFor(() =>
      assert.ok(text().includes("Scatterplot needs tabular CSV/JSON data, not GeoJSON.")),
    );

    serve(CSV);
    fireEvent.change(screen.getByLabelText("Layer type"), { target: { value: "geojson" } });
    loadUrl(DATA_URL);
    await waitFor(() => assert.ok(/needs a GeoJSON file\./.test(text())));
  });

  it("keeps Add disabled until data loads, and reports a failed download", async () => {
    serve("gone", 404);
    const { added } = renderAddDataSource(createElement(DeckVizSource, {}));
    assert.equal(screen.getByRole("button", { name: "Add layer" }).hasAttribute("disabled"), true);
    loadUrl(DATA_URL);
    await waitFor(() => assert.ok(text().includes("Request failed with status 404")));
    assert.equal(screen.getByRole("button", { name: "Add layer" }).hasAttribute("disabled"), true);
    assert.equal(added.length, 0);
  });

  it("places a single 3D model at a validated location", async () => {
    const { added } = renderAddDataSource(
      createElement(DeckVizSource, { initialDeckVizKind: "scenegraph" }),
    );
    // The scenegraph type starts on its example model and location.
    assert.ok((screen.getByLabelText("glTF / GLB model URL") as HTMLInputElement).value.length > 0);
    fireEvent.change(screen.getByLabelText("Latitude"), { target: { value: "95" } });
    fireEvent.click(screen.getByRole("button", { name: "Add layer" }));
    await waitFor(() =>
      assert.ok(
        text().includes("Longitude must be between -180 and 180, and latitude between -90 and 90."),
      ),
    );
    fireEvent.change(screen.getByLabelText("Longitude"), { target: { value: "-122.4" } });
    fireEvent.change(screen.getByLabelText("Latitude"), { target: { value: "37.8" } });
    fireEvent.click(screen.getByRole("button", { name: "Add layer" }));
    await waitFor(() => assert.equal(added.length, 1));
    const metadata = added[0]!.metadata as unknown as VizMetadata;
    assert.equal(metadata.vizConfig.layerKind, "scenegraph");
    assert.deepEqual((added[0]!.source as { data: unknown[] }).data, [{ lng: -122.4, lat: 37.8 }]);
  });
});
