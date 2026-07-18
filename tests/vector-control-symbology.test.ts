import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import { removeLayerFromMap, syncLayer } from "../packages/map/src/layer-sync";

// Records the maplibre calls a layer sync makes so a test can assert which
// native operations ran. Mirrors the stub in control-owns-paint.test.ts, plus
// the style/paint getters the vector-control symbology overlay reads.
interface MapCall {
  method: string;
  args: unknown[];
}

function makeVectorControlMapStub(layerId: string) {
  const calls: MapCall[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
    };
  const circleSpec = {
    id: `${layerId}-circle`,
    type: "circle",
    source: `${layerId}-source`,
    filter: ["==", ["geometry-type"], "Point"],
  };
  const map = {
    getStyle: () => ({ layers: [circleSpec] }),
    getLayer: (id: string) => (id === circleSpec.id ? { id, type: "circle" } : undefined),
    getSource: () => undefined,
    getFilter: () => circleSpec.filter,
    getPaintProperty: () => undefined,
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

function vectorControlLayer(layerId: string, patch: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id: layerId,
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
      nativeLayerIds: [`${layerId}-circle`],
      sourceIds: [`${layerId}-source`],
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

function radiusCalls(calls: MapCall[], layerId: string): MapCall[] {
  return calls.filter(
    (c) =>
      c.method === "setPaintProperty" &&
      c.args[0] === `${layerId}-circle` &&
      c.args[1] === "circle-radius",
  );
}

describe("vector-control point symbology overlay (#1311)", () => {
  it("renders a GeoLibre marker symbol layer and hides the control's circle", () => {
    const { map, calls } = makeVectorControlMapStub("vecm");
    const layer = vectorControlLayer("vecm", {
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
    assert.equal(spec.id, "layer-vecm-marker");
    assert.equal(spec.type, "symbol");
    assert.equal(spec.source, "vecm-source");
    assert.match(String(spec.layout["icon-image"]), /^geolibre-marker-/);

    assert.ok(
      calls.some(
        (c) =>
          c.method === "setLayoutProperty" &&
          c.args[0] === "vecm-circle" &&
          c.args[1] === "visibility" &&
          c.args[2] === "none",
      ),
      "expected the control's circle layer to be hidden under the marker",
    );
  });

  it("drives the marker overlay's icon-size from proportional sizing", () => {
    const { map, calls } = makeVectorControlMapStub("vecms");
    const layer = vectorControlLayer("vecms", {
      style: {
        ...DEFAULT_LAYER_STYLE,
        markerEnabled: true,
        ...proportionalStyle,
      },
    });

    syncLayer(map as never, layer);

    const added = calls.find((c) => c.method === "addLayer");
    assert.ok(added, "expected the marker overlay layer to be added");
    const layout = (added.args[0] as { layout: Record<string, unknown> }).layout;
    assert.ok(Array.isArray(layout["icon-size"]), "expected a data-driven icon-size expression");
  });

  it("overrides the control circle's radius while proportional sizing is on", () => {
    const { map, calls } = makeVectorControlMapStub("vecp");
    const layer = vectorControlLayer("vecp", {
      style: { ...DEFAULT_LAYER_STYLE, ...proportionalStyle },
    });

    syncLayer(map as never, layer);

    const radius = radiusCalls(calls, "vecp");
    assert.equal(radius.length, 1, "expected circle-radius to be overridden");
    assert.ok(Array.isArray(radius[0].args[2]), "expected an interpolate");
  });

  it("restores the flat radius when proportional sizing turns off", () => {
    const { map, calls } = makeVectorControlMapStub("vecr");

    syncLayer(
      map as never,
      vectorControlLayer("vecr", {
        style: { ...DEFAULT_LAYER_STYLE, ...proportionalStyle },
      }),
    );
    syncLayer(map as never, vectorControlLayer("vecr"));

    const radius = radiusCalls(calls, "vecr");
    assert.equal(radius.length, 2, "expected override then restore");
    assert.ok(Array.isArray(radius[0].args[2]));
    assert.equal(typeof radius[1].args[2], "number");
  });

  it("tracks overridden radii per map, not globally by layer id", () => {
    // Two maps (e.g. a swipe pair) can host control layers with the same
    // native layer id. Restoring one map's radius must not eat the tracking
    // entry of the other, which would leave its proportional interpolate
    // stuck on the control's circle.
    const first = makeVectorControlMapStub("vecw");
    const second = makeVectorControlMapStub("vecw");
    const proportional = vectorControlLayer("vecw", {
      style: { ...DEFAULT_LAYER_STYLE, ...proportionalStyle },
    });

    syncLayer(first.map as never, proportional);
    syncLayer(second.map as never, proportional);
    // Turn proportional sizing off on the first map only.
    syncLayer(first.map as never, vectorControlLayer("vecw"));
    syncLayer(second.map as never, vectorControlLayer("vecw"));

    const firstRadius = radiusCalls(first.calls, "vecw");
    assert.equal(firstRadius.length, 2, "expected override then restore");
    assert.equal(typeof firstRadius[1].args[2], "number");

    const secondRadius = radiusCalls(second.calls, "vecw");
    assert.equal(secondRadius.length, 2, "expected the second map to restore independently");
    assert.equal(typeof secondRadius[1].args[2], "number");
  });

  it("forgets an overridden radius when the layer is removed outright", () => {
    // Deleting a layer mid-override must clear its tracking entry; otherwise
    // a later layer that reuses the native id would inherit a stale restore
    // and clobber a control-authored radius expression.
    const { map, calls } = makeVectorControlMapStub("vecd");
    const overridden = vectorControlLayer("vecd", {
      style: { ...DEFAULT_LAYER_STYLE, ...proportionalStyle },
    });

    syncLayer(map as never, overridden);
    removeLayerFromMap(map as never, "vecd", overridden);
    // A fresh layer reusing the same native id, proportional off: nothing to
    // restore, so the control keeps its radius paint untouched.
    syncLayer(map as never, vectorControlLayer("vecd"));

    const radius = radiusCalls(calls, "vecd");
    assert.equal(radius.length, 1, "expected the override only — no restore");
    assert.ok(Array.isArray(radius[0].args[2]));
  });

  it("restores an overridden radius when the renderer leaves single mode", () => {
    // If the control reused the same circle id across a mode switch, a stale
    // proportional interpolate must not bleed into the new renderer.
    const { map, calls } = makeVectorControlMapStub("vecc");

    syncLayer(
      map as never,
      vectorControlLayer("vecc", {
        style: { ...DEFAULT_LAYER_STYLE, ...proportionalStyle },
      }),
    );
    syncLayer(
      map as never,
      vectorControlLayer("vecc", {
        style: {
          ...DEFAULT_LAYER_STYLE,
          ...proportionalStyle,
          pointRenderer: "cluster",
        },
      }),
    );

    const radius = radiusCalls(calls, "vecc");
    assert.equal(radius.length, 2, "expected override then restore");
    assert.equal(typeof radius[1].args[2], "number");
  });

  it("only applies proportional sizing, never rule-based radius overrides", () => {
    // Rule-based per-rule sizes are a store-managed-layer feature; on a
    // control-owned layer none of the other rule paint applies, so smuggling
    // just the radius through would be a half-applied rule experience.
    const { map, calls } = makeVectorControlMapStub("vecrb");
    const layer = vectorControlLayer("vecrb", {
      style: {
        ...DEFAULT_LAYER_STYLE,
        vectorStyleMode: "rule-based",
        vectorRules: [
          {
            id: "r1",
            label: "big",
            filter: '[">", ["get", "pop_max"], 1000000]',
            color: "#ff0000",
            isElse: false,
            circleRadius: 12,
          },
        ],
      },
    });

    syncLayer(map as never, layer);

    assert.equal(
      radiusCalls(calls, "vecrb").length,
      0,
      "expected rule-based radius to be left to store-managed layers",
    );
  });

  it("leaves the control's paint alone when neither option is active", () => {
    const { map, calls } = makeVectorControlMapStub("vecn");

    syncLayer(map as never, vectorControlLayer("vecn"));

    assert.ok(
      !calls.some((c) => c.method === "setPaintProperty"),
      "expected paint to be left to the control",
    );
    assert.ok(!calls.some((c) => c.method === "addLayer"), "expected no overlay layer");
  });

  it("keeps the cluster renderer untouched", () => {
    const { map, calls } = makeVectorControlMapStub("veck");
    const layer = vectorControlLayer("veck", {
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
    assert.equal(
      radiusCalls(calls, "veck").length,
      0,
      "expected the cluster radius paint to be left alone",
    );
  });
});
