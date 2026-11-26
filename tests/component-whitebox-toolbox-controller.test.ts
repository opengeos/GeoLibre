import { act, cleanup, fireEvent, render, screen, useAppStore, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import { createElement } from "react";
import type { MapEngine } from "@geolibre/map";
import type { WhiteboxJob, WhiteboxTool } from "@geolibre/processing";
import type { FeatureCollection } from "geojson";
import { renderHook } from "@testing-library/react";
import { geojsonLayer } from "./helpers/layer-fixtures";
import type {
  WhiteboxToolboxControllerOptions,
  WhiteboxToolboxServices,
} from "../apps/geolibre-desktop/src/hooks/useWhiteboxToolboxController";

const { useWhiteboxToolboxController } =
  await import("../apps/geolibre-desktop/src/hooks/useWhiteboxToolboxController");
const { ProcessingDialog } =
  await import("../apps/geolibre-desktop/src/components/processing/ProcessingDialog");
const { DOWNLOAD_GLOBAL_DEM_TOOL_ID } = await import("../apps/geolibre-desktop/src/lib/global-dem");

const CENTROID: WhiteboxTool = {
  id: "centroid_vector",
  display_name: "Centroid Vector",
  category: "Vector",
  summary: "Computes centroids.",
  params: [
    { name: "input", kind: "vector_in", required: true },
    { name: "output", kind: "vector_out" },
  ],
};
const SLOPE: WhiteboxTool = {
  id: "slope",
  display_name: "Slope",
  category: "Terrain",
  params: [
    { name: "dem", kind: "raster_in", required: true },
    { name: "zfactor", kind: "double", default: 1 },
  ],
};
const LOCKED: WhiteboxTool = { id: "pro_tool", display_name: "Pro Tool", locked: true };
const RASTER_TOOL: WhiteboxTool = {
  id: "raster_tool",
  display_name: "Raster Tool",
  category: "Terrain",
  params: [],
};
const LIDAR_TOOL: WhiteboxTool = {
  id: "lidar_tool",
  display_name: "LiDAR Tool",
  category: "LiDAR",
  params: [{ name: "output", kind: "lidar_out" }],
};
const TIFF_BYTES = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 1, 2, 3]);
const LAS_BYTES = new Uint8Array([0x4c, 0x41, 0x53, 0x46, 1, 2, 3]);
const GEOLIBRE_TOOL: WhiteboxTool = {
  id: "write_geoparquet",
  display_name: "Write GeoParquet",
  category: "Conversion",
  source: "geolibre",
};

const POINTS: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { name: "a" },
      geometry: { type: "Point", coordinates: [-83.92, 35.95] },
    },
  ],
};

function job(overrides: Partial<WhiteboxJob> = {}): WhiteboxJob {
  return {
    id: "job-1",
    status: "succeeded",
    tool_id: CENTROID.id,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    messages: [],
    outputs: {},
    result: null,
    error: null,
    ...overrides,
  };
}

interface Calls {
  wasmRuns: unknown[];
  sidecarRuns: unknown[];
  polls: string[];
  downloads: string[];
  demRequests: unknown[];
}

/**
 * Stand-in catalog, runtime and download services. Each test gets a fresh
 * object, created once, so the controller sees a stable reference.
 */
function services(overrides: Partial<WhiteboxToolboxServices> = {}) {
  const calls: Calls = { wasmRuns: [], sidecarRuns: [], polls: [], downloads: [], demRequests: [] };
  const value: WhiteboxToolboxServices = {
    clearRemoteWhiteboxCatalogSnapshotCache: () => {},
    fetchRemoteWhiteboxCatalogSnapshot: async () => [CENTROID, SLOPE, LOCKED],
    listWasmToolManifests: async () => [GEOLIBRE_TOOL],
    fetchWhiteboxStatus: async () => ({ available: true, message: "Sidecar ready" }),
    fetchWhiteboxTools: async () => [CENTROID, SLOPE],
    fetchWhiteboxJob: async (id) => {
      calls.polls.push(id);
      return job({ id });
    },
    fetchWhiteboxJsonOutput: async () => POINTS,
    runWhiteboxTool: async (request) => {
      calls.sidecarRuns.push(request);
      return job({ id: "sidecar-job", status: "running", tool_id: request.tool_id });
    },
    runWhiteboxToolWasm: async (request) => {
      calls.wasmRuns.push(request);
      return job({ id: "wasm-job", tool_id: request.tool_id, outputs: { output: POINTS } });
    },
    cancelWhiteboxJob: async (id) => job({ id, status: "cancelled" }),
    startGeoLibreSidecar: async () =>
      ({}) as Awaited<ReturnType<WhiteboxToolboxServices["startGeoLibreSidecar"]>>,
    stopGeoLibreSidecar: async () => {},
    downloadGlobalDem: async (request) => {
      calls.demRequests.push(request);
      return new Uint8Array([0x49, 0x49, 0x2a, 0x00, 1, 2, 3]);
    },
    fetchLayerBytes: async () => new Uint8Array([1, 2, 3]),
    downloadBytes: (_bytes, name) => {
      calls.downloads.push(name);
    },
    ...overrides,
  };
  return { value, calls };
}

