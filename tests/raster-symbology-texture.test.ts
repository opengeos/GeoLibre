import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type GeoLibreLayer, useAppStore } from "@geolibre/core";
import {
  RASTER_SOURCE_KIND,
  activateRasterClassification,
  disposeAllRasterClassification,
} from "../packages/plugins/src/plugins/raster-symbology-texture";

type PipelineModule = { module?: { name?: string }; props?: Record<string, unknown> };

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
            props: { reversed: false, colormapIndex: 4, colormapTexture: "upstream" },
          },
        ],
      }),
  };
  return { _layerManager: manager } as { _layerManager: Record<string, unknown> };
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
  opts: { rasterSymbology?: Record<string, unknown>; reversed?: boolean } = {},
): GeoLibreLayer {
  return {
    id,
    name: id,
    type: "cog",
    source: { type: "raster", url: `https://example.com/${id}.tif` },
    visible: true,
    opacity: 1,
    style: {},
    sourcePath: id,
    metadata: {
      sourceKind: RASTER_SOURCE_KIND,
      externalNativeLayer: true,
      // Reverse lives on rasterState now (the control renders it for built-in
      // colormaps; the injected texture reads it for classified / custom).
      rasterState: {
        mode: "single",
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
});
