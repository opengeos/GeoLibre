import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  applyCopiedLayerStyle,
  copyableLayerStyleKind,
  createEmptyProject,
  DEFAULT_LAYER_STYLE,
  extractCopiedLayerStyle,
  useAppStore,
  type GeoLibreLayer,
} from "@geolibre/core";
// The real constant `@geolibre/core`'s clipboard module inlines as a literal
// (core must not depend on plugins). Importing it here — not re-declaring it —
// makes the raster fixtures fail if the two ever drift. Pulled from the module
// that defines it rather than the package barrel, whose browser-only plugins
// (earth-engine, ...) do not load under the Node test runner.
import { RASTER_SOURCE_KIND } from "../packages/plugins/src/plugins/raster-layer-sync";

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

  it("skips rescale when the source and target band counts differ", () => {
    // An RGB source carries a 3-entry rescale; a single-band target expects 1.
    const copied = extractCopiedLayerStyle(
      rasterLayer({
        metadata: {
          sourceKind: RASTER_SOURCE_KIND,
          rasterState: {
            mode: "rgb",
            bands: [1, 2, 3],
            colormap: "gray",
            rescale: [
              [0, 255],
              [0, 255],
              [0, 255],
            ],
          },
        },
      }),
    );
    assert.ok(copied);
    const target = rasterLayer({
      id: "target",
      metadata: {
        sourceKind: RASTER_SOURCE_KIND,
        rasterState: { mode: "single", bands: [1], colormap: "viridis", rescale: [[10, 90]] },
      },
    });
    const patch = applyCopiedLayerStyle(target, copied);
    assert.ok(patch);
    const state = (patch.metadata as Record<string, unknown>).rasterState as Record<
      string,
      unknown
    >;
    // Colormap (shape-independent) is carried over, but the mismatched rescale
    // is not — the target keeps its own single-band stretch.
    assert.equal(state.colormap, "gray");
    assert.deepEqual(state.rescale, [[10, 90]]);
    assert.deepEqual(state.bands, [1]);
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

    assert.equal(store.copyLayerStyle("a"), true);
    assert.equal(useAppStore.getState().copiedLayerStyle?.kind, "vector");

    assert.equal(store.pasteLayerStyle("b"), true);
    const pasted = useAppStore.getState().layers.find((l) => l.id === "b");
    assert.equal(pasted?.style.fillColor, "#abcdef");
    assert.equal(useAppStore.getState().isDirty, true);
  });

  it("reports a no-op copy or paste with a false return", () => {
    const store = useAppStore.getState();
    store.addLayer(vectorLayer({ id: "vec" }));
    store.addLayer(vectorLayer({ id: "xyz", type: "xyz", metadata: {} }));

    assert.equal(store.copyLayerStyle("xyz"), false); // not copyable
    assert.equal(store.copyLayerStyle("missing"), false); // no such layer
    assert.equal(store.pasteLayerStyle("vec"), false); // empty clipboard

    assert.equal(store.copyLayerStyle("vec"), true);
    assert.equal(store.pasteLayerStyle("missing"), false); // no such target
  });

  it("clears the clipboard when a new project starts", () => {
    const store = useAppStore.getState();
    store.addLayer(vectorLayer({ id: "a" }));
    store.copyLayerStyle("a");
    assert.ok(useAppStore.getState().copiedLayerStyle);
    useAppStore.getState().newProject({ name: "Fresh" });
    assert.equal(useAppStore.getState().copiedLayerStyle, null);
  });

  it("clears the clipboard when a project is loaded", () => {
    const store = useAppStore.getState();
    store.addLayer(vectorLayer({ id: "a" }));
    store.copyLayerStyle("a");
    assert.ok(useAppStore.getState().copiedLayerStyle);
    useAppStore.getState().loadProject(createEmptyProject("Loaded"));
    assert.equal(useAppStore.getState().copiedLayerStyle, null);
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
