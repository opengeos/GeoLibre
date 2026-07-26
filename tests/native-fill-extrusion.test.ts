import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import { externalExtrusionLayerId, syncLayer } from "../packages/map/src/layer-sync";

// Control-managed layers (`customLayerType`) take layer-sync's ordering-only
// path, which deliberately leaves the control's rendering alone. Polygon
// sources whose control has no extrusion concept — Overture Maps buildings —
// opt back in with `nativeFillExtrusion` so the Style panel's 3D extrusion mode
// actually renders. Mirrors the stub in control-owns-paint.test.ts, plus the
// getters the synthetic extrusion layer reads.
interface MapCall {
  method: string;
  args: unknown[];
}

function makeMapStub(fillLayerId: string) {
  const calls: MapCall[] = [];
  const present = new Set<string>([fillLayerId]);
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
    };
  const fillSpec = {
    id: fillLayerId,
    type: "fill",
    source: "overture-buildings",
    "source-layer": "building",
  };
  const map = {
    getStyle: () => ({ layers: [fillSpec] }),
    getLayer: (id: string) =>
      present.has(id) ? { id, type: id === fillLayerId ? "fill" : "fill-extrusion" } : undefined,
    getSource: () => ({}),
    getFilter: () => undefined,
    getPaintProperty: () => undefined,
    setLayoutProperty: record("setLayoutProperty"),
    setPaintProperty: record("setPaintProperty"),
    setFilter: record("setFilter"),
    setLayerZoomRange: record("setLayerZoomRange"),
    moveLayer: record("moveLayer"),
    addSource: record("addSource"),
    addLayer: (...args: unknown[]) => {
      const spec = args[0] as { id: string };
      present.add(spec.id);
      calls.push({ method: "addLayer", args });
    },
    removeLayer: (...args: unknown[]) => {
      present.delete(args[0] as string);
      calls.push({ method: "removeLayer", args });
    },
  };
  return { map, calls, present };
}

function overtureLayer(id: string, patch: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id,
    name: "Overture Building",
    type: "vector-tiles",
    source: { type: "vector", sourceId: "overture-buildings" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      customLayerType: "overture-maps",
      externalNativeLayer: true,
      nativeLayerIds: [`${id}-fill`],
      sourceIds: ["overture-buildings"],
      nativeFillExtrusion: true,
    },
    ...patch,
  };
}