function mapRef(bbox?: [number, number, number, number]) {
  const fitted: string[] = [];
  const engine = {
    readView: () => ({ zoom: 10, bbox }),
    fitLayer: (layer: { id: string }) => {
      fitted.push(layer.id);
    },
    getMap: () => null,
  } as unknown as MapEngine;
  return { ref: { current: engine }, fitted };
}

function controller(
  stub = services(),
  extra: {
    mapControllerRef?: { current: MapEngine | null };
    onAddRaster?: WhiteboxToolboxControllerOptions["onAddRaster"];
    onAddLidar?: WhiteboxToolboxControllerOptions["onAddLidar"];
  } = {},
) {
  const hook = renderHook(() =>
    useWhiteboxToolboxController({
      mapControllerRef: extra.mapControllerRef ?? { current: null },
      onAddRaster: extra.onAddRaster,
      onAddLidar: extra.onAddLidar,
      services: stub.value,
    }),
  );
  return { ...hook, calls: stub.calls };
}

async function loaded(hook: ReturnType<typeof controller>) {
  await waitFor(() => {
    assert.equal(hook.result.current.loadingTools, false);
    assert.ok(hook.result.current.tools.length > 0);
  });
}

beforeEach(() => {
  useAppStore.getState().newProject();
  act(() => useAppStore.getState().setProcessingOpen(true));
});

afterEach(() => {
  cleanup();
  act(() => useAppStore.getState().setProcessingOpen(false));
});

it("loads the local catalog with WASM tools and the global DEM tool, hiding locked tools", async () => {
  const hook = controller();
  await loaded(hook);
  const model = hook.result.current;
  assert.equal(model.runLocal, true, "the web build runs tools in WASM by default");
  assert.deepEqual(
    model.tools.map((tool) => tool.id),
    [CENTROID.id, SLOPE.id, GEOLIBRE_TOOL.id, DOWNLOAD_GLOBAL_DEM_TOOL_ID],
  );
  assert.equal(model.selectedToolId, CENTROID.id);
  assert.equal(model.runtimeAvailable, false);
  assert.equal(model.hasGeolibreTools, true);
  assert.equal(model.error, null);

  act(() => hook.result.current.setSource("geolibre"));
  assert.deepEqual(
    hook.result.current.filteredTools.map((tool) => tool.id),
    [GEOLIBRE_TOOL.id, DOWNLOAD_GLOBAL_DEM_TOOL_ID],
  );
  act(() => {
    hook.result.current.setSource("All");
    hook.result.current.setQuery("slope");
  });
  assert.deepEqual(
    hook.result.current.filteredTools.map((tool) => tool.id),
    [SLOPE.id],
  );
});

