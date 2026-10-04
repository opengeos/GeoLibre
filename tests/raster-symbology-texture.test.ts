import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type GeoLibreLayer, type LayerStyle, useAppStore } from "@geolibre/core";
import {
  RASTER_SOURCE_KIND,
  activateRasterClassification,
  disposeAllRasterClassification,
} from "../packages/plugins/src/plugins/raster-symbology-texture";

type PipelineModule = {
  module?: { name?: string };
  props?: Record<string, unknown>;
};

// Minimal ImageData polyfill so the texture builder can run headless; the real
// createColormapTexture only reads width/height/data off it.
(globalThis as { ImageData?: unknown }).ImageData ??= class {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
};

/**
 * Minimal stand-in for the maplibre-gl-raster LayerManager + RasterControl
 * surface the symbology injection patches. `_renderTileFor` returns a render
 * pipeline whose trailing "colormap" module starts with the upstream defaults
 * (`reversed: false`, a named-colormap texture/index).
 */
function fakeControl() {
  let engine = "maplibre-gl-raster";
  const manager: Record<string, unknown> = {
    _device: {},
    _deps: {},
    _rebuild: () => {},
    _renderTileFor:
      (_layer: unknown) =>
      (_data: unknown): { renderPipeline: PipelineModule[] } => ({
        renderPipeline: [
          { module: { name: "composite" }, props: {} },
          {
            module: { name: "colormap" },
            props: {
              reversed: false,
              colormapIndex: 4,
              colormapTexture: "upstream",
            },
          },
        ],
      }),
  };
  return {
    _layerManager: manager,
    getEngine: () => engine,
    setEngine: (next: string) => {
      engine = next;
    },
  } as {
    _layerManager: Record<string, unknown>;
    getEngine: () => string;
    setEngine: (next: string) => void;
  };
}

/** Renders a single-band tile through the patched manager and returns the
 * colormap module's props. */
function renderColormapProps(
  control: { _layerManager: Record<string, unknown> },
  layerId: string,
): Record<string, unknown> | undefined {
  const renderTileFor = control._layerManager._renderTileFor as (
    layer: unknown,
  ) => (data: unknown) => { renderPipeline: PipelineModule[] } | null;
  const result = renderTileFor({ id: layerId, state: { mode: "single" } })({});
  return result?.renderPipeline.find((mod) => mod.module?.name === "colormap")?.props;
}

function rasterLayer(
  id: string,
  opts: {
    rasterSymbology?: Record<string, unknown>;
    reversed?: boolean;
    mode?: "single" | "rgb";
  } = {},
): GeoLibreLayer {
  return {
    id,
    name: id,
    type: "cog",
    source: { type: "raster", url: `https://example.com/${id}.tif` },
    visible: true,
    opacity: 1,
    style: {} as LayerStyle,
    sourcePath: id,
    metadata: {
      sourceKind: RASTER_SOURCE_KIND,
      externalNativeLayer: true,
      // Reverse lives on rasterState now (the control renders it for built-in
      // colormaps; the injected texture reads it for classified / custom).
      rasterState: {
        mode: opts.mode ?? "single",
        colormap: "viridis",
        reversed: opts.reversed ?? false,
      },
      ...(opts.rasterSymbology ? { rasterSymbology: opts.rasterSymbology } : {}),
    },
  } as GeoLibreLayer;
}

