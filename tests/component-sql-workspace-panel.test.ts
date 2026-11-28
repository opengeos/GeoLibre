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
const { consumePendingAssistantPrompt } =
  await import("../apps/geolibre-desktop/src/lib/assistant-prompt-request");
const { useDesktopSettingsStore } =
  await import("../apps/geolibre-desktop/src/hooks/useDesktopSettings");

afterEach(() => {
  window.localStorage.clear();
  // A prompt a test parked but never read must not reach the next one.
  consumePendingAssistantPrompt();
});

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

  it("hands a failed query and its error to the assistant from Fix", async () => {
    const { services } = fakeServices({
      fail: 'Catalog Error: Table with name "citys" does not exist!',
    });
    renderPanel(services);
    assert.equal(screen.queryByRole("button", { name: "Fix" }), null);
    runSql("SELECT * FROM citys");
    const fix = await screen.findByRole("button", { name: "Fix" });
    // The prompt quotes the statement that failed, not a later edit.
    fireEvent.change(editor(), { target: { value: "SELECT 2" } });
    fireEvent.click(fix);
    assert.equal(useAppStore.getState().ui.assistantOpen, true);
    assert.equal(
      consumePendingAssistantPrompt(),
      [
        "This DuckDB query failed in the SQL workspace. Say what is wrong and reply with a " +
          "corrected query I can paste back in. Don't add anything to the map.",
        "",
        "Query:",
        "```sql",
        "SELECT * FROM citys",
        "```",
        "",
        "Error:",
        "```",
        'Catalog Error: Table with name "citys" does not exist!',
        "```",
      ].join("\n"),
    );
  });

  it("tells the assistant when a failed query is not a DuckDB one", async () => {
    const { services } = fakeServices({ fail: "syntax error at or near FORM" });
    renderPanel(services);
    fireEvent.change(screen.getByLabelText("SQL engine"), { target: { value: "postgis" } });
    runSql("SELECT * FORM cities");
    fireEvent.click(await screen.findByRole("button", { name: "Fix" }));
    const prompt = consumePendingAssistantPrompt();
    assert.ok(prompt?.startsWith("This PostGIS query failed in the SQL workspace."));
    assert.ok(prompt?.includes("It runs on PostGIS, not DuckDB, so keep to PostGIS syntax."));
  });

  it("drops Fix once the query runs, and does not offer it for an export error", async () => {
    const failing = fakeServices({ fail: "boom" });
    const working = fakeServices();
    working.services.saveBinaryFile = async () => {
      throw new Error("Disk is full");
    };
    const { rerender } = renderPanel(failing.services);
    runSql("SELECT * FROM cities");
    await screen.findByRole("button", { name: "Fix" });
    rerender(createElement(SqlWorkspacePanel, { services: working.services }));
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => assert.ok(text().includes("2 rows")));
    assert.equal(screen.queryByRole("button", { name: "Fix" }), null);
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => assert.ok(text().includes("Disk is full")));
    assert.equal(screen.queryByRole("button", { name: "Fix" }), null);
  });

  it("does not offer Fix for an export that fails after a query failed mid-export", async () => {
    const services = fakeServices().services;
    let failQueries = false;
    const runQuery = services.runSqlQuery;
    services.runSqlQuery = async (sql) => {
      if (failQueries) throw new Error("boom");
      return runQuery(sql);
    };
    let rejectSave: (err: Error) => void = () => {};
    services.saveBinaryFile = () =>
      new Promise((_resolve, reject) => {
        rejectSave = reject;
      });
    renderPanel(services);
    runSql("SELECT * FROM cities");
    await waitFor(() => assert.ok(text().includes("2 rows")));
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    failQueries = true;
    runSql("SELECT * FROM nowhere");
    await screen.findByRole("button", { name: "Fix" });
    act(() => rejectSave(new Error("Disk is full")));
    await waitFor(() => assert.ok(text().includes("Disk is full")));
    assert.equal(screen.queryByRole("button", { name: "Fix" }), null);
  });

  it("hands the editor's query to the assistant from Explain", () => {
    const { services, runs } = fakeServices();
    renderPanel(services);
    fireEvent.change(editor(), { target: { value: "  SELECT name FROM cities  " } });
    fireEvent.click(screen.getByRole("button", { name: "Explain" }));
    assert.equal(useAppStore.getState().ui.assistantOpen, true);
    assert.equal(
      consumePendingAssistantPrompt(),
      [
        "Explain what this DuckDB query from the SQL workspace does, step by step. " +
          "Don't run it or change the map.",
        "",
        "Query:",
        "```sql",
        "SELECT name FROM cities",
        "```",
      ].join("\n"),
    );
    // Explaining a query does not run it.
    assert.deepEqual(runs, []);
    fireEvent.change(editor(), { target: { value: "   " } });
    assert.equal(
      (screen.getByRole("button", { name: "Explain" }) as HTMLButtonElement).disabled,
      true,
    );
  });

  it("hides Fix and Explain where the assistant is not offered", async () => {
    const { services } = fakeServices({ fail: "boom" });
    renderPanel(services);
    runSql("SELECT * FROM cities");
    await screen.findByRole("button", { name: "Fix" });
    assert.ok(screen.getByRole("button", { name: "Explain" }));

    // The session's role withholds the assistant.
    const granted = useAppStore.getState().capabilities.privileges;
    act(() =>
      useAppStore
        .getState()
        .setAppPrivileges(granted.filter((privilege) => privilege !== "assistant:use")),
    );
    assert.equal(screen.queryByRole("button", { name: "Fix" }), null);
    assert.equal(screen.queryByRole("button", { name: "Explain" }), null);
    assert.ok(text().includes("boom"));
    act(() => useAppStore.getState().setAppPrivileges([...granted]));
    assert.ok(screen.getByRole("button", { name: "Fix" }));

    // The interface profile hides the assistant's menu entry.
    const settings = useDesktopSettingsStore.getState().desktopSettings;
    act(() =>
      useDesktopSettingsStore.setState({
        desktopSettings: {
          ...settings,
          uiProfile: {
            ...settings.uiProfile,
            enabled: true,
            hiddenMenuItems: ["processing.assistant"],
          },
        },
      }),
    );
    assert.equal(screen.queryByRole("button", { name: "Fix" }), null);
    assert.equal(screen.queryByRole("button", { name: "Explain" }), null);
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