it("reports a failed catalog snapshot in local mode but keeps the WASM tools", async () => {
  const stub = services({
    fetchRemoteWhiteboxCatalogSnapshot: async () => {
      throw new Error("offline");
    },
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const hook = controller(stub);
    await loaded(hook);
    assert.deepEqual(
      hook.result.current.tools.map((tool) => tool.id),
      [GEOLIBRE_TOOL.id, DOWNLOAD_GLOBAL_DEM_TOOL_ID],
    );
    assert.ok(hook.result.current.error, "the catalog failure is surfaced");
  } finally {
    console.warn = warn;
  }
});

it("falls back to the catalog snapshot when the sidecar is unavailable", async () => {
  const stub = services({
    fetchWhiteboxStatus: async () => ({ available: false, message: "Sidecar is not running." }),
  });
  const hook = controller(stub);
  await loaded(hook);
  act(() => hook.result.current.handleRunLocalChange(false));
  await waitFor(() => {
    assert.equal(hook.result.current.loadingTools, false);
    assert.match(hook.result.current.runtimeMessage, /^Sidecar is not running\. /);
  });
  const model = hook.result.current;
  assert.equal(model.runtimeAvailable, false);
  assert.deepEqual(
    model.tools.map((tool) => tool.id),
    [CENTROID.id, SLOPE.id, DOWNLOAD_GLOBAL_DEM_TOOL_ID],
  );
  assert.equal(model.selectedToolId, CENTROID.id, "the selection survives the reload");
});

it("selects a tool queued from the Processing menu once the catalog loads", async () => {
  act(() => useAppStore.getState().setProcessingInitialTool(GEOLIBRE_TOOL.id));
  const hook = controller();
  await waitFor(() => assert.equal(hook.result.current.selectedToolId, GEOLIBRE_TOOL.id));
  assert.equal(useAppStore.getState().ui.processingInitialTool, null);
});

it("restores a History re-run onto the tool defaults and rejects an unknown tool", async () => {
  const hook = controller();
  await loaded(hook);
  act(() =>
    useAppStore.getState().setProcessingRerun({
      kind: "whitebox",
      toolId: SLOPE.id,
      parameters: { dem: "/data/dem.tif" },
    } as Parameters<ReturnType<typeof useAppStore.getState>["setProcessingRerun"]>[0]),
  );
  await waitFor(() => assert.equal(hook.result.current.selectedToolId, SLOPE.id));
  await waitFor(() => assert.equal(hook.result.current.values.dem, "/data/dem.tif"));
  assert.equal(hook.result.current.values.zfactor, 1);
  assert.equal(hook.result.current.historyRestoreRevision, 1);
  assert.equal(useAppStore.getState().ui.processingRerun, null);

  act(() =>
    useAppStore.getState().setProcessingRerun({
      kind: "whitebox",
      toolId: "renamed_tool",
      parameters: {},
    } as Parameters<ReturnType<typeof useAppStore.getState>["setProcessingRerun"]>[0]),
  );
  await waitFor(() => assert.match(hook.result.current.error ?? "", /renamed_tool/));
  assert.equal(useAppStore.getState().ui.processingRerun, null);
});

it("runs a WASM tool, imports its GeoJSON output and records History", async () => {
  useAppStore.getState().addLayer(geojsonLayer({ id: "pts", name: "Points", geojson: POINTS }));
  const map = mapRef();
  const hook = controller(services(), { mapControllerRef: map.ref });
  await loaded(hook);

  await act(() => hook.result.current.runSelectedTool());
  assert.match(
    hook.result.current.error ?? "",
    /^Missing required parameter: /,
    "a missing required input is rejected",
  );
  assert.equal(hook.result.current.running, false);

  act(() => hook.result.current.updateValue("input", "layer:pts"));
  await act(() => hook.result.current.runSelectedTool());
  await waitFor(() =>
    assert.ok(
      useAppStore.getState().layers.some((layer) => layer.name === "Centroid Vector Output"),
    ),
  );
  assert.equal(hook.calls.wasmRuns.length, 1);
  const request = hook.calls.wasmRuns[0] as { layer_inputs: Record<string, { geojson: unknown }> };
  assert.equal(request.layer_inputs.input.geojson, POINTS);
  assert.equal(hook.result.current.job?.status, "succeeded");
  assert.equal(hook.result.current.running, false);
  await waitFor(() => {
    const [run] = useAppStore.getState().processingHistory;
    assert.equal(run?.status, "success");
    assert.deepEqual(run?.outputLayerNames, ["Centroid Vector Output"]);
  });
});

it("drops a finished job's outputs after a different project loads", async () => {
  const pending: { release?: (value: WhiteboxJob) => void } = {};
  const stub = services({
    runWhiteboxToolWasm: () =>
      new Promise<WhiteboxJob>((resolve) => {
        pending.release = resolve;
      }),
  });
  useAppStore.getState().addLayer(geojsonLayer({ id: "pts", name: "Points", geojson: POINTS }));
  const hook = controller(stub);
  await loaded(hook);
  act(() => hook.result.current.updateValue("input", "layer:pts"));
  let run: Promise<void> = Promise.resolve();
  act(() => {
    run = hook.result.current.runSelectedTool();
  });
  await waitFor(() => assert.ok(pending.release, "the WASM stub has started"));
  assert.equal(hook.result.current.running, true);
  act(() => useAppStore.getState().newProject());
  await act(async () => {
    pending.release?.(job({ id: "late", outputs: { output: POINTS } }));
    await run;
  });
  assert.equal(hook.result.current.job?.id, "late");
  assert.equal(useAppStore.getState().layers.length, 0, "nothing lands in the new project");
  act(() => hook.result.current.updateValue("input", ""));
  await act(() => hook.result.current.runSelectedTool());
  assert.match(hook.result.current.error ?? "", /Missing required parameter/);
  await act(() => hook.result.current.loadWhitebox());
  assert.equal(hook.result.current.job?.id, "late");
  assert.equal(
    useAppStore.getState().layers.length,
    0,
    "failed Run and catalog refresh cannot reimport the old job",
  );
});

it("keeps a Global DEM download assigned to the project that dispatched it", async () => {
  const pending: { release?: (value: Uint8Array) => void } = {};
  const rasters: string[] = [];
  const stub = services({
    downloadGlobalDem: () =>
      new Promise((resolve) => {
        pending.release = resolve;
      }),
  });
  const hook = controller(stub, {
    mapControllerRef: mapRef([-84, 35.5, -83.5, 36]).ref,
    onAddRaster: (_bytes, name) => {
      rasters.push(name);
    },
  });
  await loaded(hook);
  act(() => hook.result.current.setSelectedToolId(DOWNLOAD_GLOBAL_DEM_TOOL_ID));
  await waitFor(() =>
    assert.equal(hook.result.current.selectedToolId, DOWNLOAD_GLOBAL_DEM_TOOL_ID),
  );
  act(() => hook.result.current.handleUseMapExtent());
  let run = Promise.resolve();
  act(() => {
    run = hook.result.current.runSelectedTool();
  });
  await waitFor(() => assert.ok(pending.release));
  act(() => useAppStore.getState().newProject());
  await act(async () => {
    pending.release?.(new Uint8Array([0x49, 0x49, 0x2a, 0x00, 1]));
    await run;
  });
  assert.deepEqual(rasters, []);
  assert.equal(useAppStore.getState().layers.length, 0);
});

it("clears Run's busy state and allows retry when input preparation rejects", async () => {
  let fail = true;
  const stub = services({
    fetchLayerBytes: async () => {
      if (fail) throw new Error("Input bytes unavailable");
      return new Uint8Array([1, 2, 3]);
    },
  });
  useAppStore.getState().addLayer(geojsonLayer({ id: "dem", name: "DEM", geojson: undefined }));
  const hook = controller(stub);
  await loaded(hook);
  act(() => hook.result.current.setSelectedToolId(SLOPE.id));
  await waitFor(() => assert.equal(hook.result.current.selectedToolId, SLOPE.id));
  act(() => hook.result.current.updateValue("dem", "layer:dem"));
  await act(() => hook.result.current.runSelectedTool());
  assert.equal(hook.result.current.error, "Input bytes unavailable");
  assert.equal(hook.result.current.running, false);
  assert.equal(stub.calls.wasmRuns.length, 0);
  fail = false;
  await act(() => hook.result.current.runSelectedTool());
  assert.equal(hook.result.current.error, null);
  assert.equal(hook.result.current.running, false);
  assert.equal(stub.calls.wasmRuns.length, 1);
});

it("polls a sidecar job until it finishes and imports its output path", async () => {
  const stub = services();
  const hook = controller(stub);
  await loaded(hook);
  act(() => hook.result.current.setRunLocal(false));
  await waitFor(() => assert.equal(hook.result.current.runtimeAvailable, true));
  act(() => hook.result.current.setSelectedToolId(SLOPE.id));
  await waitFor(() => assert.equal(hook.result.current.selectedToolId, SLOPE.id));
  act(() => hook.result.current.updateValue("dem", "/data/dem.tif"));
  stub.value.fetchWhiteboxJob = async (id) => {
    hook.calls.polls.push(id);
    return job({ id, tool_id: SLOPE.id, outputs: { output: { path: "/out/slope.geojson" } } });
  };
  await act(() => hook.result.current.runSelectedTool());
  assert.equal(hook.result.current.job?.status, "running");
  assert.equal(hook.result.current.sidecarJobRunning, true);
  await waitFor(() => assert.equal(hook.result.current.job?.status, "succeeded"), {
    timeout: 3000,
  });
  assert.deepEqual(hook.calls.polls, ["sidecar-job"]);
  await waitFor(() =>
    assert.ok(useAppStore.getState().layers.some((layer) => layer.name === "Slope Output")),
  );
});

it("fills the global DEM extent from the map view and downloads the DEM", async () => {
  const map = mapRef([-84, 35.5, -83.5, 36]);
  const rasters: string[] = [];
  const hook = controller(services(), {
    mapControllerRef: map.ref,
    onAddRaster: (_bytes, name) => {
      rasters.push(name);
    },
  });
  await loaded(hook);
  act(() => hook.result.current.setSelectedToolId(DOWNLOAD_GLOBAL_DEM_TOOL_ID));
  await waitFor(() =>
    assert.equal(hook.result.current.selectedToolId, DOWNLOAD_GLOBAL_DEM_TOOL_ID),
  );
  act(() => hook.result.current.handleUseMapExtent());
  assert.equal(hook.result.current.values.bbox, "-84,35.5,-83.5,36");
  assert.equal(hook.result.current.values.bbox_crs, "4326");

  await act(() => hook.result.current.runSelectedTool());
  assert.deepEqual(hook.calls.demRequests[0], {
    bbox: "-84,35.5,-83.5,36",
    bboxCrs: 4326,
    signal: (hook.calls.demRequests[0] as { signal: AbortSignal }).signal,
  });
  await waitFor(() => assert.deepEqual(rasters, ["Download Global DEM Output"]));
});

it("reports an invalid map extent instead of writing it", async () => {
  const map = mapRef([170, 10, -170, 20]);
  const hook = controller(services(), { mapControllerRef: map.ref });
  await loaded(hook);
  act(() => hook.result.current.setSelectedToolId(DOWNLOAD_GLOBAL_DEM_TOOL_ID));
  await waitFor(() =>
    assert.equal(hook.result.current.selectedToolId, DOWNLOAD_GLOBAL_DEM_TOOL_ID),
  );
  act(() => hook.result.current.handleUseMapExtent());
  assert.ok(hook.result.current.error);
  assert.notEqual(hook.result.current.values.bbox, "170,10,-170,20");
});

it("renders the dialog from the controller and runs the selected tool", async () => {
  useAppStore.getState().addLayer(geojsonLayer({ id: "pts", name: "Points", geojson: POINTS }));
  const stub = services();
  const map = mapRef();
  render(createElement(ProcessingDialog, { mapControllerRef: map.ref, services: stub.value }));
  await screen.findByRole("heading", { name: "Centroid Vector" });
  assert.ok(screen.getByRole("button", { name: /Write GeoParquet/ }));

  fireEvent.change(screen.getByPlaceholderText(/Search/), { target: { value: "slope" } });
  assert.equal(screen.queryByRole("button", { name: /Write GeoParquet/ }) === null, true);
  fireEvent.click(screen.getByRole("button", { name: /^Slope/ }));
  await screen.findByRole("heading", { name: "Slope" });

  fireEvent.change(screen.getByPlaceholderText(/Search/), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: /^Centroid Vector/ }));
  await screen.findByRole("heading", { name: "Centroid Vector" });
  const runButton = screen.getByRole("button", { name: "Run" });
  fireEvent.click(runButton);
  await waitFor(() => assert.equal(stub.calls.wasmRuns.length, 0));
  await screen.findByText(/^Missing required parameter: /);

  const layerSelect = screen
    .getAllByRole("combobox")
    .find((select) => [...(select as HTMLSelectElement).options].some((o) => o.text === "Points"));
  assert.ok(layerSelect, "the vector input offers the project's GeoJSON layer");
  fireEvent.change(layerSelect, { target: { value: "layer:pts" } });
  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  await waitFor(() => assert.equal(stub.calls.wasmRuns.length, 1));
  await waitFor(() =>
    assert.ok(
      useAppStore.getState().layers.some((layer) => layer.name === "Centroid Vector Output"),
    ),
  );
  assert.equal(screen.queryByText(/^Missing required parameter: /) === null, true);

  act(() => useAppStore.getState().setProcessingOpen(false));
  assert.equal(document.querySelector("[data-processing-dialog]") === null, true);
});

