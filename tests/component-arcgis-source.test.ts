import { fireEvent, mockFetch, screen, useAppStore, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderAddDataSource } from "./helpers/add-data-shell";

const { ArcGISSource } =
  await import("../apps/geolibre-desktop/src/components/layout/add-data/sources/ArcGISSource");

const BASE = "https://services.example.com/arcgis/rest/services";

/** Serve canned ArcGIS REST responses by path and record every request. */
function arcgisServer(routes: Record<string, unknown>) {
  const requested: string[] = [];
  mockFetch(async (input) => {
    const url = new URL(String(input));
    requested.push(url.pathname + url.search);
    const body = routes[url.pathname];
    if (body === undefined) {
      return new Response(JSON.stringify({ error: { code: 404, message: "Not found" } }), {
        status: 404,
      });
    }
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  });
  return requested;
}

const text = () => document.body.textContent ?? "";

const FEATURE_LAYER = "/arcgis/rest/services/Cities/FeatureServer/0";

/** A one-feature point layer, answering count, id and GeoJSON page queries. */
function citiesServer() {
  const requested: string[] = [];
  mockFetch(async (input) => {
    const url = new URL(String(input));
    requested.push(url.pathname + url.search);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
    if (url.pathname === FEATURE_LAYER) {
      return json({
        name: "Cities",
        type: "Feature Layer",
        geometryType: "esriGeometryPoint",
        maxRecordCount: 1000,
        fields: [{ name: "name", type: "esriFieldTypeString" }],
      });
    }
    if (url.pathname === `${FEATURE_LAYER}/query`) {
      if (url.searchParams.get("returnCountOnly") === "true") return json({ count: 1 });
      if (url.searchParams.get("returnIdsOnly") === "true")
        return json({ objectIdFieldName: "OBJECTID", objectIds: [1] });
      return json({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { name: "Ames" },
            geometry: { type: "Point", coordinates: [-93.6, 42.0] },
          },
        ],
      });
    }
    return json({ error: { code: 400, message: "Invalid URL" } });
  });
  return requested;
}

describe("ArcGISSource", () => {
  it("downloads a feature layer in pages and adds it to the project", async () => {
    const requested = citiesServer();
    const { closed } = renderAddDataSource(
      createElement(ArcGISSource, { initialUrl: `https://services.example.com${FEATURE_LAYER}` }),
    );
    fireEvent.change(screen.getByLabelText("Layer name"), { target: { value: "Iowa cities" } });
    fireEvent.click(screen.getByRole("button", { name: "Add layer" }));
    await waitFor(() => assert.equal(closed(), 1));
    const layer = useAppStore.getState().layers.find((l) => l.name === "Iowa cities");
    assert.ok(layer, JSON.stringify(useAppStore.getState().layers.map((l) => l.name)));
    assert.equal(layer.geojson?.features.length, 1);
    assert.equal(layer.geojson?.features[0]?.properties?.name, "Ames");
    assert.ok(requested.some((url) => url.includes("returnCountOnly=true")));
    // The page is requested by object id range, from the ids the service listed.
    const page = requested.find((url) => url.includes("f=geojson"));
    assert.equal(
      new URLSearchParams(page!.split("?")[1]).get("where"),
      "OBJECTID >= 1 AND OBJECTID <= 1",
    );
  });

  it("reports a service error and keeps the dialog open", async () => {
    citiesServer();
    const { closed } = renderAddDataSource(
      createElement(ArcGISSource, { initialUrl: `${BASE}/Missing/FeatureServer/0` }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add layer" }));
    await waitFor(() => assert.ok(/Invalid URL/.test(text()), text().slice(-300)));
    assert.equal(closed(), 0);
    assert.equal(useAppStore.getState().layers.length, 0);
  });

  it("browses a map service's sublayers and builds the selection", async () => {
    const requested = arcgisServer({
      "/arcgis/rest/services/Boundaries/MapServer": {
        layers: [
          { id: 0, name: "States" },
          { id: 2, name: "Counties" },
          { id: -1, name: "Invalid" },
        ],
      },
    });
    renderAddDataSource(
      createElement(ArcGISSource, { initialUrl: `${BASE}/Boundaries/MapServer` }),
    );
    assert.equal((screen.getByLabelText("Layer type") as HTMLSelectElement).value, "map-service");
    fireEvent.click(screen.getByRole("button", { name: "Browse layers" }));
    await waitFor(() =>
      assert.equal(screen.queryAllByRole("checkbox", { name: /\(\d\)/ }).length, 2),
    );
    assert.ok(requested[0]!.startsWith("/arcgis/rest/services/Boundaries/MapServer?"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Counties (2)" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "States (0)" }));
    assert.equal((screen.getByLabelText("Sublayers") as HTMLInputElement).value, "0,2");
    fireEvent.click(screen.getByRole("checkbox", { name: "States (0)" }));
    assert.equal((screen.getByLabelText("Sublayers") as HTMLInputElement).value, "2");
  });

  it("explains a map service without sublayers", async () => {
    arcgisServer({ "/arcgis/rest/services/Empty/MapServer": { layers: [] } });
    renderAddDataSource(createElement(ArcGISSource, { initialUrl: `${BASE}/Empty/MapServer` }));
    fireEvent.click(screen.getByRole("button", { name: "Browse layers" }));
    await waitFor(() =>
      assert.ok(text().includes("This map service did not advertise any layers.")),
    );
  });

  it("lists an image service's raster functions", async () => {
    arcgisServer({
      "/arcgis/rest/services/Elevation/ImageServer": {
        rasterFunctionInfos: [
          { name: "None" },
          { name: "Hillshade", description: "Shaded relief" },
        ],
      },
    });
    renderAddDataSource(
      createElement(ArcGISSource, { initialUrl: `${BASE}/Elevation/ImageServer` }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Browse functions" }));
    await waitFor(() =>
      assert.ok(screen.queryAllByRole("option", { name: /Hillshade/ }).length > 0),
    );
  });
});
