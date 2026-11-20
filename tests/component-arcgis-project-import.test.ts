import { act, cleanup, mockFetch, render, resetStores, useAppStore, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { createElement } from "react";
import { createEmptyProject } from "@geolibre/core";
import type { ProjectFileActions } from "../apps/geolibre-desktop/src/hooks/useProjectFileActions";

// Loaded after the harness so its CSS imports and Vite globals are handled.
const { useProjectFileActions } =
  await import("../apps/geolibre-desktop/src/hooks/useProjectFileActions");
const { VectorTileLayer } = await import("@esri/maplibre-arcgis");

/** Render the hook and hand back its latest actions. */
function renderActions(): () => ProjectFileActions {
  let actions: ProjectFileActions | null = null;
  function Harness() {
    actions = useProjectFileActions({ current: null });
    return null;
  }
  render(createElement(Harness));
  return () => {
    assert.ok(actions, "hook rendered");
    return actions;
  };
}

/**
 * Answer the browser file picker with `text` as `name`, handing back a
 * function that releases the file's bytes so a test can act while the read
 * is still pending.
 */
function pickFileOnce(name: string, text: string): () => void {
  let release = () => {};
  const read = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bytes = new TextEncoder().encode(text);
  const file = {
    name,
    size: bytes.byteLength,
    arrayBuffer: async () => {
      await read;
      return bytes.buffer;
    },
    text: async () => {
      await read;
      return text;
    },
  };
  const { click } = HTMLInputElement.prototype;
  HTMLInputElement.prototype.click = function (this: HTMLInputElement) {
    HTMLInputElement.prototype.click = click;
    Object.defineProperty(this, "files", { value: [file] });
    void this.onchange?.(new Event("change"));
  };
  return release;
}

/** A map whose vector tile services are listed top first, as ArcGIS Pro does. */
function mapx(serviceNames: string[]): string {
  return JSON.stringify({
    type: "CIMMapDocument",
    mapDefinition: {
      type: "CIMMap",
      name: "Imported map",
      layerDefinitions: serviceNames.map((name, index) => ({
        type: "CIMVectorTileLayer",
        name,
        sourceURI: String(index).repeat(32),
      })),
    },
  });
}

/** Stand-in for the SDK layer `fromPortalItem` resolves to. */
function runtimeLayer(itemId: string) {
  return {
    sources: {
      [itemId]: { type: "vector", bounds: [-1, -1, 1, 1], tiles: ["https://x/{z}/{x}/{y}.pbf"] },
    },
    layers: [{ id: "fill", type: "fill", source: itemId, "source-layer": "s" }],
    setSourceId() {},
  };
}

/**
 * Hold every portal item load until the test releases it, so a test can act
 * while a service is still loading.
 */
function deferServiceLoads() {
  const pending = new Map<string, () => void>();
  const loader = mock.method(VectorTileLayer, "fromPortalItem", (itemId: string) => {
    return new Promise((resolve) => {
      pending.set(itemId, () => resolve(runtimeLayer(itemId) as never));
    });
  });
  return {
    pending,
    release: (itemId: string) => pending.get(itemId)?.(),
    restore: () => loader.mock.restore(),
  };
}

const pastLength = () => useAppStore.temporal.getState().pastStates.length;
const layerNames = () => useAppStore.getState().layers.map((layer) => layer.name);

afterEach(() => {
  cleanup();
  resetStores();
});

describe("Import ArcGIS Pro project", () => {
  it("does not replace a project opened while the file was still being read", async () => {
    const actions = renderActions();
    const release = pickFileOnce("survey.mapx", mapx([]));
    const importing = actions().handleImportArcgisProject();
    // Let the picker answer and the read start.
    await new Promise((resolve) => setTimeout(resolve, 0));
    act(() => useAppStore.getState().loadProject({ ...createEmptyProject(), name: "Opened" }));
    release();
    await act(() => importing);
    assert.equal(useAppStore.getState().projectName, "Opened");
    assert.equal(useAppStore.getState().isDirty, false);
    assert.equal(actions().arcgisImportReport.warnings, null);
  });

  // First of the service tests: the ArcGIS plugin numbers its layers from
  // `arcgis-layer-1` per process, which this case relies on.
  it("leaves a failed service out of the order, even when its name matches a new id", async () => {
    const loader = mock.method(VectorTileLayer, "fromPortalItem", async (itemId: string) => {
      if (itemId === "2".repeat(32)) throw new Error("offline");
      return runtimeLayer(itemId) as never;
    });
    try {
      const actions = renderActions();
      // Top first; the failing service's import id is `arcgis-layer-1`, the id
      // the plugin gives "Top".
      pickFileOnce("survey.mapx", mapx(["Top", "Middle", "arcgis-layer-1"]))();
      await act(() => actions().handleImportArcgisProject());
      assert.deepEqual(layerNames(), ["Middle", "Top"]);
      assert.deepEqual(
        actions().arcgisImportReport.warnings?.map((warning) => [
          warning.layerName,
          warning.reason,
        ]),
        [
          ["Imported map", "map-extent"],
          ["arcgis-layer-1", "service"],
        ],
      );
    } finally {
      loader.mock.restore();
    }
  });

  it("gives a service an id no imported layer already has", async () => {
    const loader = mock.method(VectorTileLayer, "fromPortalItem", async (itemId: string) => {
      return runtimeLayer(itemId) as never;
    });
    try {
      const actions = renderActions();
      // Cached map services keep import ids taken from their names, which here
      // read like the ids the ArcGIS plugin hands out.
      const cached = Array.from({ length: 10 }, (_, index) => ({
        type: "CIMTiledServiceLayer",
        name: `arcgis-layer-${index + 1}`,
        serviceConnection: {
          objectType: "MapServer",
          url: `https://example.com/${index}/MapServer`,
        },
      }));
      const document = JSON.parse(mapx(["Streets"]));
      document.mapDefinition.layerDefinitions.push(...cached);
      pickFileOnce("survey.mapx", JSON.stringify(document))();
      await act(() => actions().handleImportArcgisProject());
      const ids = useAppStore.getState().layers.map((layer) => layer.id);
      assert.equal(ids.length, 11);
      assert.equal(new Set(ids).size, 11);
      // Streets is on top in ArcGIS Pro, so last in the store.
      assert.equal(layerNames().at(-1), "Streets");
    } finally {
      loader.mock.restore();
    }
  });

  it("adds nothing to a project opened while a service was still loading", async () => {
    const services = deferServiceLoads();
    try {
      const actions = renderActions();
      pickFileOnce("survey.mapx", mapx(["Streets"]))();
      const importing = actions().handleImportArcgisProject();
      await waitFor(() => assert.equal(services.pending.size, 1));
      act(() => useAppStore.getState().loadProject({ ...createEmptyProject(), name: "Opened" }));
      const history = pastLength();
      // The service finishes loading after the switch.
      services.release("0".repeat(32));
      await act(() => importing);
      assert.equal(useAppStore.getState().projectName, "Opened");
      assert.deepEqual(layerNames(), []);
      assert.equal(useAppStore.getState().isDirty, false);
      assert.equal(pastLength(), history);
      assert.equal(actions().arcgisImportReport.warnings, null);
    } finally {
      services.restore();
    }
  });

  it("keeps layers a collaboration refresh retained, in ArcGIS Pro's order", async () => {
    const services = deferServiceLoads();
    try {
      const actions = renderActions();
      // "Top" draws above "Bottom" in ArcGIS Pro.
      pickFileOnce("survey.mapx", mapx(["Top", "Bottom"]))();
      const importing = actions().handleImportArcgisProject();
      await waitFor(() => assert.equal(services.pending.size, 1));
      services.release("0".repeat(32));
      await waitFor(() => assert.equal(services.pending.size, 2));
      assert.deepEqual(layerNames(), ["Top"]);
      // A collaboration snapshot refreshes the open project in place: the
      // layers it carries, then a generation bump.
      act(() => {
        useAppStore.setState({ layers: [...useAppStore.getState().layers] });
        useAppStore.setState((state) => ({ projectGeneration: state.projectGeneration + 1 }));
      });
      services.release("1".repeat(32));
      await act(() => importing);
      assert.equal(useAppStore.getState().projectName, "Imported map");
      // Store order is bottom first, whatever order the services loaded in.
      assert.deepEqual(layerNames(), ["Bottom", "Top"]);
      assert.equal(useAppStore.getState().isDirty, true);
    } finally {
      services.restore();
    }
  });

  it("does not hide a service in a project that replaced the import as it landed", async () => {
    const loader = mock.method(VectorTileLayer, "fromPortalItem", async (itemId: string) => {
      return runtimeLayer(itemId) as never;
    });
    try {
      const actions = renderActions();
      const document = JSON.parse(mapx(["Hidden"]));
      document.mapDefinition.layerDefinitions[0].visibility = false;
      pickFileOnce("survey.mapx", JSON.stringify(document))();
      // Open another project in the moment between the service's insertion
      // and the import carrying on.
      const stop = useAppStore.subscribe((state) => {
        if (!state.layers.some((layer) => layer.name === "Hidden")) return;
        stop();
        queueMicrotask(() =>
          useAppStore.getState().loadProject({ ...createEmptyProject(), name: "Opened" }),
        );
      });
      await act(() => actions().handleImportArcgisProject());
      stop();
      assert.equal(useAppStore.getState().projectName, "Opened");
      assert.deepEqual(layerNames(), []);
      assert.equal(useAppStore.getState().isDirty, false);
      assert.equal(actions().arcgisImportReport.warnings, null);
    } finally {
      loader.mock.restore();
    }
  });
});

/** A feature layer whose data is a feature class in a File Geodatabase. */
function gdbLayer(name: string, gdbPath: string) {
  return {
    type: "CIMFeatureLayer",
    name,
    featureTable: {
      dataConnection: {
        workspaceFactory: "FileGDB",
        workspaceConnectionString: `DATABASE=${gdbPath}`,
        dataset: name.toLowerCase(),
      },
    },
  };
}

const PROJECT_PATH = "/work/projects/survey.mapx";
const GDB_PATH = "/work/data/city.gdb";
const PARCELS: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [1, 2] } }],
};

