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
 * pipeline whose trailing "colormap" module starts with `reversed: false`,
 * mirroring the upstream default the patch is expected to flip.
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
  return result?.renderPipeline.find((mod) => mod.module?.name === "colormap")
    ?.props;
}

function rasterLayer(
  id: string,
  rasterSymbology?: Record<string, unknown>,
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
      ...(rasterSymbology ? { rasterSymbology } : {}),
    },
  } as GeoLibreLayer;
}

const CONTINUOUS_REVERSED = {
  classified: false,
  ramp: "viridis",
  reversed: true,
  method: "equal-interval",
  classCount: 5,
  breaks: [0, 0.2, 0.4, 0.6, 0.8, 1],
};

describe("raster symbology render injection (continuous reverse)", () => {
  beforeEach(() => {
    useAppStore.setState({ layers: [] });
  });

  afterEach(() => {
    disposeAllRasterClassification();
    useAppStore.setState({ layers: [] });
  });

  it("flips the colormap module's reversed uniform for a reversed continuous layer", () => {
    useAppStore.getState().addLayer(rasterLayer("r1", CONTINUOUS_REVERSED));
    const control = fakeControl();
    activateRasterClassification(control);

    const props = renderColormapProps(control, "r1");
    assert.equal(props?.reversed, true);
    // The upstream named colormap is preserved; only the uniform changes.
    assert.equal(props?.colormapTexture, "upstream");
    assert.equal(props?.colormapIndex, 4);
  });

  it("leaves the pipeline untouched for a plain (non-reversed) continuous layer", () => {
    useAppStore.getState().addLayer(rasterLayer("r1"));
    const control = fakeControl();
    activateRasterClassification(control);

    assert.equal(renderColormapProps(control, "r1")?.reversed, false);
  });

  it("injects a gradient texture for a custom continuous ramp", () => {
    useAppStore.getState().addLayer(
      rasterLayer("r1", {
        classified: false,
        ramp: "viridis",
        customColors: ["#ff0000", "#0000ff"],
        reversed: false,
        method: "equal-interval",
        classCount: 5,
        breaks: [0, 1, 2, 3, 4, 5],
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

  it("stops reversing once the reverse flag is cleared", () => {
    useAppStore.getState().addLayer(rasterLayer("r1", CONTINUOUS_REVERSED));
    const control = fakeControl();
    activateRasterClassification(control);
    assert.equal(renderColormapProps(control, "r1")?.reversed, true);

    // Clearing the symbology (reverse off) drops the entry; the patch should
    // then pass the upstream pipeline straight through.
    const cleared = rasterLayer("r1");
    useAppStore.getState().updateLayer("r1", { metadata: cleared.metadata });
    assert.equal(renderColormapProps(control, "r1")?.reversed, false);
  });
});
