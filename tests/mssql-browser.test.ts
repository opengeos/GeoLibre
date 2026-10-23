import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TFunction } from "i18next";
import i18next from "i18next";
import {
  fetchMssqlBrowserTables,
  forgetMssqlBrowserConnection,
  type MssqlBrowserLoaderDependencies,
} from "../apps/geolibre-desktop/src/lib/mssql-browser";
import type { ConnectionLoads } from "../apps/geolibre-desktop/src/lib/browser-tree";
import { MssqlReconnectRequiredError } from "../apps/geolibre-desktop/src/lib/mssql-sessions";
import { StaleSidecarError } from "../apps/geolibre-desktop/src/lib/sidecar";

const table = {
  schema: "dbo",
  table: "parcels",
  geometry_column: "shape",
  column_type: "geometry" as const,
  srid: 4326,
  geometry_type: "POLYGON",
  geometry_types: ["POLYGON"],
  mixed_geometry: false,
  mixed_srid: false,
  primary_key: "id",
  primary_key_columns: ["id"],
};
function dependencies(
  overrides: Partial<MssqlBrowserLoaderDependencies> = {},
): MssqlBrowserLoaderDependencies {
  return {
    isDesktop: () => true,
    startSidecar: async () => ({ baseUrl: "http://127.0.0.1", port: 8765, token: "test" }),
    fetchStatus: async () => ({
      available: true,
      message: "",
      driver: "ODBC Driver 18",
      auth_methods: ["sql"],
    }),
    listTables: async () => [table, table],
    withSession: async (_connectionId, run) => run("session"),
    ...overrides,
  };
}
function loadState() {
  let loads: ConnectionLoads = {};
  return {
    get loads() {
      return loads;
    },
    set: (update: (previous: ConnectionLoads) => ConnectionLoads) => {
      loads = update(loads);
    },
  };
}
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("MSSQL Browser table loading", () => {
  it("loads and de-duplicates tables, and does not refetch a settled connection", async () => {
    const state = loadState();
    const fetched = new Set<string>();
    let listCalls = 0;
    const deps = dependencies({
      listTables: async () => {
        listCalls += 1;
        return [table, table];
      },
    });

    fetchMssqlBrowserTables("profile", fetched, state.set, i18next.t, deps);
    await nextTurn();
    fetchMssqlBrowserTables("profile", fetched, state.set, i18next.t, deps);

    assert.deepEqual(state.loads["mssql:profile"], { status: "loaded", tables: [table] });
    assert.equal(listCalls, 1);
  });

  it("reports desktop-only access without caching the failed load", () => {
    const state = loadState();
    const fetched = new Set<string>();
    fetchMssqlBrowserTables(
      "profile",
      fetched,
      state.set,
      i18next.t,
      dependencies({ isDesktop: () => false }),
    );

    assert.equal(fetched.has("profile"), false);
    assert.equal(state.loads["mssql:profile"]?.status, "error");
  });

  it("clears a failed runtime lookup so expanding the node can retry", async () => {
    const state = loadState();
    const fetched = new Set<string>();
    fetchMssqlBrowserTables(
      "profile",
      fetched,
      state.set,
      i18next.t,
      dependencies({
        fetchStatus: async () => ({
          available: false,
          message: "ODBC unavailable",
          driver: null,
          auth_methods: [],
        }),
      }),
    );
    await nextTurn();

    assert.equal(fetched.has("profile"), false);
    assert.equal(state.loads["mssql:profile"]?.status, "error");
  });

  it("surfaces a stale sidecar instead of querying it without a token", async () => {
    const state = loadState();
    const fetched = new Set<string>();
    let statusCalls = 0;
    const stale =
      "A GeoLibre processing server from a previous session is still running on port 8765 " +
      "but does not accept this session's token. Quit any stray GeoLibre processes and try again.";
    fetchMssqlBrowserTables(
      "profile",
      fetched,
      state.set,
      i18next.t,
      dependencies({
        startSidecar: async () => {
          throw new StaleSidecarError(stale);
        },
        fetchStatus: async () => {
          statusCalls += 1;
          throw new Error("Missing or invalid sidecar token");
        },
      }),
    );
    await nextTurn();

    assert.deepEqual(state.loads["mssql:profile"], { status: "error", message: stale });
    assert.equal(statusCalls, 0);
    assert.equal(fetched.has("profile"), false);
  });

  it("lets the runtime status explain any other failed start", async () => {
    const state = loadState();
    const fetched = new Set<string>();
    fetchMssqlBrowserTables(
      "profile",
      fetched,
      state.set,
      i18next.t,
      dependencies({
        startSidecar: async () => {
          throw new Error("uv sync failed");
        },
      }),
    );
    await nextTurn();

    assert.deepEqual(state.loads["mssql:profile"], { status: "loaded", tables: [table] });
  });

  it("explains when a saved profile has no restorable credential", async () => {
    const state = loadState();
    const fetched = new Set<string>();
    const translate = ((key: string) => key) as unknown as TFunction;
    fetchMssqlBrowserTables(
      "profile",
      fetched,
      state.set,
      translate,
      dependencies({
        withSession: async () => {
          throw new MssqlReconnectRequiredError(
            "Reconnect to SQL Server in Add Data.",
            "secret-missing",
          );
        },
      }),
    );
    await nextTurn();

    assert.equal(fetched.has("profile"), false);
    const load = state.loads["mssql:profile"];
    assert.ok(load?.status === "error");
    assert.equal(load.message, "addData.mssql.errorBrowserMissingSecret");
  });

  for (const { scenario, message } of [
    { scenario: "login", message: "Login failed for user 'sa'. (18456)" },
    {
      scenario: "reachability",
      message:
        "Could not connect to SQL Server: Nothing is accepting connections at h:1433. Driver message: connection timed out",
    },
  ]) {
    it(`preserves SQL Server ${scenario} errors`, async () => {
      const state = loadState();
      const fetched = new Set<string>();
      fetchMssqlBrowserTables(
        "profile",
        fetched,
        state.set,
        i18next.t,
        dependencies({
          withSession: async () => {
            throw new Error(message);
          },
        }),
      );
      await nextTurn();

      assert.equal(fetched.has("profile"), false);
      assert.deepEqual(state.loads["mssql:profile"], { status: "error", message });
    });
  }

  it("surfaces the SQL Server connection error and permits retry", async () => {
    const state = loadState();
    const fetched = new Set<string>();
    fetchMssqlBrowserTables(
      "profile",
      fetched,
      state.set,
      i18next.t,
      dependencies({
        withSession: async () => {
          throw new Error("SQL Server refused the connection");
        },
      }),
    );
    await nextTurn();

    assert.equal(fetched.has("profile"), false);
    assert.deepEqual(state.loads["mssql:profile"], {
      status: "error",
      message: "SQL Server refused the connection",
    });
  });

  it("forgets a profile and drops its cached tables so it loads afresh", async () => {
    const state = loadState();
    const fetched = new Set<string>();
    let listCalls = 0;
    const deps = dependencies({
      listTables: async () => {
        listCalls += 1;
        return [table];
      },
    });
    fetchMssqlBrowserTables("profile", fetched, state.set, i18next.t, deps);
    await nextTurn();
    state.set((previous) => ({ ...previous, "mssql:other": { status: "loading" } }));
    const forgotten: string[] = [];

    forgetMssqlBrowserConnection("profile", fetched, state.set, (id) => forgotten.push(id));

    assert.deepEqual(forgotten, ["profile"]);
    assert.deepEqual(state.loads, { "mssql:other": { status: "loading" } });
    fetchMssqlBrowserTables("profile", fetched, state.set, i18next.t, deps);
    await nextTurn();
    assert.equal(listCalls, 2);
  });
});
