import { fireEvent, mockFetch, screen, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createElement } from "react";
import { setSidecarAuthToken } from "@geolibre/processing";
import { renderAddDataSource } from "./helpers/add-data-shell";

const { PostgresSource } =
  await import("../apps/geolibre-desktop/src/components/layout/add-data/sources/PostgresSource");
const { resolvePostgisConnection } =
  await import("../apps/geolibre-desktop/src/lib/postgis-connections");

const CONNECTION = "postgres://gis:secret@db.example.com:5432/city";

type TauriWindow = Window & {
  __TAURI_INTERNALS__?: { invoke: (command: string) => Promise<unknown> };
};

/** Pretend to be the desktop shell, whose sidecar answers on 127.0.0.1:8765. */
function asDesktop() {
  Object.defineProperty(window as TauriWindow, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {
      invoke: async (command: string) => {
        // Remembering the connection stores its credential in the keychain.
        if (command.startsWith("secure_store_")) return null;
        assert.equal(command, "start_geolibre_sidecar");
        return { baseUrl: "http://127.0.0.1:8765", port: 8765, token: "test-token" };
      },
    },
  });
}

afterEach(() => {
  delete (window as TauriWindow).__TAURI_INTERNALS__;
  setSidecarAuthToken(null);
  window.localStorage.clear();
});

const TABLES = [
  {
    schema: "public",
    table: "parcels",
    geometry_column: "geom",
    srid: 4326,
    geometry_type: "POLYGON",
    primary_key: "id",
  },
  {
    schema: "public",
    table: "audit_log",
    geometry_column: "geom",
    srid: 4326,
    geometry_type: "POINT",
    primary_key: null,
  },
];

/** Serve the sidecar's /postgis endpoints and record request bodies. */
function sidecar(options: { available?: boolean; tables?: unknown[] } = {}) {
  const calls: Array<{ path: string; body: Record<string, unknown> | null }> = [];
  mockFetch(async (input, init) => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ path: url.pathname, body });
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    if (url.pathname.endsWith("/postgis/status"))
      return json({ available: options.available ?? true, message: "" });
    if (url.pathname.endsWith("/postgis/tables")) return json({ tables: options.tables ?? TABLES });
    if (url.pathname.endsWith("/postgis/read")) {
      return json({
        geojson: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              id: 7,
              properties: { owner: "Smith" },
              geometry: { type: "Point", coordinates: [-93.6, 42.0] },
            },
          ],
        },
        schema: "public",
        table: "parcels",
        geometry_column: "geom",
        srid: 4326,
        primary_key: "id",
        feature_count: 1,
      });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  return calls;
}

const text = () => document.body.textContent ?? "";

function connectEditable() {
  fireEvent.change(screen.getByLabelText("Load as"), { target: { value: "editable" } });
  fireEvent.change(screen.getByLabelText("PostgreSQL connection string"), {
    target: { value: CONNECTION },
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
}

describe("PostgresSource", () => {
  it("explains that the web app cannot connect and disables Connect", () => {
    renderAddDataSource(createElement(PostgresSource));
    assert.ok(text().includes("PostgreSQL layers are only available in the GeoLibre Desktop"));
    assert.equal(screen.getByRole("button", { name: "Connect" }).hasAttribute("disabled"), true);
  });

  it("lists tables, preselects the first writable one and adds it as an editable layer", async () => {
    asDesktop();
    const calls = sidecar();
    const { added, closed } = renderAddDataSource(createElement(PostgresSource));
    connectEditable();
    await waitFor(() => assert.ok(text().includes("Found 2 spatial tables.")));
    assert.deepEqual(calls.find((c) => c.path.endsWith("/postgis/tables"))?.body, {
      connection: CONNECTION,
    });
    const table = screen.getByLabelText("Table") as HTMLSelectElement;
    assert.equal(table.selectedOptions[0]?.textContent?.includes("parcels"), true);
    // A table without a primary key is listed but cannot be picked.
    const readOnly = Array.from(table.options).find((o) => o.textContent?.includes("audit_log"));
    assert.equal(readOnly?.disabled, true);

    fireEvent.click(screen.getByRole("button", { name: "Add layer" }));
    await waitFor(() => assert.equal(added.length, 1));
    const layer = added[0]!;
    // The default layer name is kept unless the user types one.
    assert.equal(layer.name, "PostgreSQL layer");
    assert.equal(layer.geojson?.features.length, 1);
    assert.equal(layer.metadata?.postgisPrimaryKey, "id");
    assert.equal(layer.metadata?.sourceKind, "postgis-table");
    // The connection string stays in memory, keyed by layer, never on the layer.
    assert.equal(resolvePostgisConnection(layer), CONNECTION);
    assert.ok(!JSON.stringify(layer).includes("secret"));
    assert.deepEqual(calls.find((c) => c.path.endsWith("/postgis/read"))?.body, {
      connection: CONNECTION,
      schema_name: "public",
      table: "parcels",
      geometry_column: "geom",
    });
    assert.equal(closed(), 1);
  });

  it("reports a sidecar without the PostGIS runtime", async () => {
    asDesktop();
    sidecar({ available: false });
    renderAddDataSource(createElement(PostgresSource));
    connectEditable();
    await waitFor(() =>
      assert.ok(text().includes("does not have the PostGIS runtime (psycopg) installed")),
    );
  });

  it("says so when the database has no spatial tables", async () => {
    asDesktop();
    sidecar({ tables: [] });
    renderAddDataSource(createElement(PostgresSource));
    connectEditable();
    await waitFor(() =>
      assert.ok(text().includes("No spatial tables were found in this database.")),
    );
  });
});
