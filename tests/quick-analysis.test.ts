import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import {
  bufferPresetsFor,
  clearQuickAnalysisStatus,
  clickedPointLayer,
  formatBufferDistance,
  getQuickAnalysisStatus,
  QUICK_BUFFER_PRESETS,
  resolveQuickTool,
  runQuickAnalysis,
} from "../apps/geolibre-desktop/src/lib/quick-analysis";

/** A map-controller ref stub; quick analysis only calls fitLayer/getMap on it. */
function controllerRef(): { current: { fitLayer: () => void; getMap: () => null } } {
  return { current: { fitLayer: () => {}, getMap: () => null } };
}

function pointsLayer(id: string, coords: [number, number][]): GeoLibreLayer {
  return {
    id,
    name: id,
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    geojson: {
      type: "FeatureCollection",
      features: coords.map((coordinates) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates },
        properties: {},
      })),
    },
  };
}

beforeEach(() => {
  useAppStore.setState({ layers: [], processingHistory: [] });
  clearQuickAnalysisStatus();
});

describe("bufferPresetsFor", () => {
  it("offers metric distances for a metric scale bar", () => {
    assert.deepEqual(bufferPresetsFor("metric"), QUICK_BUFFER_PRESETS.metric);
    assert.equal(bufferPresetsFor("metric")[0].units, "meters");
  });

  it("offers miles for an imperial scale bar", () => {
    assert.ok(bufferPresetsFor("imperial").every((preset) => preset.units === "miles"));
  });

  it("falls back to the metric ladder for the nautical scale bar", () => {
    // The buffer tool declares meters/kilometers/miles only, and a preset has
    // to stay inside that set for "Open in Processing…" to reproduce the run.
    assert.deepEqual(bufferPresetsFor("nautical"), QUICK_BUFFER_PRESETS.metric);
  });

  it("only offers units the buffer tool declares", () => {
    const declared = new Set(["meters", "kilometers", "miles"]);
    for (const presets of Object.values(QUICK_BUFFER_PRESETS)) {
      for (const preset of presets) assert.ok(declared.has(preset.units), preset.units);
    }
  });
});

describe("clickedPointLayer", () => {
  it("wraps a coordinate as a one-feature, hidden layer", () => {
    const layer = clickedPointLayer(-95.7, 37.1);
    assert.equal(layer.geojson?.features.length, 1);
    assert.deepEqual(layer.geojson?.features[0].geometry, {
      type: "Point",
      coordinates: [-95.7, 37.1],
    });
    // Never rendered: it exists only so a point-input tool can resolve it by id.
    assert.equal(layer.visible, false);
  });
});

describe("resolveQuickTool", () => {
  it("resolves tools from the vector registry", () => {
    assert.equal(resolveQuickTool("buffer")?.id, "buffer");
    assert.equal(resolveQuickTool("centroids")?.id, "centroids");
  });

  it("resolves tools from the network registry", () => {
    assert.equal(resolveQuickTool("isochrone")?.id, "isochrone");
  });

  it("returns undefined for an unknown id", () => {
    assert.equal(resolveQuickTool("not-a-tool"), undefined);
  });
});

