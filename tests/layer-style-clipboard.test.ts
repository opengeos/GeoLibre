import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  applyCopiedLayerStyle,
  copyableLayerStyleKind,
  DEFAULT_LAYER_STYLE,
  extractCopiedLayerStyle,
  useAppStore,
  type GeoLibreLayer,
} from "@geolibre/core";

// Mirrors RASTER_SOURCE_KIND in @geolibre/plugins; the clipboard module inlines
// the same literal (core must not depend on plugins). If this string ever
// drifts from the plugins constant, the raster-kind tests here go red.
const RASTER_SOURCE_KIND = "maplibre-gl-raster";

function vectorLayer(patch: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id: "vec",
    name: "Vector",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    geojson: { type: "FeatureCollection", features: [] },
    ...patch,
  };
}

function rasterLayer(patch: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id: "ras",
    name: "Raster",
    type: "cog",
    source: { type: "raster" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      sourceKind: RASTER_SOURCE_KIND,
      rasterState: {
        mode: "single",
        bands: [1],
        colormap: "viridis",
        reversed: false,
        rescale: [[0, 100]],
        nodata: "auto",
        stretch: "linear",
        gamma: 1,
      },
    },
    ...patch,
  };
}

describe("copyableLayerStyleKind", () => {
  it("maps a vector-styled layer to the vector kind", () => {
    assert.equal(copyableLayerStyleKind(vectorLayer()), "vector");
    assert.equal(copyableLayerStyleKind(vectorLayer({ type: "vector-tiles" })), "vector");
  });

  it("maps a raster layer to the raster kind", () => {
    assert.equal(copyableLayerStyleKind(rasterLayer()), "raster");
  });

  it("returns null for a layer with no copyable symbology", () => {
    assert.equal(copyableLayerStyleKind(vectorLayer({ type: "xyz", metadata: {} })), null);
  });
});

describe("extractCopiedLayerStyle", () => {
  it("captures the full style and opacity for a vector layer", () => {
    const source = vectorLayer({
      opacity: 0.5,
      style: { ...DEFAULT_LAYER_STYLE, fillColor: "#ff0000", strokeWidth: 5 },
    });
    const copied = extractCopiedLayerStyle(source);
    assert.ok(copied);
    assert.equal(copied.kind, "vector");
    assert.equal(copied.opacity, 0.5);
    assert.equal(copied.style.fillColor, "#ff0000");
    assert.equal(copied.style.strokeWidth, 5);
  });

  it("deep-clones so later edits to the source do not mutate the clipboard", () => {
    const source = vectorLayer({ style: { ...DEFAULT_LAYER_STYLE, fillColor: "#ff0000" } });
    const copied = extractCopiedLayerStyle(source);
    assert.ok(copied);
    source.style.fillColor = "#00ff00";
    assert.equal(copied.style.fillColor, "#ff0000");
  });

  it("captures rasterState and symbology for a raster layer", () => {
    const source = rasterLayer({
      opacity: 0.8,
      metadata: {
        sourceKind: RASTER_SOURCE_KIND,
        rasterState: { mode: "single", bands: [1], colormap: "magma", rescale: [[10, 90]] },
        rasterSymbology: {
          classified: true,
          ramp: "magma",
          classCount: 3,
          breaks: [10, 40, 70, 90],
        },
      },
    });
    const copied = extractCopiedLayerStyle(source);
    assert.ok(copied);
    assert.equal(copied.kind, "raster");
    assert.equal(copied.opacity, 0.8);
    assert.equal((copied.rasterState as Record<string, unknown>).colormap, "magma");
    assert.equal(copied.hasRasterSymbology, true);
  });

  it("records that a raster source had no symbology", () => {
    const copied = extractCopiedLayerStyle(rasterLayer());
    assert.ok(copied);
    assert.equal(copied.hasRasterSymbology, false);
  });

  it("returns null when the layer has no copyable symbology", () => {
    assert.equal(extractCopiedLayerStyle(vectorLayer({ type: "xyz", metadata: {} })), null);
  });
});