/**
 * Run the import as the desktop build does: a native file dialog, local file
 * reads and the Python sidecar, all answered through a stand-in for Tauri's
 * IPC and the sidecar's HTTP API. The geodatabase lists only "parcels".
 *
 * @param project - The `.mapx` document the dialog picks.
 * @param holdListing - Resolves when the geodatabase listing may answer.
 * @param listingNeverFinishes - The listing job stays running on the sidecar.
 * @param holdRead - When given, the read job runs on the sidecar until it
 *   resolves.
 * @param holdReadStart - When given, the request that starts the read job
 *   does not answer until it resolves.
 */
function desktopImport(
  project: unknown,
  holdListing: Promise<void> = Promise.resolve(),
  listingNeverFinishes = false,
  holdRead?: Promise<void>,
  holdReadStart?: Promise<void>,
) {
  const requests: string[] = [];
  const removed: string[] = [];
  let readDone = false;
  void holdRead?.then(() => {
    readDone = true;
  });
  const globals = globalThis as { window: Window & { __TAURI_INTERNALS__?: unknown } };
  globals.window.__TAURI_INTERNALS__ = {
    invoke: async (command: string, args: { path?: string; paths?: string[] }) => {
      switch (command) {
        case "plugin:dialog|open":
          return PROJECT_PATH;
        case "plugin:fs|read_file":
          return new TextEncoder().encode(
            JSON.stringify(args.path === PROJECT_PATH ? project : PARCELS),
          ).buffer;
        case "start_geolibre_sidecar":
          return { baseUrl: "http://127.0.0.1:8765", port: 8765, token: "t" };
        case "plugin:path|resolve_directory":
          return "/tmp";
        case "plugin:path|join":
          return args.paths?.join("/");
        case "plugin:fs|remove":
          removed.push(String(args.path));
          return null;
        default:
          return null;
      }
    },
  };
  mockFetch(async (input) => {
    const url = String(input);
    requests.push(url.replace(/^.*\/conversion\//, ""));
    if (listingNeverFinishes && (url.endsWith("/vector-layers") || url.endsWith("/jobs/list"))) {
      return Response.json({ id: "list", status: "running" });
    }
    if (url.endsWith("/vector-layers")) {
      await holdListing;
      return Response.json({
        id: "list",
        status: "succeeded",
        result: {
          layers: [{ name: "parcels", feature_count: 1, geometry_type: "Point", crs: "EPSG:4326" }],
        },
      });
    }
    if (holdReadStart && url.endsWith("/vector-to-vector")) await holdReadStart;
    if (holdRead && (url.endsWith("/vector-to-vector") || url.endsWith("/jobs/read"))) {
      return Response.json({ id: "read", status: readDone ? "succeeded" : "running" });
    }
    return Response.json({ id: "read", status: "succeeded" });
  });
  return {
    requests,
    removed,
    restore: () => {
      delete globals.window.__TAURI_INTERNALS__;
    },
  };
}

describe("Import ArcGIS Pro project with File Geodatabase layers (desktop)", () => {
  it("loads readable feature classes in ArcGIS Pro's order and reports the rest", async () => {
    const loader = mock.method(VectorTileLayer, "fromPortalItem", async (itemId: string) => {
      return runtimeLayer(itemId) as never;
    });
    const desktop = desktopImport({
      type: "CIMMapDocument",
      mapDefinition: {
        type: "CIMMap",
        name: "Imported map",
        // Top first: Parcels draws above the Streets service.
        layerDefinitions: [
          gdbLayer("Parcels", GDB_PATH),
          { type: "CIMGroupLayer", name: "Old", layerDefinitions: [gdbLayer("Gone", GDB_PATH)] },
          { type: "CIMVectorTileLayer", name: "Streets", sourceURI: "0".repeat(32) },
        ],
      },
    });
    try {
      const actions = renderActions();
      await act(() => actions().handleImportArcgisProject());
      // Streets joined the store after the load, on top; it is put back below.
      assert.deepEqual(layerNames(), ["Streets", "Parcels"]);
      const parcels = useAppStore.getState().layers[1];
      assert.equal(parcels.geojson?.features.length, 1);
      assert.equal(parcels.metadata.sourceCrs, "EPSG:4326");
      // The group held only the missing feature class.
      assert.deepEqual(useAppStore.getState().layerGroups, []);
      assert.deepEqual(
        actions().arcgisImportWarnings?.map((warning) => [warning.layerName, warning.reason]),
        [
          ["Imported map", "map-extent"],
          ["Gone", "missing-source"],
        ],
      );
      // One listing for the shared geodatabase, one read for Parcels.
      assert.deepEqual(desktop.requests, ["vector-layers", "vector-to-vector"]);
    } finally {
      desktop.restore();
      loader.mock.restore();
    }
  });

  it("stops waiting for a sidecar job once another project opens", async () => {
    const desktop = desktopImport(parcelsOnly, Promise.resolve(), true);
    try {
      const actions = renderActions();
      const importing = actions().handleImportArcgisProject();
      await waitFor(() => assert.deepEqual(desktop.requests, ["vector-layers"]));
      act(() => useAppStore.getState().loadProject({ ...createEmptyProject(), name: "Opened" }));
      // The listing job never finishes, so this only settles if the poll
      // loop gives up on the abort rather than waiting out its timeout.
      await act(() => importing);
      assert.equal(useAppStore.getState().projectName, "Opened");
      assert.deepEqual(layerNames(), []);
      assert.equal(actions().arcgisImportWarnings, null);
      assert.ok(!desktop.requests.includes("vector-to-vector"));
    } finally {
      desktop.restore();
    }
  });

  it("removes an abandoned read's temporary file once its job finishes", async () => {
    let releaseRead = () => {};
    const read = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const desktop = desktopImport(parcelsOnly, Promise.resolve(), false, read);
    try {
      const actions = renderActions();
      const importing = actions().handleImportArcgisProject();
      await waitFor(() => assert.ok(desktop.requests.includes("vector-to-vector")));
      act(() => useAppStore.getState().loadProject({ ...createEmptyProject(), name: "Opened" }));
      await act(() => importing);
      assert.deepEqual(layerNames(), []);
      // The job is still writing its file, so it is not removed yet.
      assert.deepEqual(desktop.removed, []);
      releaseRead();
      await waitFor(() => assert.equal(desktop.removed.length, 1), { timeout: 5000 });
      assert.match(desktop.removed[0], /^\/tmp\/geolibre-gdb-.*\.geojson$/);
    } finally {
      desktop.restore();
    }
  });

  it("settles while the read's start request is pending, then removes its file", async () => {
    let releaseStart = () => {};
    const start = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const desktop = desktopImport(parcelsOnly, Promise.resolve(), false, undefined, start);
    try {
      const actions = renderActions();
      const importing = actions().handleImportArcgisProject();
      await waitFor(() => assert.ok(desktop.requests.includes("vector-to-vector")));
      act(() => useAppStore.getState().loadProject({ ...createEmptyProject(), name: "Opened" }));
      // Settles before the sidecar has even answered with the job.
      await act(() => importing);
      assert.deepEqual(layerNames(), []);
      assert.deepEqual(desktop.removed, []);
      releaseStart();
      await waitFor(() => assert.equal(desktop.removed.length, 1), { timeout: 5000 });
    } finally {
      desktop.restore();
    }
  });

  /** Open a project holding one layer with an unsaved attribute table draft. */
  function projectWithDrafts() {
    act(() => {
      const store = useAppStore.getState();
      store.loadProject({ ...createEmptyProject(), name: "Edited" });
      const id = store.addGeoJsonLayer("Edited layer", PARCELS);
      useAppStore.getState().setAttributeTableDrafts(id, { "0": { name: "edited" } });
    });
  }

  const parcelsOnly = {
    type: "CIMMapDocument",
    mapDefinition: {
      type: "CIMMap",
      name: "Imported map",
      layerDefinitions: [gdbLayer("Parcels", GDB_PATH)],
    },
  };

  it("asks about unsaved attribute drafts before reading any geodatabase", async () => {
    projectWithDrafts();
    const desktop = desktopImport(parcelsOnly);
    const originalConfirm = window.confirm;
    let asked = 0;
    window.confirm = () => {
      asked += 1;
      return false;
    };
    try {
      const actions = renderActions();
      await act(() => actions().handleImportArcgisProject());
      assert.equal(asked, 1);
      // Cancelled before the sidecar did any work, and the project is kept.
      assert.deepEqual(desktop.requests, []);
      assert.equal(useAppStore.getState().projectName, "Edited");
      assert.deepEqual(layerNames(), ["Edited layer"]);
    } finally {
      window.confirm = originalConfirm;
      desktop.restore();
    }
  });

  it("does not ask about the same drafts again once the reads finish", async () => {
    projectWithDrafts();
    const desktop = desktopImport(parcelsOnly);
    const originalConfirm = window.confirm;
    let asked = 0;
    window.confirm = () => {
      asked += 1;
      return true;
    };
    try {
      const actions = renderActions();
      await act(() => actions().handleImportArcgisProject());
      assert.equal(asked, 1);
      assert.deepEqual(desktop.requests, ["vector-layers", "vector-to-vector"]);
      assert.deepEqual(layerNames(), ["Parcels"]);
    } finally {
      window.confirm = originalConfirm;
      desktop.restore();
    }
  });

  it("adds nothing to a project opened while a geodatabase was being read", async () => {
    let releaseListing = () => {};
    const listing = new Promise<void>((resolve) => {
      releaseListing = resolve;
    });
    const desktop = desktopImport(
      {
        type: "CIMMapDocument",
        mapDefinition: {
          type: "CIMMap",
          name: "Imported map",
          layerDefinitions: [gdbLayer("Parcels", GDB_PATH)],
        },
      },
      listing,
    );
    try {
      const actions = renderActions();
      const importing = actions().handleImportArcgisProject();
      await waitFor(() => assert.deepEqual(desktop.requests, ["vector-layers"]));
      act(() => useAppStore.getState().loadProject({ ...createEmptyProject(), name: "Opened" }));
      const history = pastLength();
      // Settles while the listing's HTTP response is still pending.
      await act(() => importing);
      releaseListing();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(useAppStore.getState().projectName, "Opened");
      assert.deepEqual(layerNames(), []);
      assert.equal(useAppStore.getState().isDirty, false);
      assert.equal(pastLength(), history);
      assert.equal(actions().arcgisImportWarnings, null);
      // The feature class is not read once the import is abandoned.
      assert.deepEqual(desktop.requests, ["vector-layers"]);
    } finally {
      desktop.restore();
    }
  });
});