/** A promise whose settlement the test controls. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

it("ignores a catalog load that a newer load superseded", async () => {
  const wasm = deferred<WhiteboxTool[]>();
  const stub = services({ listWasmToolManifests: () => wasm.promise });
  const hook = controller(stub);
  await waitFor(() => assert.equal(hook.result.current.loadingTools, true));
  // Switch to the sidecar while the WASM manifests are still enumerating.
  act(() => hook.result.current.handleRunLocalChange(false));
  await waitFor(() => assert.equal(hook.result.current.runtimeAvailable, true));
  assert.equal(hook.result.current.loadingTools, false);
  await act(async () => {
    wasm.resolve([GEOLIBRE_TOOL]);
    await wasm.promise;
  });
  const model = hook.result.current;
  assert.deepEqual(
    model.tools.map((tool) => tool.id),
    [CENTROID.id, SLOPE.id, DOWNLOAD_GLOBAL_DEM_TOOL_ID],
    "the late WASM catalog does not replace the sidecar catalog",
  );
  assert.equal(model.runtimeAvailable, true);
  assert.equal(model.runtimeMessage, "Sidecar ready");
  assert.equal(model.loadingTools, false);
});

it("ignores a stale sidecar probe that resolves after a newer WASM load", async () => {
  const status = deferred<{ available: boolean; message: string }>();
  const stub = services({ fetchWhiteboxStatus: () => status.promise });
  const hook = controller(stub);
  await loaded(hook);
  act(() => hook.result.current.handleRunLocalChange(false));
  await waitFor(() => assert.equal(hook.result.current.loadingTools, true));
  // Back to WASM: that load finishes, then the stale sidecar probe resolves.
  act(() => hook.result.current.handleRunLocalChange(true));
  await waitFor(() => assert.equal(hook.result.current.loadingTools, false));
  await act(async () => {
    status.resolve({ available: true, message: "Sidecar ready" });
    await status.promise;
  });
  assert.equal(hook.result.current.runtimeAvailable, false);
  assert.ok(hook.result.current.tools.some((tool) => tool.id === GEOLIBRE_TOOL.id));
});

it("clears the spinner and reports the error when the local catalog merge throws", async () => {
  const broken = {
    get id(): string {
      throw new Error("Malformed WASM manifest");
    },
  } as unknown as WhiteboxTool;
  const stub = services({ listWasmToolManifests: async () => [broken] });
  const hook = controller(stub);
  await waitFor(() => assert.equal(hook.result.current.error, "Malformed WASM manifest"));
  assert.equal(hook.result.current.loadingTools, false);
  assert.equal(hook.result.current.serverBusy, false, "Refresh is enabled again");
});

it("reloads the catalog snapshot with a translated message when the server stops", async () => {
  let stopped = 0;
  const stub = services({
    fetchWhiteboxTools: async () => [SLOPE],
    stopGeoLibreSidecar: async () => {
      stopped += 1;
    },
  });
  const hook = controller(stub);
  await loaded(hook);
  act(() => hook.result.current.handleRunLocalChange(false));
  await waitFor(() =>
    assert.deepEqual(
      hook.result.current.tools.map((tool) => tool.id),
      [SLOPE.id, DOWNLOAD_GLOBAL_DEM_TOOL_ID],
    ),
  );
  await act(() => hook.result.current.stopServer());
  assert.equal(stopped, 1);
  const model = hook.result.current;
  assert.equal(model.runtimeAvailable, false);
  assert.equal(model.runtimeMessage, "GeoLibre sidecar is stopped. Showing GitHub catalog only.");
  assert.deepEqual(
    model.tools.map((tool) => tool.id),
    [CENTROID.id, SLOPE.id, DOWNLOAD_GLOBAL_DEM_TOOL_ID],
    "the snapshot replaces the stopped server's live catalog",
  );
  assert.equal(model.loadingTools, false);
});

it("translates the locked-tool fallback instead of hardcoding it", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL(
      "../apps/geolibre-desktop/src/components/processing/ProcessingDialog.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  assert.equal(source.includes('"This tool is locked."'), false);
  assert.match(source, /locked_reason \|\| t\("processing\.whitebox\.lockedFallback"\)/);
  const en = JSON.parse(
    await readFile(
      new URL("../apps/geolibre-desktop/src/i18n/locales/en.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(en.processing.whitebox.lockedFallback, "This tool is locked.");
});

it("keeps tracking a running sidecar job after switching tools, then imports it", async () => {
  const stub = services();
  const hook = controller(stub);
  await loaded(hook);
  act(() => hook.result.current.handleRunLocalChange(false));
  await waitFor(() => assert.equal(hook.result.current.runtimeAvailable, true));
  act(() => hook.result.current.setSelectedToolId(SLOPE.id));
  await waitFor(() => assert.equal(hook.result.current.selectedToolId, SLOPE.id));
  act(() => hook.result.current.updateValue("dem", "/data/dem.tif"));
  stub.value.fetchWhiteboxJob = async (id) => {
    stub.calls.polls.push(id);
    return job({ id, tool_id: SLOPE.id, outputs: { output: { path: "/out/slope.geojson" } } });
  };
  await act(() => hook.result.current.runSelectedTool());
  assert.equal(hook.result.current.job?.status, "running");

  act(() => hook.result.current.setSelectedToolId(CENTROID.id));
  await waitFor(() => assert.equal(hook.result.current.selectedToolId, CENTROID.id));
  assert.equal(hook.result.current.job, null, "the new tool starts with a clean form");

  await waitFor(
    () => {
      const [run] = useAppStore.getState().processingHistory;
      assert.equal(run?.status, "success");
      assert.deepEqual(run?.outputLayerNames, ["Slope Output"]);
    },
    { timeout: 3000 },
  );
  assert.deepEqual(stub.calls.polls, ["sidecar-job"]);
  assert.ok(useAppStore.getState().layers.some((layer) => layer.name === "Slope Output"));
  assert.equal(hook.result.current.job, null, "the detached job is not shown on the new tool");
});

it("records a background sidecar job that fails after a tool switch", async () => {
  const stub = services();
  const hook = controller(stub);
  await loaded(hook);
  act(() => hook.result.current.handleRunLocalChange(false));
  await waitFor(() => assert.equal(hook.result.current.runtimeAvailable, true));
  act(() => hook.result.current.setSelectedToolId(SLOPE.id));
  await waitFor(() => assert.equal(hook.result.current.selectedToolId, SLOPE.id));
  act(() => hook.result.current.updateValue("dem", "/data/dem.tif"));
  stub.value.fetchWhiteboxJob = async (id) =>
    job({ id, tool_id: SLOPE.id, status: "failed", error: "DEM unreadable" });
  await act(() => hook.result.current.runSelectedTool());
  act(() => hook.result.current.setSelectedToolId(CENTROID.id));
  await waitFor(
    () => {
      const [run] = useAppStore.getState().processingHistory;
      assert.equal(run?.status, "error");
      assert.equal(run?.error, "DEM unreadable");
    },
    { timeout: 3000 },
  );
});

/**
 * Run `tool` in WASM mode, returning `bytes` as its output, with the output
 * callback held open until the test releases it.
 */
