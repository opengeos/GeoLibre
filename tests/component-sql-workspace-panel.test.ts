import { act, fireEvent, render, screen, useAppStore, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createElement } from "react";
import type { GeoLibreLayer } from "@geolibre/core";

const { SqlWorkspacePanel } =
  await import("../apps/geolibre-desktop/src/components/panels/SqlWorkspacePanel");
type Services =
  import("../apps/geolibre-desktop/src/components/panels/SqlWorkspacePanel").SqlWorkspaceServices;
type Result = Awaited<ReturnType<Services["runSqlQuery"]>>;

afterEach(() => window.localStorage.clear());

const GEOMETRY_RESULT: Result = {
  columns: ["name", "pop"],
  rows: [
    { name: "Ames", pop: 66000 },
    { name: "Omaha", pop: 486000 },
  ],
  rowCount: 2,
  geometryColumn: "geom",
  geojson: {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { name: "Ames" },
        geometry: { type: "Point", coordinates: [-93.6, 42] },
      },
      {
        type: "Feature",
        properties: { name: "Omaha" },
        geometry: { type: "Point", coordinates: [-95.9, 41.3] },
      },
    ],
  },
};

/** Query engines that record which one ran what, and a save that records its payload. */
function fakeServices(options: { result?: Result; fail?: string } = {}) {
  const runs: Array<{ engine: string; sql: string }> = [];
  const saved: Array<{ name: string; text: string }> = [];
  const run = (engine: string) => async (sql: string) => {
    runs.push({ engine, sql });
    if (options.fail) throw new Error(options.fail);
    return options.result ?? GEOMETRY_RESULT;
  };
  const services: Services = {
    runSqlQuery: run("duckdb"),
    runPostgisQuery: run("postgis"),
    runSedonaQuery: run("sedona"),
    exportBinaryVectorLayer: async () => ({
      data: new Uint8Array([80, 65, 82, 49]),
      extension: "parquet",
      mimeType: "application/vnd.apache.parquet",
    }),
    saveBinaryFile: async (data, saveOptions) => {
      saved.push({
        name: saveOptions.defaultName,
        text: new TextDecoder().decode(data as Uint8Array),
      });
      return `/exports/${saveOptions.defaultName}`;
    },
  };
  return { services, runs, saved };
}

function renderPanel(services: Services) {
  return render(createElement(SqlWorkspacePanel, { services }));
}

const editor = () => screen.getByLabelText("SQL query") as HTMLTextAreaElement;
const text = () => document.body.textContent ?? "";

function runSql(sql: string) {
  fireEvent.change(editor(), { target: { value: sql } });
  fireEvent.click(screen.getByRole("button", { name: "Run" }));
}

describe("SqlWorkspacePanel", () => {
  it("runs a query with DuckDB and shows the rows", async () => {
    const { services, runs } = fakeServices();
    renderPanel(services);
    runSql("  SELECT name, pop, geom FROM cities  ");
    await waitFor(() => assert.ok(text().includes("2 rows · 2 columns")));
    assert.deepEqual(runs, [{ engine: "duckdb", sql: "SELECT name, pop, geom FROM cities" }]);
    assert.ok(screen.getByRole("cell", { name: "Omaha" }));
  });

  it("runs on Ctrl+Enter with the chosen engine and remembers it", async () => {
    const { services, runs } = fakeServices();
    renderPanel(services);
    fireEvent.change(screen.getByLabelText("SQL engine"), { target: { value: "postgis" } });
    assert.equal(window.localStorage.getItem("geolibre.sqlWorkspace.engine"), "postgis");
    fireEvent.change(editor(), { target: { value: "SELECT postgis_version()" } });
    fireEvent.keyDown(editor(), { key: "Enter", ctrlKey: true });
    await waitFor(() => assert.equal(runs.length, 1));
    assert.equal(runs[0]!.engine, "postgis");
  });

  it("adds a geometry result as a layer, or as a query layer that re-runs its SQL", async () => {
    const { services } = fakeServices();
    renderPanel(services);
    runSql("SELECT * FROM cities");
    await waitFor(() => assert.ok(text().includes("2 rows")));
    fireEvent.change(screen.getByLabelText("Layer name"), { target: { value: "Cities" } });
    fireEvent.click(screen.getByRole("button", { name: "Add as layer" }));
    assert.ok(text().includes('Added 2 features to the map as "Cities".'));
    fireEvent.click(screen.getByRole("button", { name: "Add as query layer" }));
    assert.ok(text().includes('as query layer "Cities"'));
    const layers = useAppStore.getState().layers as GeoLibreLayer[];
    assert.deepEqual(
      layers.map((layer) => layer.name),
      ["Cities", "Cities"],
    );
    assert.equal(layers[0]!.geojson?.features.length, 2);
    assert.ok(JSON.stringify(layers[1]!.metadata).includes("SELECT * FROM cities"));
  });

  it("only offers a query layer for DuckDB results", async () => {
    const { services } = fakeServices();
    renderPanel(services);
    fireEvent.change(screen.getByLabelText("SQL engine"), { target: { value: "sedona" } });
    runSql("SELECT * FROM cities");
    await waitFor(() => assert.ok(text().includes("2 rows")));
    assert.ok(screen.getByRole("button", { name: "Add as layer" }));
    assert.equal(screen.queryByRole("button", { name: "Add as query layer" }), null);
  });

  it("exports the result as CSV and GeoParquet", async () => {
    const { services, saved } = fakeServices();
    renderPanel(services);
    runSql("SELECT * FROM cities");
    await waitFor(() => assert.ok(text().includes("2 rows")));
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => assert.ok(text().includes("Saved CSV as /exports/sql-result.csv.")));
    assert.equal(saved[0]!.text.split(/\r?\n/)[0], "name,pop");
    assert.ok(saved[0]!.text.includes("Omaha,486000"));
    fireEvent.click(screen.getByRole("button", { name: "Export GeoParquet" }));
    await waitFor(() =>
      assert.ok(text().includes("Saved GeoParquet as /exports/sql-result.parquet.")),
    );
  });

  it("explains a missing table by listing the queryable layers", async () => {
    const { services } = fakeServices({
      fail: 'Catalog Error: Table with name "citys" does not exist!',
    });
    act(() =>
      useAppStore.setState({
        layers: [
          {
            id: "cities",
            name: "cities",
            type: "geojson",
            visible: true,
            opacity: 1,
            geojson: { type: "FeatureCollection", features: [] },
          } as unknown as GeoLibreLayer,
        ],
      }),
    );
    renderPanel(services);
    runSql("SELECT * FROM citys");
    await waitFor(() => assert.ok(text().includes("does not exist")));
    assert.ok(text().includes("Queryable layers: cities"));
  });

  it("reports a statement with no rows, and clears the editor", async () => {
    const { services } = fakeServices({
      result: { columns: [], rows: [], rowCount: 0, geometryColumn: null, geojson: null },
    });
    renderPanel(services);
    runSql("CREATE TABLE t AS SELECT 1");
    await waitFor(() => assert.ok(text().includes("Statement executed. No rows returned.")));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    assert.equal(editor().value, "");
    assert.ok(text().includes("Run a query to see results here."));
  });
});
