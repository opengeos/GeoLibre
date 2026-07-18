import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import { syncLayer } from "../packages/map/src/layer-sync";

// Records the maplibre calls a layer sync makes so a test can assert which
// native operations ran. Mirrors the stub in control-owns-paint.test.ts, plus
// the style/paint getters the vector-control symbology overlay reads.
interface MapCall {
  method: string;
  args: unknown[];
}

function makeVectorControlMapStub(
  options: { circleRadiusPaint?: unknown } = {},
) {
  const calls: MapCall[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
    };
  const circleSpec = {
    id: "vec1-circle",
    type: "circle",
    source: "vec1-source",
    filter: ["==", ["geometry-type"], "Point"],
  };
  const map = {
    getStyle: () => ({ layers: [circleSpec] }),
    getLayer: (id: string) =>
      id === "vec1-circle" ? { id, type: "circle" } : undefined,
    getSource: () => undefined,
    getFilter: () => circleSpec.filter,
    getPaintProperty: (_id: string, _prop: string) =>
      options.circleRadiusPaint,
    setLayoutProperty: record("setLayoutProperty"),
    setPaintProperty: record("setPaintProperty"),
    setFilter: record("setFilter"),
    setLayerZoomRange: record("setLayerZoomRange"),
    moveLayer: record("moveLayer"),
    removeLayer: record("removeLayer"),
    addLayer: record("addLayer"),
    addSource: record("addSource"),
  };
  return { map, calls };
}

function vectorControlLayer(patch: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id: "vec1",
    name: "us_cities",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      customLayerType: "circle",
      externalNativeLayer: true,
      controlOwnsPaint: true,
      sourceKind: "maplibre-gl-vector",
      nativeLayerIds: ["vec1-circle"],
      sourceIds: ["vec1-source"],
    },
    ...patch,
  };
}

const proportionalStyle = {
  proportionalSizeEnabled: true,
  proportionalSizeProperty: "pop_max",
  proportionalSizeMinValue: 20000,
  proportionalSizeMaxValue: 8000000,
  proportionalSizeMinRadius: 4,
  proportionalSizeMaxRadius: 24,
} as const;

describe("vector-control point symbology overlay (#1311)", () => {
  it("renders a GeoLibre marker symbol layer and hides the control's circle", () => {
    const { map, calls } = makeVectorControlMapStub();
    const layer = vectorControlLayer({
      style: { ...DEFAULT_LAYER_STYLE, markerEnabled: true },
    });

    syncLayer(map as never, layer);

    const added = calls.find((c) => c.method === "addLayer");
    assert.ok(added, "expected the marker overlay layer to be added");
    const spec = added.args[0] as {
      id: string;
      type: string;
      source: string;
      layout: Record<string, unknown>;
    };
    assert.equal(spec.id, "layer-vec1-marker");
    assert.equal(spec.type, "symbol");
    assert.equal(spec.source, "vec1-source");
    assert.match(String(spec.layout["icon-image"]), /^geolibre-marker-/);

    assert.ok(
      calls.some(
        (c) =>
          c.method === "setLayoutProperty" &&
          c.args[0] === "vec1-circle" &&
          c.args[1] === "visibility" &&
          c.args[2] === "none",
      ),
      "expected the control's circle layer to be hidden under the marker",
    );
  });

  it("drives the marker overlay's icon-size from proportional sizing", () => {
    const { map, calls } = makeVectorControlMapStub();
    const layer = vectorControlLayer({
      style: {
        ...DEFAULT_LAYER_STYLE,
        markerEnabled: true,
        ...proportionalStyle,
      },
    });

    syncLayer(map as never, layer);

    const added = calls.find((c) => c.method === "addLayer");
    assert.ok(added, "expected the marker overlay layer to be added");
    const layout = (added.args[0] as { layout: Record<string, unknown> })
      .layout;
    assert.ok(
      Array.isArray(layout["icon-size"]),
      "expected a data-driven icon-size expression",
    );
  });

  it("overrides the control circle's radius while proportional sizing is on", () => {
    const { map, calls } = makeVectorControlMapStub();
    const layer = vectorControlLayer({
      style: { ...DEFAULT_LAYER_STYLE, ...proportionalStyle },
    });

    syncLayer(map as never, layer);

    const radius = calls.find(
      (c) =>
        c.method === "setPaintProperty" &&
        c.args[0] === "vec1-circle" &&
        c.args[1] === "circle-radius",
    );
    assert.ok(radius, "expected circle-radius to be overridden");
    assert.ok(Array.isArray(radius.args[2]), "expected an interpolate");
  });

  it("restores the flat radius when proportional sizing turns off", () => {
    // The map still carries a stale expression from a previous override.
    const { map, calls } = makeVectorControlMapStub({
      circleRadiusPaint: ["interpolate", ["linear"], ["get", "pop_max"]],
    });

    syncLayer(map as never, vectorControlLayer());

    const radius = calls.find(
      (c) =>
        c.method === "setPaintProperty" &&
        c.args[0] === "vec1-circle" &&
        c.args[1] === "circle-radius",
    );
    assert.ok(radius, "expected the stale expression to be replaced");
    assert.equal(typeof radius.args[2], "number");
  });

  it("leaves the control's paint alone when neither option is active", () => {
    const { map, calls } = makeVectorControlMapStub();

    syncLayer(map as never, vectorControlLayer());

    assert.ok(
      !calls.some((c) => c.method === "setPaintProperty"),
      "expected paint to be left to the control",
    );
    assert.ok(
      !calls.some((c) => c.method === "addLayer"),
      "expected no overlay layer",
    );
  });

  it("keeps the cluster renderer untouched", () => {
    const { map, calls } = makeVectorControlMapStub();
    const layer = vectorControlLayer({
      style: {
        ...DEFAULT_LAYER_STYLE,
        markerEnabled: true,
        ...proportionalStyle,
        pointRenderer: "cluster",
      },
    });

    syncLayer(map as never, layer);

    assert.ok(
      !calls.some((c) => c.method === "addLayer"),
      "expected no overlay layer in cluster mode",
    );
    assert.ok(
      !calls.some(
        (c) =>
          c.method === "setPaintProperty" && c.args[1] === "circle-radius",
      ),
      "expected the cluster radius paint to be left alone",
    );
  });
});
