import { cleanup, fireEvent, screen, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderAddDataSource } from "./helpers/add-data-shell";
import type { IcebergLayerConfig } from "../apps/geolibre-desktop/src/lib/iceberg";

const { IcebergSource } =
  await import("../apps/geolibre-desktop/src/components/layout/add-data/sources/IcebergSource");
type Runtime =
  import("../apps/geolibre-desktop/src/components/layout/add-data/sources/IcebergSource").IcebergRuntime;

const LOCATION = "https://data.example.com/warehouse/taxis/metadata/v3.metadata.json";

/** An Iceberg reader that records every config it is handed. */
function fakeRuntime(overrides: Partial<Runtime> = {}) {
  const calls: Array<{ op: string; config: IcebergLayerConfig }> = [];
  const runtime: Runtime = {
    listIcebergTables: async (config) => {
      calls.push({ op: "list", config });
      return config.mode === "catalog"
        ? [
            { schema: "nyc", name: "taxis" },
            { schema: "nyc", name: "zones" },
          ]
        : [{ name: "taxis" }];
    },
    inspectIcebergTable: async (config) => {
      calls.push({ op: "inspect", config });
      return {
        geometryColumns: [
          { name: "pickup", type: "geometry" },
          { name: "dropoff", type: "geometry(EPSG:3857)" },
        ],
        rowCount: 250000,
        geometryColumn: "pickup",
        crs: null,
      };
    },
    loadIcebergTable: async (config) => {
      calls.push({ op: "load", config });
      return {
        geojson: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: { fare: 12.5 },
              geometry: { type: "Point", coordinates: [-73.98, 40.75] },
            },
          ],
        },
        featureCount: 1,
        totalRows: 250000,
        truncated: true,
        geometryColumn: config.geometryColumn ?? "pickup",
        crs: null,
      };
    },
    ...overrides,
  };
  return { runtime, calls };
}

const text = () => document.body.textContent ?? "";

describe("IcebergSource", () => {
  it("connects to a table location, inspects it and adds a capped snapshot", async () => {
    const { runtime, calls } = fakeRuntime();
    const { added, closed } = renderAddDataSource(
      createElement(IcebergSource, { loadRuntime: async () => runtime }),
    );
    assert.equal(screen.getByRole("button", { name: "Add layer" }).hasAttribute("disabled"), true);
    fireEvent.change(screen.getByLabelText("Table metadata location"), {
      target: { value: LOCATION },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    // The only table is selected and inspected outright.
    await waitFor(() =>
      assert.ok(text().includes("250,000 rows. Geometry: pickup (OGC:CRS84)."), text().slice(-400)),
    );
    assert.deepEqual(
      calls.map((c) => c.op),
      ["list", "inspect"],
    );
    assert.equal(calls[0]!.config.location, LOCATION);
    assert.ok(
      (screen.getByLabelText("SQL (optional)") as HTMLTextAreaElement).value.includes(
        "iceberg_scan",
      ),
    );

    // Switching the geometry column re-reports its CRS without re-reading the table.
    fireEvent.change(screen.getByLabelText("Geometry column"), { target: { value: "dropoff" } });
    assert.ok(text().includes("Geometry: dropoff (EPSG:3857)"));
    fireEvent.change(screen.getByLabelText("Row limit"), { target: { value: "5000" } });
    assert.ok(text().includes("the layer will contain the first 5,000"));

    fireEvent.click(screen.getByRole("button", { name: "Add layer" }));
    await waitFor(() => assert.equal(added.length, 1));
    const load = calls.find((c) => c.op === "load")!.config;
    assert.equal(load.rowLimit, 5000);
    assert.equal(load.geometryColumn, "dropoff");
    // The untouched generated SQL is not frozen onto the layer.
    assert.equal(load.sql, undefined);
    const layer = added[0]!;
    assert.equal(layer.name, "Iceberg layer");
    assert.equal(layer.geojson?.features.length, 1);
    assert.equal(layer.metadata?.icebergTruncated, true);
    assert.equal(layer.metadata?.icebergTotalRows, 250000);
    assert.equal(closed(), 1);
  });

  it("lists a REST catalog's tables and waits for a pick before inspecting", async () => {
    const { runtime, calls } = fakeRuntime();
    renderAddDataSource(createElement(IcebergSource, { loadRuntime: async () => runtime }));
    fireEvent.change(screen.getByLabelText("Iceberg source"), { target: { value: "catalog" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => assert.ok(text().includes("Enter the Iceberg warehouse to attach.")));
    fireEvent.change(screen.getByLabelText("Catalog endpoint"), {
      target: { value: "https://catalog.example.com/api/catalog" },
    });
    fireEvent.change(screen.getByLabelText("Warehouse"), { target: { value: "lake" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => assert.ok(text().includes("Found 2 tables. Select one to continue.")));
    assert.deepEqual(
      calls.map((c) => c.op),
      ["list"],
    );
    fireEvent.change(screen.getByLabelText("Iceberg table"), { target: { value: "nyc.zones" } });
    await waitFor(() => assert.equal(calls.filter((c) => c.op === "inspect").length, 1));
    assert.deepEqual(calls[1]!.config.table, { schema: "nyc", name: "zones" });
    assert.equal(calls[1]!.config.endpoint, "https://catalog.example.com/api/catalog");
  });

  it("drops the connection when the location is edited after Connect", async () => {
    const { runtime } = fakeRuntime();
    renderAddDataSource(createElement(IcebergSource, { loadRuntime: async () => runtime }));
    fireEvent.change(screen.getByLabelText("Table metadata location"), {
      target: { value: LOCATION },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => assert.ok(text().includes("250,000 rows")));
    fireEvent.change(screen.getByLabelText("Table metadata location"), {
      target: { value: `${LOCATION}?v=2` },
    });
    assert.ok(!text().includes("250,000 rows"));
    assert.equal(screen.getByRole("button", { name: "Add layer" }).hasAttribute("disabled"), true);
  });

  it("reports a table with no geometry and a source that cannot be read", async () => {
    const { runtime } = fakeRuntime({
      inspectIcebergTable: async () => ({
        geometryColumns: [],
        rowCount: 12,
        geometryColumn: null,
        crs: null,
      }),
    });
    renderAddDataSource(createElement(IcebergSource, { loadRuntime: async () => runtime }));
    fireEvent.change(screen.getByLabelText("Table metadata location"), {
      target: { value: LOCATION },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => assert.ok(text().includes("12 rows, but no GEOMETRY column was found.")));

    const failing = fakeRuntime({
      listIcebergTables: async () => {
        throw new Error("HTTP 403 reading metadata");
      },
    }).runtime;
    cleanup();
    renderAddDataSource(createElement(IcebergSource, { loadRuntime: async () => failing }));
    fireEvent.change(screen.getByLabelText("Table metadata location"), {
      target: { value: LOCATION },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => assert.ok(text().includes("HTTP 403 reading metadata")));
  });
});