async function startDelayedBinaryImport(kind: "raster" | "lidar") {
  const tool = kind === "raster" ? RASTER_TOOL : LIDAR_TOOL;
  const bytes = kind === "raster" ? TIFF_BYTES : LAS_BYTES;
  const gate = deferred<void>();
  const seen: { signal?: AbortSignal } = {};
  const added: string[] = [];
  const stub = services({
    fetchRemoteWhiteboxCatalogSnapshot: async () => [CENTROID, RASTER_TOOL, LIDAR_TOOL],
    listWasmToolManifests: async () => [],
    runWhiteboxToolWasm: async (request) =>
      job({ id: `${kind}-job`, tool_id: request.tool_id, outputs: { output: bytes } }),
  });
  // Both stand-ins wait on the gate, then add their layer only while the
  // signal is live, as addRasterToMap and the shell's LiDAR loader do.
  const hook = controller(stub, {
    onAddRaster: async (_bytes, name, _fileName, { signal }) => {
      seen.signal = signal;
      await gate.promise;
      signal.throwIfAborted();
      added.push(name);
    },
    onAddLidar: async (_bytes, name, _fileName, { signal }) => {
      seen.signal = signal;
      await gate.promise;
      // A loader that ignores the abort and reports success anyway: the
      // controller must still not credit it to the replacement project.
      if (!signal.aborted) added.push(name);
      return true;
    },
  });
  await loaded(hook);
  act(() => hook.result.current.setSelectedToolId(tool.id));
  await waitFor(() => assert.equal(hook.result.current.selectedToolId, tool.id));
  await act(() => hook.result.current.runSelectedTool());
  await waitFor(() => assert.ok(seen.signal, "the output callback has started"));
  return { hook, stub, gate, seen, added, outputName: `${tool.display_name} Output` };
}