describe("applyCopiedLayerStyle", () => {
  it("returns the full style and opacity when pasting vector onto vector", () => {
    const copied = extractCopiedLayerStyle(
      vectorLayer({ opacity: 0.4, style: { ...DEFAULT_LAYER_STYLE, fillColor: "#123456" } }),
    );
    assert.ok(copied);
    const patch = applyCopiedLayerStyle(vectorLayer({ id: "target" }), copied);
    assert.ok(patch);
    assert.equal(patch.opacity, 0.4);
    assert.equal(patch.style?.fillColor, "#123456");
  });

  it("refuses to paste across style families", () => {
    const vectorCopy = extractCopiedLayerStyle(vectorLayer());
    assert.ok(vectorCopy);
    assert.equal(applyCopiedLayerStyle(rasterLayer(), vectorCopy), null);

    const rasterCopy = extractCopiedLayerStyle(rasterLayer());
    assert.ok(rasterCopy);
    assert.equal(applyCopiedLayerStyle(vectorLayer(), rasterCopy), null);
  });

  it("merges raster appearance keys but preserves the target's band selection", () => {
    const copied = extractCopiedLayerStyle(
      rasterLayer({
        opacity: 0.7,
        metadata: {
          sourceKind: RASTER_SOURCE_KIND,
          rasterState: {
            mode: "single",
            bands: [2],
            colormap: "magma",
            rescale: [[5, 50]],
            gamma: 2,
          },
        },
      }),
    );
    assert.ok(copied);
    const target = rasterLayer({
      id: "target",
      metadata: {
        sourceKind: RASTER_SOURCE_KIND,
        rasterState: {
          mode: "single",
          bands: [1],
          colormap: "viridis",
          rescale: [[0, 100]],
          gamma: 1,
        },
      },
    });
    const patch = applyCopiedLayerStyle(target, copied);
    assert.ok(patch);
    const state = (patch.metadata as Record<string, unknown>).rasterState as Record<
      string,
      unknown
    >;
    // Appearance carried over.
    assert.equal(state.colormap, "magma");
    assert.equal(state.gamma, 2);
    assert.deepEqual(state.rescale, [[5, 50]]);
    // Data selection stays with the target.
    assert.deepEqual(state.bands, [1]);
    assert.equal(patch.opacity, 0.7);
  });

  it("clears a stale symbology when the copied raster had none", () => {
    const copied = extractCopiedLayerStyle(rasterLayer());
    assert.ok(copied);
    const target = rasterLayer({
      id: "target",
      metadata: {
        sourceKind: RASTER_SOURCE_KIND,
        rasterState: { mode: "single", bands: [1], colormap: "viridis" },
        rasterSymbology: { classified: true, ramp: "viridis", classCount: 2, breaks: [0, 50, 100] },
      },
    });
    const patch = applyCopiedLayerStyle(target, copied);
    assert.ok(patch);
    assert.equal("rasterSymbology" in (patch.metadata as Record<string, unknown>), false);
  });
});

describe("store copy/paste actions", () => {
  beforeEach(() => {
    useAppStore.getState().newProject({ name: "Clipboard" });
  });

  it("copies from one layer and pastes onto another", () => {
    const store = useAppStore.getState();
    store.addLayer(
      vectorLayer({ id: "a", style: { ...DEFAULT_LAYER_STYLE, fillColor: "#abcdef" } }),
    );
    store.addLayer(vectorLayer({ id: "b" }));

    store.copyLayerStyle("a");
    assert.equal(useAppStore.getState().copiedLayerStyle?.kind, "vector");

    store.pasteLayerStyle("b");
    const pasted = useAppStore.getState().layers.find((l) => l.id === "b");
    assert.equal(pasted?.style.fillColor, "#abcdef");
    assert.equal(useAppStore.getState().isDirty, true);
  });

  it("leaves a non-copyable layer's request as a no-op without clearing the clipboard", () => {
    const store = useAppStore.getState();
    store.addLayer(
      vectorLayer({ id: "a", style: { ...DEFAULT_LAYER_STYLE, fillColor: "#abcdef" } }),
    );
    store.addLayer(vectorLayer({ id: "x", type: "xyz", metadata: {} }));

    store.copyLayerStyle("a");
    store.copyLayerStyle("x"); // xyz is not copyable
    assert.equal(useAppStore.getState().copiedLayerStyle?.style.fillColor, "#abcdef");
  });

  it("does not paste across style families", () => {
    const store = useAppStore.getState();
    store.addLayer(
      vectorLayer({ id: "vec", style: { ...DEFAULT_LAYER_STYLE, fillColor: "#abcdef" } }),
    );
    store.addLayer(rasterLayer({ id: "ras" }));

    store.copyLayerStyle("vec");
    store.pasteLayerStyle("ras");
    const raster = useAppStore.getState().layers.find((l) => l.id === "ras");
    // rasterState untouched (still viridis from the fixture).
    assert.equal(
      ((raster?.metadata.rasterState as Record<string, unknown>) ?? {}).colormap,
      "viridis",
    );
  });
});