describe("raster symbology render injection", () => {
  beforeEach(() => {
    useAppStore.setState({ layers: [] });
  });

  afterEach(() => {
    disposeAllRasterClassification();
    useAppStore.setState({ layers: [] });
  });

  it("leaves a built-in continuous ramp to the upstream control, reversed or not", () => {
    // A built-in colormap (even reversed) renders through the control via
    // rasterState.reversed; GeoLibre injects nothing and the patch is a no-op.
    useAppStore.getState().addLayer(rasterLayer("r1", { reversed: true }));
    const control = fakeControl();
    activateRasterClassification(control);

    const props = renderColormapProps(control, "r1");
    assert.equal(props?.reversed, false); // patch did not touch the uniform
    assert.equal(props?.colormapTexture, "upstream"); // upstream colormap kept
    assert.equal(props?.colormapIndex, 4);
  });

  it("leaves the pipeline untouched for a plain continuous layer", () => {
    useAppStore.getState().addLayer(rasterLayer("r1"));
    const control = fakeControl();
    activateRasterClassification(control);

    assert.equal(renderColormapProps(control, "r1")?.reversed, false);
  });

  it("injects a gradient texture for a custom continuous ramp", () => {
    useAppStore.getState().addLayer(
      rasterLayer("r1", {
        rasterSymbology: {
          classified: false,
          ramp: "viridis",
          customColors: ["#ff0000", "#0000ff"],
          method: "equal-interval",
          classCount: 5,
          breaks: [0, 1, 2, 3, 4, 5],
        },
      }),
    );
    const control = fakeControl();
    // Swap in a device that can build textures (the default fake device can't).
    const created: { opts: { width?: number } }[] = [];
    control._layerManager._device = {
      createTexture: (opts: { width?: number }) => {
        const texture = { destroy() {}, opts };
        created.push(texture);
        return texture;
      },
    };
    activateRasterClassification(control);

    const props = renderColormapProps(control, "r1");
    // A custom ramp samples an injected texture, so the shader uniform stays
    // false (reversal, if any, is baked into the texture colors).
    assert.equal(props?.reversed, false);
    assert.equal(props?.colormapIndex, 0);
    assert.ok(props?.colormapTexture, "expected an injected colormap texture");
    assert.equal(created.length >= 1, true);
    assert.equal(created[0]?.opts.width, 256);
  });

  it("rebuilds the classified texture when class opacity changes", () => {
    const layer = rasterLayer("r1", {
      rasterSymbology: {
        classified: true,
        ramp: "viridis",
        customColors: ["#ff0000", "#0000ff"],
        method: "equal-interval",
        classCount: 2,
        breaks: [0, 1, 2],
      },
    });
    useAppStore.getState().addLayer(layer);
    const control = fakeControl();
    let created = 0;
    let destroyed = 0;
    control._layerManager._device = {
      createTexture: () => {
        created += 1;
        return { destroy: () => (destroyed += 1) };
      },
    };
    activateRasterClassification(control);
    renderColormapProps(control, "r1");
    assert.equal(created, 1);

    useAppStore.getState().updateLayer("r1", {
      metadata: {
        ...layer.metadata,
        rasterSymbology: {
          ...(layer.metadata.rasterSymbology as Record<string, unknown>),
          classOpacities: [0, 1],
        },
      },
    });
    renderColormapProps(control, "r1");

    assert.equal(created, 2);
    assert.equal(destroyed, 1);
  });

  it("injects, updates and removes opacity on a named continuous ramp", () => {
    const symbology = {
      classified: false,
      opacityClasses: true,
      ramp: "viridis",
      method: "manual",
      classCount: 2,
      breaks: [0, 25, 100],
      classOpacities: [0, 1],
    };
    const layer = rasterLayer("continuous", {
      rasterSymbology: symbology,
      reversed: true,
    });
    useAppStore.getState().addLayer(layer);
    const control = fakeControl();
    let created = 0;
    let destroyed = 0;
    control._layerManager._device = {
      createTexture: () => ({
        id: ++created,
        destroy: () => {
          destroyed++;
        },
      }),
    };
    control.setEngine("cog-tiler-wasm");
    activateRasterClassification(control);
    assert.equal(control.getEngine(), "maplibre-gl-raster");
    assert.notEqual(renderColormapProps(control, layer.id)?.colormapTexture, "upstream");
    assert.equal(renderColormapProps(control, layer.id)?.reversed, false);
    const update = (patch: Record<string, unknown>, state = {}) => {
      useAppStore.getState().updateLayer(layer.id, {
        metadata: {
          ...layer.metadata,
          rasterState: { ...(layer.metadata.rasterState as object), ...state },
          rasterSymbology: { ...symbology, ...patch },
        },
      });
      return renderColormapProps(control, layer.id);
    };
    update({ classOpacities: [0.5, 1] });
    assert.equal(created, 2);
    update({}, { gamma: 2, stretch: "sqrt", rescale: [[0, 50]] });
    assert.equal(created, 3);
    update({ classified: true });
    assert.equal(created, 4);
    assert.equal(update({ classOpacities: undefined })?.colormapTexture, "upstream");
    assert.equal(destroyed, 4);
  });

  it("leaves a classified texture alone when only the render stretch changes", () => {
    const symbology = {
      classified: true,
      ramp: "viridis",
      customColors: ["#ff0000", "#0000ff"],
      method: "manual",
      classCount: 2,
      breaks: [0, 25, 100],
      classOpacities: [0.5, 1],
    };
    const layer = rasterLayer("stepped", { rasterSymbology: symbology });
    useAppStore.getState().addLayer(layer);
    const control = fakeControl();
    let created = 0;
    control._layerManager._device = {
      createTexture: () => ({ id: ++created, destroy: () => {} }),
    };
    activateRasterClassification(control);
    renderColormapProps(control, layer.id);
    assert.equal(created, 1);
    // A stepped colormap never reads rescale / stretch / gamma, so editing them
    // must not invalidate its cached GPU texture.
    useAppStore.getState().updateLayer(layer.id, {
      metadata: {
        ...layer.metadata,
        rasterState: {
          ...(layer.metadata.rasterState as object),
          gamma: 2,
          stretch: "sqrt",
          rescale: [[0, 50]],
        },
        rasterSymbology: symbology,
      },
    });
    renderColormapProps(control, layer.id);
    assert.equal(created, 1);
  });

  it("switches from the WASM renderer when discrete classes need the GPU pipeline", () => {
    useAppStore.getState().addLayer(
      rasterLayer("r1", {
        rasterSymbology: {
          classified: true,
          ramp: "autumn",
          method: "manual",
          classCount: 2,
          breaks: [144.86, 200, 322.84],
        },
      }),
    );
    const control = fakeControl();
    control.setEngine("cog-tiler-wasm");

    activateRasterClassification(control);

    assert.equal(control.getEngine(), "maplibre-gl-raster");
  });

  it("does not switch renderers for stale classification metadata in RGB mode", () => {
    useAppStore.getState().addLayer(
      rasterLayer("r1", {
        mode: "rgb",
        rasterSymbology: {
          classified: true,
          ramp: "autumn",
          method: "manual",
          classCount: 2,
          breaks: [0, 200, 300],
        },
      }),
    );
    const control = fakeControl();
    control.setEngine("cog-tiler-wasm");

    activateRasterClassification(control);

    assert.equal(control.getEngine(), "cog-tiler-wasm");
  });
});