for (const kind of ["raster", "lidar"] as const) {
  it(`drops a delayed ${kind} import after another project opens`, async () => {
    const run = await startDelayedBinaryImport(kind);
    assert.equal(run.seen.signal?.aborted, false);
    act(() => useAppStore.getState().newProject());
    assert.equal(run.seen.signal?.aborted, true, "the project change aborts the import");
    await act(async () => {
      run.gate.resolve();
      await run.gate.promise;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(run.added, []);
    assert.equal(run.hook.result.current.error, null, "a superseded import is not an error");
    assert.deepEqual(run.stub.calls.downloads, [], "nor is the output downloaded instead");
    assert.ok(
      useAppStore
        .getState()
        .processingHistory.every((entry) => !entry.outputLayerNames?.includes(run.outputName)),
      "the replacement project's History is not credited with the output",
    );
  });

  it(`records a delayed ${kind} import that stays in its project`, async () => {
    const run = await startDelayedBinaryImport(kind);
    await act(async () => {
      run.gate.resolve();
      await run.gate.promise;
    });
    await waitFor(() => {
      const [entry] = useAppStore.getState().processingHistory;
      assert.deepEqual(entry?.outputLayerNames, [run.outputName]);
    });
    assert.deepEqual(run.added, [run.outputName]);
    assert.equal(run.seen.signal?.aborted, false);
    assert.equal(run.hook.result.current.error, null);
  });
}

it("leaves the WASM catalog alone when a server stop resolves after a switch to WASM", async () => {
  const stop = deferred<void>();
  const stub = services({ stopGeoLibreSidecar: () => stop.promise });
  const hook = controller(stub);
  await loaded(hook);
  act(() => hook.result.current.handleRunLocalChange(false));
  await waitFor(() => assert.equal(hook.result.current.runtimeAvailable, true));
  let stopping: Promise<void> = Promise.resolve();
  act(() => {
    stopping = hook.result.current.stopServer();
  });
  act(() => hook.result.current.handleRunLocalChange(true));
  await waitFor(() =>
    assert.ok(hook.result.current.tools.some((tool) => tool.id === GEOLIBRE_TOOL.id)),
  );
  await act(async () => {
    stop.resolve();
    await stopping;
  });
  const model = hook.result.current;
  assert.equal(model.runtimeMessage, "Running locally with WebAssembly. No sidecar required.");
  assert.ok(model.tools.some((tool) => tool.id === GEOLIBRE_TOOL.id));
  assert.equal(model.loadingTools, false);
});

it("names the detached job's tool when its background import fails", async () => {
  const stub = services({
    fetchWhiteboxJsonOutput: async () => {
      throw new Error("Output unreadable");
    },
  });
  const hook = controller(stub);
  await loaded(hook);
  act(() => hook.result.current.handleRunLocalChange(false));
  await waitFor(() => assert.equal(hook.result.current.runtimeAvailable, true));
  act(() => hook.result.current.setSelectedToolId(SLOPE.id));
  await waitFor(() => assert.equal(hook.result.current.selectedToolId, SLOPE.id));
  act(() => hook.result.current.updateValue("dem", "/data/dem.tif"));
  stub.value.fetchWhiteboxJob = async (id) =>
    job({ id, tool_id: SLOPE.id, outputs: { output: { path: "/out/slope.geojson" } } });
  await act(() => hook.result.current.runSelectedTool());
  act(() => hook.result.current.setSelectedToolId(CENTROID.id));
  await waitFor(
    () =>
      assert.equal(
        hook.result.current.error,
        "Could not import the output of Slope: Output unreadable",
      ),
    { timeout: 3000 },
  );
});