describe("runQuickAnalysis", () => {
  it("buffers the clicked point and adds the result as a layer", async () => {
    const point = clickedPointLayer(0, 0);
    const layerId = await runQuickAnalysis({
      toolId: "buffer",
      parameters: { layer: point.id, distance: 1, units: "kilometers" },
      extraLayers: [point],
      resultName: "Buffer 1 km",
      mapControllerRef: controllerRef() as never,
    });

    assert.ok(layerId);
    const layers = useAppStore.getState().layers;
    assert.equal(layers.length, 1);
    assert.equal(layers[0].name, "Buffer 1 km");
    assert.equal(layers[0].geojson?.features[0].geometry.type, "Polygon");
    assert.deepEqual(getQuickAnalysisStatus(), { phase: "idle" });
  });

  it("runs a whole-layer tool against a project layer", async () => {
    const input = pointsLayer("pts", [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]);
    useAppStore.setState({ layers: [input] });

    const layerId = await runQuickAnalysis({
      toolId: "convex-hull",
      parameters: { layer: "pts" },
      resultName: "pts convex hull",
      mapControllerRef: controllerRef() as never,
    });

    assert.ok(layerId);
    const added = useAppStore.getState().layers.find((item) => item.id === layerId);
    assert.equal(added?.geojson?.features[0].geometry.type, "Polygon");
  });

  it("records the run in the Processing History", async () => {
    const point = clickedPointLayer(0, 0);
    await runQuickAnalysis({
      toolId: "buffer",
      parameters: { layer: point.id, distance: 1, units: "kilometers" },
      extraLayers: [point],
      resultName: "Buffer 1 km",
      mapControllerRef: controllerRef() as never,
    });

    const history = useAppStore.getState().processingHistory;
    assert.equal(history.length, 1);
    assert.equal(history[0].toolId, "buffer");
    assert.equal(history[0].status, "success");
    assert.deepEqual(history[0].outputLayerNames, ["Buffer 1 km"]);
  });

  it("reports an unknown tool without touching the map", async () => {
    const layerId = await runQuickAnalysis({
      toolId: "not-a-tool",
      parameters: {},
      resultName: "nope",
      mapControllerRef: controllerRef() as never,
    });

    assert.equal(layerId, null);
    assert.equal(useAppStore.getState().layers.length, 0);
    assert.equal(getQuickAnalysisStatus().phase, "error");
  });

  it("surfaces a tool's soft failure as an error and records it as failed", async () => {
    // The client tools log "Error: ..." instead of throwing; an empty input
    // layer takes that path rather than silently adding nothing.
    useAppStore.setState({ layers: [pointsLayer("empty", [])] });

    const layerId = await runQuickAnalysis({
      toolId: "buffer",
      parameters: { layer: "empty", distance: 1, units: "kilometers" },
      resultName: "Buffer 1 km",
      mapControllerRef: controllerRef() as never,
    });

    assert.equal(layerId, null);
    // The input layer is still the only layer: no empty result was added.
    assert.equal(useAppStore.getState().layers.length, 1);
    assert.equal(getQuickAnalysisStatus().phase, "error");
    const history = useAppStore.getState().processingHistory;
    assert.equal(history.at(-1)?.status, "error");
  });

  it("clears a reported failure on demand", async () => {
    await runQuickAnalysis({
      toolId: "not-a-tool",
      parameters: {},
      resultName: "nope",
      mapControllerRef: controllerRef() as never,
    });
    assert.equal(getQuickAnalysisStatus().phase, "error");
    clearQuickAnalysisStatus();
    assert.deepEqual(getQuickAnalysisStatus(), { phase: "idle" });
  });
});

describe("formatBufferDistance", () => {
  const unit = (key: string) => key.split(".").at(-1)?.slice(0, 2) ?? "";

  it("localizes the number and appends the translated unit", () => {
    assert.equal(
      formatBufferDistance({ distance: 1000, units: "meters" }, "en", unit as never),
      "1,000 me",
    );
    assert.equal(
      formatBufferDistance({ distance: 1000, units: "meters" }, "de", unit as never),
      "1.000 me",
    );
  });

  it("renders a fractional imperial preset without rounding it away", () => {
    assert.equal(
      formatBufferDistance({ distance: 0.25, units: "miles" }, "en", unit as never),
      "0.25 mi",
    );
  });
});

describe("the quick-analysis banner under concurrent runs", () => {
  it("lets only the newest run write status", async () => {
    useAppStore.setState({ layers: [pointsLayer("empty", [])] });
    const point = clickedPointLayer(0, 0);

    // A failing run started first, then a successful one: the older run must not
    // repaint the banner after the newer one has finished.
    const failing = runQuickAnalysis({
      toolId: "buffer",
      parameters: { layer: "empty", distance: 1, units: "kilometers" },
      resultName: "never",
      mapControllerRef: controllerRef() as never,
    });
    const succeeding = runQuickAnalysis({
      toolId: "buffer",
      parameters: { layer: point.id, distance: 1, units: "kilometers" },
      extraLayers: [point],
      resultName: "Buffer 1 km",
      mapControllerRef: controllerRef() as never,
    });
    await Promise.all([failing, succeeding]);

    assert.deepEqual(getQuickAnalysisStatus(), { phase: "idle" });
    // The superseded run still leaves its durable record.
    const history = useAppStore.getState().processingHistory;
    assert.equal(history.filter((run) => run.status === "error").length, 1);
  });
});
