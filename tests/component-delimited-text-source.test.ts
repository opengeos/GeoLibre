import { fireEvent, mockFetch, screen, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderAddDataSource } from "./helpers/add-data-shell";

const { DelimitedTextSource } =
  await import("../apps/geolibre-desktop/src/components/layout/add-data/sources/DelimitedTextSource");

const CSV_URL = "https://data.example.com/cities.csv";

/** Render the source inside a minimal Add Data shell that records added layers. */
function renderSource() {
  return renderAddDataSource(createElement(DelimitedTextSource));
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
    const features = added[0]!.geojson?.features ?? [];
    assert.equal(features.length, 2);
    assert.equal(features[0]!.geometry, null);
    assert.equal(features[1]!.properties?.label, "Beta");
  });

  it("needs a URL and reports a failed download", async () => {
    const requested = serve("nope", 404);
    const { added } = renderSource();
    const retrieve = screen.getByRole("button", { name: "Retrieve columns" });
    assert.equal(retrieve.hasAttribute("disabled"), true);
    fireEvent.change(urlInput(), { target: { value: CSV_URL } });
    fireEvent.click(retrieve);
    await waitFor(() => assert.ok(/404/.test(text())));
    fireEvent.click(screen.getByRole("button", { name: "Add layer" }));
    // Add clears the error and downloads again; wait for that request and its 404.
    await waitFor(() => {
      assert.equal(requested.length, 2);
      assert.ok(/404/.test(text()));
    });
    assert.equal(added.length, 0);
  });
});
