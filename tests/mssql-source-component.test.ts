import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement, createRef, useState } from "react";
import { setSidecarAuthToken } from "@geolibre/processing";
import type { GeoLibreLayer } from "@geolibre/core";
import { fireEvent, mockFetch, render, screen, waitFor } from "./helpers/dom";
import { resetMssqlSessions } from "../apps/geolibre-desktop/src/lib/mssql-sessions";
import {
  MSSQL_CONNECTIONS_STORAGE_KEY,
  setKeychainMssqlSecrets,
  setMssqlKeychainWritable,
} from "../apps/geolibre-desktop/src/lib/saved-mssql-connections";
import type { OpenAddDataMssql } from "../apps/geolibre-desktop/src/components/layout/add-data/open-add-data";
import type { AddDataShellContextValue } from "../apps/geolibre-desktop/src/components/layout/add-data/context";

const [{ MssqlSource }, { AddDataShellProvider }] = await Promise.all([
  import("../apps/geolibre-desktop/src/components/layout/add-data/sources/MssqlSource"),
  import("../apps/geolibre-desktop/src/components/layout/add-data/context"),
]);

function baseShell(): AddDataShellContextValue {
  return {
    mapControllerRef: createRef(),
    addLayer: () => {},
    existingLayers: [],
    isSubmitting: false,
    setIsSubmitting: () => {},
    closeDialog: () => {},
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
}

function renderMssqlSource(initialMssql?: OpenAddDataMssql) {
  return render(
    createElement(
      AddDataShellProvider,
      { value: baseShell() },
      createElement(MssqlSource, { initialMssql }),
    ),
  );
}

/** Renders with a live `isSubmitting` flag, as the dialog does, and records added layers. */
function renderSubmittingMssqlSource(added: GeoLibreLayer[]) {
  function Shell() {
    const [isSubmitting, setIsSubmitting] = useState(false);
    return createElement(
      AddDataShellProvider,
      {
        value: {
          ...baseShell(),
          addLayer: (layer: GeoLibreLayer) => added.push(layer),
          isSubmitting,
          setIsSubmitting,
        },
      },
      createElement(MssqlSource, {}),
    );
  }
  return render(createElement(Shell));
}

describe("MssqlSource", () => {
  it("explains the desktop-only constraint and disables connecting in the web app", () => {
    renderMssqlSource();

    const notice = "SQL Server layers are only available in GeoLibre Desktop.";
    assert.equal(screen.getByText(notice).textContent, notice);
    assert.ok(screen.getByLabelText("Server"));
    assert.ok(screen.getByLabelText("Database"));
    assert.equal(screen.getByRole("button", { name: "Connect" }).hasAttribute("disabled"), true);
  });

  it("falls back to a new connection when the prefilled profile is missing", () => {
    window.localStorage.setItem(
      MSSQL_CONNECTIONS_STORAGE_KEY,
      JSON.stringify([
        {
          id: "00000000-0000-4000-8000-000000000002",
          server: "saved.example",
          port: 1433,
          database: "gis",
          encrypt: true,
          trustServerCertificate: false,
          authMethod: "sql",
          username: "sa",
        },
      ]),
    );

    renderMssqlSource({ connectionId: "00000000-0000-4000-8000-000000000003" });

    const savedConnection = screen.getByLabelText("Saved connection") as HTMLSelectElement;
    assert.equal(savedConnection.options.length, 2);
    assert.equal(savedConnection.value, "");
    assert.equal((screen.getByLabelText("Server") as HTMLInputElement).value, "");
  });
  it("clears authentication-specific values when the method changes", () => {
    renderMssqlSource();

    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "stale-user" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "stale-password" } });
    const method = screen.getByLabelText("Authentication");
    fireEvent.change(method, { target: { value: "entra_sp" } });
    fireEvent.change(screen.getByLabelText("Tenant ID"), { target: { value: "tenant" } });
    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "client" } });
    fireEvent.change(screen.getByLabelText("Client secret"), {
      target: { value: "stale-secret" },
    });
    fireEvent.change(method, { target: { value: "token" } });
    fireEvent.change(screen.getByLabelText("Access token"), {
      target: { value: "stale-token" },
    });
    fireEvent.change(method, { target: { value: "entra_sp" } });

    assert.equal((screen.getByLabelText("Tenant ID") as HTMLInputElement).value, "");
    assert.equal((screen.getByLabelText("Client ID") as HTMLInputElement).value, "");
    assert.equal((screen.getByLabelText("Client secret") as HTMLInputElement).value, "");
    fireEvent.change(method, { target: { value: "sql" } });
    assert.equal((screen.getByLabelText("Username") as HTMLInputElement).value, "");
    assert.equal((screen.getByLabelText("Password") as HTMLInputElement).value, "");
    fireEvent.change(method, { target: { value: "token" } });
    assert.equal((screen.getByLabelText("Access token") as HTMLInputElement).value, "");
  });

  it("prompts for a password and sends it when the keychain cannot restore a saved secret", async () => {
    const tauriWindow = window as Window & {
      __TAURI_INTERNALS__?: { invoke: (command: string) => Promise<unknown> };
    };
    const previous = tauriWindow.__TAURI_INTERNALS__;
    const previousProfiles = window.localStorage.getItem(MSSQL_CONNECTIONS_STORAGE_KEY);
    const profile = {
      id: "00000000-0000-4000-8000-000000000001",
      server: "saved.example",
      port: 1433,
      database: "gis",
      encrypt: true,
      trustServerCertificate: false,
      authMethod: "sql" as const,
      username: "sa",
    };
    Object.defineProperty(tauriWindow, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {
        invoke: async (command: string) => {
          assert.equal(command, "start_geolibre_sidecar");
          return { baseUrl: "http://127.0.0.1:8765", port: 8765, token: "test-token" };
        },
      },
    });
    resetMssqlSessions();
    window.localStorage.setItem(MSSQL_CONNECTIONS_STORAGE_KEY, JSON.stringify([profile]));
    setKeychainMssqlSecrets({});
    setMssqlKeychainWritable(false);
    let connectBody: { auth?: { password?: string } } | undefined;
    mockFetch(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/mssql/status")) {
        return new Response(
          JSON.stringify({ available: true, auth_methods: ["sql"], message: "" }),
          { status: 200 },
        );
      }
      if (url.pathname.endsWith("/mssql/connect")) {
        connectBody = JSON.parse(String(init?.body)) as { auth?: { password?: string } };
        return new Response(JSON.stringify({ session_id: "session-1" }), { status: 200 });
      }
      if (url.pathname.endsWith("/mssql/tables")) {
        return new Response(JSON.stringify({ tables: [] }), { status: 200 });
      }
      if (url.pathname.endsWith("/mssql/disconnect")) {
        return new Response("{}", { status: 200 });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });

    try {
      renderMssqlSource();
      const password = screen.getByLabelText("Password") as HTMLInputElement;
      assert.notEqual(password.placeholder, "Saved securely on this device");
      fireEvent.change(password, { target: { value: "typed-after-keychain-denied" } });
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));

      await waitFor(() => {
        assert.ok(screen.getByText("No spatial tables were found in this database."));
      });
      assert.equal(connectBody?.auth?.password, "typed-after-keychain-denied");
    } finally {
      resetMssqlSessions();
      setSidecarAuthToken(null);
      setKeychainMssqlSecrets({});
      setMssqlKeychainWritable(true);
      if (previousProfiles === null) {
        window.localStorage.removeItem(MSSQL_CONNECTIONS_STORAGE_KEY);
      } else {
        window.localStorage.setItem(MSSQL_CONNECTIONS_STORAGE_KEY, previousProfiles);
      }
      if (previous === undefined) {
        delete tauriWindow.__TAURI_INTERNALS__;
      } else {
        Object.defineProperty(tauriWindow, "__TAURI_INTERNALS__", {
          configurable: true,
          value: previous,
        });
      }
    }
  });

  it("disconnects a session when table discovery fails after connect", async () => {
    const tauriWindow = window as Window & {
      __TAURI_INTERNALS__?: { invoke: (command: string) => Promise<unknown> };
    };
    const previous = tauriWindow.__TAURI_INTERNALS__;
    Object.defineProperty(tauriWindow, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {
        invoke: async (command: string) => {
          assert.equal(command, "start_geolibre_sidecar");
          return { baseUrl: "http://127.0.0.1:8765", port: 8765, token: "test-token" };
        },
      },
    });
    resetMssqlSessions();
    const requests: string[] = [];
    mockFetch(async (input, init) => {
      const url = new URL(String(input));
      requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname.endsWith("/mssql/status")) {
        return new Response(
          JSON.stringify({ available: true, auth_methods: ["sql"], message: "" }),
          { status: 200 },
        );
      }
      if (url.pathname.endsWith("/mssql/connect")) {
        return new Response(JSON.stringify({ session_id: "session-1" }), { status: 200 });
      }
      if (url.pathname.endsWith("/mssql/tables")) {
        return new Response(JSON.stringify({ detail: "Table discovery denied" }), { status: 403 });
      }
      if (url.pathname.endsWith("/mssql/disconnect")) {
        return new Response("{}", { status: 200 });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });

    try {
      renderMssqlSource();
      fireEvent.change(screen.getByLabelText("Server"), { target: { value: "db.example" } });
      fireEvent.change(screen.getByLabelText("Database"), { target: { value: "gis" } });
      fireEvent.change(screen.getByLabelText("Username"), { target: { value: "user" } });
      fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password" } });
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));

      await waitFor(() => {
        assert.equal(requests.filter((request) => request.endsWith("/mssql/disconnect")).length, 1);
      });
    } finally {
      resetMssqlSessions();
      setSidecarAuthToken(null);
      if (previous === undefined) {
        delete tauriWindow.__TAURI_INTERNALS__;
      } else {
        Object.defineProperty(tauriWindow, "__TAURI_INTERNALS__", {
          configurable: true,
          value: previous,
        });
      }
    }
  });

  it("disconnects the active profile when switching to a new connection", async () => {
    const tauriWindow = window as Window & {
      __TAURI_INTERNALS__?: { invoke: (command: string) => Promise<unknown> };
    };
    const previous = tauriWindow.__TAURI_INTERNALS__;
    Object.defineProperty(tauriWindow, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {
        invoke: async (command: string) => {
          assert.equal(command, "start_geolibre_sidecar");
          return { baseUrl: "http://127.0.0.1:8765", port: 8765, token: "test-token" };
        },
      },
    });
    resetMssqlSessions();
    setKeychainMssqlSecrets({});
    setMssqlKeychainWritable(false);
    const requests: string[] = [];
    mockFetch(async (input, init) => {
      const url = new URL(String(input));
      requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname.endsWith("/mssql/status")) {
        return new Response(
          JSON.stringify({ available: true, auth_methods: ["sql"], message: "" }),
          { status: 200 },
        );
      }
      if (url.pathname.endsWith("/mssql/connect")) {
        return new Response(JSON.stringify({ session_id: "session-1" }), { status: 200 });
      }
      if (url.pathname.endsWith("/mssql/tables")) {
        return new Response(JSON.stringify({ tables: [] }), { status: 200 });
      }
      if (url.pathname.endsWith("/mssql/disconnect")) {
        return new Response("{}", { status: 200 });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });

    try {
      renderMssqlSource();
      fireEvent.change(screen.getByLabelText("Server"), { target: { value: "db.example" } });
      fireEvent.change(screen.getByLabelText("Database"), { target: { value: "gis" } });
      fireEvent.change(screen.getByLabelText("Username"), { target: { value: "user" } });
      fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password" } });
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));

      await waitFor(() => {
        assert.ok(screen.getByText("No spatial tables were found in this database."));
      });
      fireEvent.change(screen.getByLabelText("Saved connection"), { target: { value: "" } });

      await waitFor(() => {
        assert.equal(requests.filter((request) => request.endsWith("/mssql/disconnect")).length, 1);
      });
    } finally {
      resetMssqlSessions();
      setSidecarAuthToken(null);
      setKeychainMssqlSecrets({});
      setMssqlKeychainWritable(true);
      if (previous === undefined) {
        delete tauriWindow.__TAURI_INTERNALS__;
      } else {
        Object.defineProperty(tauriWindow, "__TAURI_INTERNALS__", {
          configurable: true,
          value: previous,
        });
      }
    }
  });

  /**
   * Connects through the form and submits the first table while its read is held
   * open, optionally editing the server before the read returns.
   */
  async function importTable(changeServerMidRead: boolean) {
    const tauriWindow = window as Window & {
      __TAURI_INTERNALS__?: { invoke: (command: string) => Promise<unknown> };
    };
    const previous = tauriWindow.__TAURI_INTERNALS__;
    Object.defineProperty(tauriWindow, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {
        invoke: async (command: string) => {
          assert.equal(command, "start_geolibre_sidecar");
          return { baseUrl: "http://127.0.0.1:8765", port: 8765, token: "test-token" };
        },
      },
    });
    resetMssqlSessions();
    setKeychainMssqlSecrets({});
    setMssqlKeychainWritable(false);
    const table = {
      schema: "dbo",
      table: "parcels",
      geometry_column: "geom",
      column_type: "geometry",
      srid: 4326,
      geometry_type: "POINT",
      geometry_types: ["Point", "MultiPoint"],
      mixed_geometry: true,
      mixed_srid: true,
      primary_key: "id",
      primary_key_columns: ["id"],
    };
    const compositeTable = {
      schema: "dbo",
      table: "archive",
      geometry_column: "shape",
      column_type: "geometry",
      srid: 0,
      geometry_type: "Unknown",
      geometry_types: ["Polygon"],
      mixed_geometry: false,
      mixed_srid: false,
      primary_key: null,
      primary_key_columns: ["tenant_id", "parcel_id"],
    };
    let releaseRead: () => void = () => {};
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const feature = {
      type: "Feature",
      id: 1,
      geometry: { type: "Point", coordinates: [0, 0] },
      properties: { name: "One" },
    };
    const requests: string[] = [];
    mockFetch(async (input, init) => {
      const url = new URL(String(input));
      requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname.endsWith("/mssql/status")) {
        return new Response(
          JSON.stringify({ available: true, auth_methods: ["sql"], message: "" }),
          { status: 200 },
        );
      }
      if (url.pathname.endsWith("/mssql/connect")) {
        return new Response(JSON.stringify({ session_id: "session-1" }), { status: 200 });
      }
      if (url.pathname.endsWith("/mssql/tables")) {
        return new Response(JSON.stringify({ tables: [table, compositeTable] }), { status: 200 });
      }
      if (url.pathname.endsWith("/mssql/read")) {
        await readGate;
        return new Response(
          JSON.stringify({
            ...table,
            feature_count: 1,
            geojson: { type: "FeatureCollection", features: [feature] },
          }),
          { status: 200 },
        );
      }
      if (url.pathname.endsWith("/mssql/disconnect")) {
        return new Response("{}", { status: 200 });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });

    const added: GeoLibreLayer[] = [];
    try {
      const { container } = renderSubmittingMssqlSource(added);
      fireEvent.change(screen.getByLabelText("Server"), { target: { value: "db.example" } });
      fireEvent.change(screen.getByLabelText("Database"), { target: { value: "gis" } });
      fireEvent.change(screen.getByLabelText("Username"), { target: { value: "user" } });
      fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password" } });
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));
      const submit = () => container.querySelector<HTMLButtonElement>('button[type="submit"]');
      await waitFor(() => assert.equal(submit()?.disabled, false));

      const options = Array.from(
        container.querySelectorAll<HTMLOptionElement>("#mssql-table option"),
      );
      assert.ok(options.some((option) => option.textContent?.includes("Point / MultiPoint")));
      assert.ok(options.some((option) => option.textContent?.includes("mixed SRIDs")));
      const compositeOption = options.find((option) =>
        option.textContent?.includes("composite primary key tenant_id, parcel_id"),
      );
      assert.equal(compositeOption?.disabled, true);

      fireEvent.submit(container.querySelector("form")!);
      await waitFor(() => assert.ok(requests.some((request) => request.endsWith("/mssql/read"))));
      if (changeServerMidRead) {
        fireEvent.change(screen.getByLabelText("Server"), { target: { value: "other.example" } });
      }
      releaseRead();
      await waitFor(() => assert.equal(submit()?.disabled, true));
      if (changeServerMidRead) {
        await waitFor(() => {
          assert.equal(
            requests.filter((request) => request.endsWith("/mssql/disconnect")).length,
            1,
          );
        });
      } else {
        await waitFor(() => assert.equal(added.length, 1));
      }
      return { added, requests, feature };
    } finally {
      releaseRead();
      resetMssqlSessions();
      setSidecarAuthToken(null);
      setKeychainMssqlSecrets({});
      setMssqlKeychainWritable(true);
      if (previous === undefined) {
        delete tauriWindow.__TAURI_INTERNALS__;
      } else {
        Object.defineProperty(tauriWindow, "__TAURI_INTERNALS__", {
          configurable: true,
          value: previous,
        });
      }
    }
  }

  it("adds the read features to the layer with their keys as the save baseline", async () => {
    const { added, feature } = await importTable(false);
    assert.deepEqual(added[0].geojson?.features, [feature]);
    assert.deepEqual(added[0].metadata.mssqlBaselineKeys, [1]);
    assert.equal(added[0].metadata.mssqlMixedGeometry, true);
    assert.equal(added[0].metadata.mssqlMixedSrid, true);
    assert.deepEqual(added[0].metadata.mssqlPrimaryKeyColumns, ["id"]);
  });

  it("discards a table read whose connection changed while it was loading", async () => {
    const { added } = await importTable(true);
    assert.deepEqual(added, []);
  });
});