describe("3D extrusion on control-managed native fill layers", () => {
  it("extrudes an opted-in control layer instead of only reordering it", () => {
    const nativeId = "opt-in-fill";
    const { map, calls } = makeMapStub(nativeId);
    const layer = overtureLayer("opt-in", {
      style: { ...DEFAULT_LAYER_STYLE, extrusionEnabled: true },
    });

    syncLayer(map as never, layer);

    const added = calls.find(
      (c) =>
        c.method === "addLayer" &&
        (c.args[0] as { id: string }).id === `${nativeId}-geolibre-extrusion`,
    );
    assert.ok(added, "expected a synthetic fill-extrusion layer to be added");
    const spec = added.args[0] as Record<string, unknown>;
    assert.equal(spec.type, "fill-extrusion");
    // Built from the control's own source so the extrusion covers the same
    // tiles the flat fill did.
    assert.equal(spec.source, "overture-buildings");
    assert.equal(spec["source-layer"], "building");

    // The flat fill is hidden rather than restyled, leaving it to the control.
    const hidden = calls.find(
      (c) => c.method === "setLayoutProperty" && c.args[0] === nativeId && c.args[2] === "none",
    );
    assert.ok(hidden, "expected the native fill to be hidden behind the extrusion");
  });

  it("omits the filter key entirely when the native fill carries no filter", () => {
    // MapLibre validates the spec on first add and rejects an explicit
    // `filter: undefined` ("array expected, undefined found") by dropping the
    // layer without throwing — only an `error` event reports it. Overture's
    // native fills carry no filter, so passing the key through meant the
    // extrusion layer never reached the map.
    const nativeId = "unfiltered-fill";
    const { map, calls } = makeMapStub(nativeId);

    syncLayer(
      map as never,
      overtureLayer("unfiltered", {
        metadata: {
          customLayerType: "overture-maps",
          externalNativeLayer: true,
          nativeLayerIds: [nativeId],
          sourceIds: ["overture-buildings"],
          nativeFillExtrusion: true,
        },
        style: { ...DEFAULT_LAYER_STYLE, extrusionEnabled: true },
      }),
    );

    const added = calls.find((c) => c.method === "addLayer");
    assert.ok(added, "expected the extrusion layer to be added");
    assert.ok(
      !("filter" in (added.args[0] as Record<string, unknown>)),
      "expected no filter key so MapLibre does not reject the layer",
    );
  });

  it("leaves a control layer that has not opted in on the ordering-only path", () => {
    const nativeId = "opt-out-fill";
    const { map, calls } = makeMapStub(nativeId);
    const layer = overtureLayer("opt-out", {
      style: { ...DEFAULT_LAYER_STYLE, extrusionEnabled: true },
      metadata: {
        customLayerType: "overture-maps",
        externalNativeLayer: true,
        nativeLayerIds: [nativeId],
        sourceIds: ["overture-buildings"],
      },
    });

    syncLayer(map as never, layer);

    assert.ok(
      !calls.some((c) => c.method === "addLayer"),
      "expected no extrusion layer for a control that renders extrusions itself",
    );
    assert.ok(
      calls.some((c) => c.method === "moveLayer"),
      "expected ordering to still be synced",
    );
  });

  it("restores the control's flat fill when extrusion is switched back off", () => {
    const nativeId = "toggle-fill";
    const { map, calls, present } = makeMapStub(nativeId);

    syncLayer(
      map as never,
      overtureLayer("toggle", {
        metadata: {
          customLayerType: "overture-maps",
          externalNativeLayer: true,
          nativeLayerIds: [nativeId],
          sourceIds: ["overture-buildings"],
          nativeFillExtrusion: true,
        },
        style: { ...DEFAULT_LAYER_STYLE, extrusionEnabled: true },
      }),
    );
    assert.ok(present.has(externalExtrusionLayerId(nativeId)), "expected the extrusion layer");

    calls.length = 0;
    syncLayer(
      map as never,
      overtureLayer("toggle", {
        metadata: {
          customLayerType: "overture-maps",
          externalNativeLayer: true,
          nativeLayerIds: [nativeId],
          sourceIds: ["overture-buildings"],
          nativeFillExtrusion: true,
        },
      }),
    );

    assert.ok(
      !present.has(externalExtrusionLayerId(nativeId)),
      "expected the synthetic extrusion layer to be removed",
    );
    // Without this the control-managed path never writes visibility, so the
    // fill would stay hidden and the layer would vanish on the way back to 2D.
    const restored = calls.find(
      (c) => c.method === "setLayoutProperty" && c.args[0] === nativeId && c.args[2] === "visible",
    );
    assert.ok(restored, "expected the native fill to be made visible again");
  });

  it("keeps a hidden layer hidden when extrusion is switched off", () => {
    const nativeId = "hidden-fill";
    const { map, calls } = makeMapStub(nativeId);
    const metadata = {
      customLayerType: "overture-maps",
      externalNativeLayer: true,
      nativeLayerIds: [nativeId],
      sourceIds: ["overture-buildings"],
      nativeFillExtrusion: true,
    };

    syncLayer(
      map as never,
      overtureLayer("hidden", {
        metadata,
        style: { ...DEFAULT_LAYER_STYLE, extrusionEnabled: true },
      }),
    );

    calls.length = 0;
    syncLayer(map as never, overtureLayer("hidden", { metadata, visible: false }));

    const restored = calls.find((c) => c.method === "setLayoutProperty" && c.args[0] === nativeId);
    assert.ok(restored, "expected visibility to be written back");
    assert.equal(restored.args[2], "none", "expected a hidden layer to stay hidden");
  });
});
