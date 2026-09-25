// The STAC Search control and the deck.gl COG rendering GeoLibre patches
// into it.
// Split out of maplibre-components.ts (opengeos/GeoLibre#2633).

import type * as maplibregl from "maplibre-gl";
import type { Layer } from "@deck.gl/core";
import type { MapboxOverlay } from "@deck.gl/mapbox";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, useAppStore } from "@geolibre/core";
import type {
  StacSearchControl,
  StacSearchControlOptions,
  StacSearchEventHandler,
  StacSearchItem,
} from "maplibre-gl-components";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition } from "../../types";
import { ensureMercatorProjection } from "../map-projection-utils";
import { ensureSharedDeckOverlay, setSharedDeckLayers } from "../shared-deck-overlay";
import { getComponentsConstructors, type StacSearchControlConstructor } from "./constructors";
import { isRemoteHttpUrl, type RasterBandValues } from "./shared";

const stacSearchControlPosition: GeoLibreMapControlPosition = "top-left";

const RASTER_PROXY_PATH = "/__geolibre_raster_proxy";

const STAC_SEARCH_OPTIONS = {
  backgroundColor: "hsl(var(--popover))",
  className: "geolibre-stac-search-control",
  collapsed: false,
  defaultColormap: "viridis",
  defaultRescaleMax: 10000,
  defaultRescaleMin: 0,
  defaultRgbMode: true,
  fontColor: "hsl(var(--popover-foreground))",
  maxHeight: 560,
  panelWidth: 365,
  showFootprints: true,
} satisfies StacSearchControlOptions;

const STAC_COLOR_RAMP_MODULE = {
  name: "geolibre-stac-color-ramp",
  inject: {
    "fs:DECKGL_FILTER_COLOR": `
      float v = clamp(color.r, 0.0, 1.0);
      vec3 c0 = vec3(0.267, 0.005, 0.329);
      vec3 c1 = vec3(0.283, 0.141, 0.458);
      vec3 c2 = vec3(0.254, 0.265, 0.530);
      vec3 c3 = vec3(0.207, 0.372, 0.553);
      vec3 c4 = vec3(0.164, 0.471, 0.558);
      vec3 c5 = vec3(0.128, 0.567, 0.551);
      vec3 c6 = vec3(0.135, 0.659, 0.518);
      vec3 c7 = vec3(0.267, 0.749, 0.441);
      vec3 c8 = vec3(0.478, 0.821, 0.318);
      vec3 c9 = vec3(0.741, 0.873, 0.150);
      vec3 c10 = vec3(0.993, 0.906, 0.144);
      vec3 rgb = mix(c0, c1, smoothstep(0.0, 0.1, v));
      rgb = mix(rgb, c2, smoothstep(0.1, 0.2, v));
      rgb = mix(rgb, c3, smoothstep(0.2, 0.3, v));
      rgb = mix(rgb, c4, smoothstep(0.3, 0.4, v));
      rgb = mix(rgb, c5, smoothstep(0.4, 0.5, v));
      rgb = mix(rgb, c6, smoothstep(0.5, 0.6, v));
      rgb = mix(rgb, c7, smoothstep(0.6, 0.7, v));
      rgb = mix(rgb, c8, smoothstep(0.7, 0.8, v));
      rgb = mix(rgb, c9, smoothstep(0.8, 0.9, v));
      rgb = mix(rgb, c10, smoothstep(0.9, 1.0, v));
      color = vec4(rgb, color.a);
    `,
  },
};

const STAC_COLOR_RAMP_COLORS: Record<string, string[]> = {
  cividis: [
    "vec3(0.000, 0.126, 0.302)",
    "vec3(0.188, 0.243, 0.416)",
    "vec3(0.337, 0.372, 0.431)",
    "vec3(0.505, 0.504, 0.375)",
    "vec3(0.735, 0.680, 0.308)",
    "vec3(0.996, 0.909, 0.218)",
  ],
  hot: [
    "vec3(0.041, 0.000, 0.000)",
    "vec3(0.365, 0.000, 0.000)",
    "vec3(0.729, 0.000, 0.000)",
    "vec3(1.000, 0.318, 0.000)",
    "vec3(1.000, 0.729, 0.000)",
    "vec3(1.000, 1.000, 0.700)",
  ],
  inferno: [
    "vec3(0.001, 0.000, 0.014)",
    "vec3(0.197, 0.038, 0.368)",
    "vec3(0.472, 0.111, 0.428)",
    "vec3(0.730, 0.212, 0.333)",
    "vec3(0.929, 0.472, 0.178)",
    "vec3(0.988, 0.998, 0.645)",
  ],
  magma: [
    "vec3(0.001, 0.000, 0.014)",
    "vec3(0.172, 0.067, 0.372)",
    "vec3(0.445, 0.123, 0.507)",
    "vec3(0.716, 0.215, 0.475)",
    "vec3(0.945, 0.464, 0.365)",
    "vec3(0.987, 0.991, 0.749)",
  ],
  plasma: [
    "vec3(0.050, 0.030, 0.528)",
    "vec3(0.363, 0.003, 0.649)",
    "vec3(0.611, 0.090, 0.620)",
    "vec3(0.798, 0.280, 0.470)",
    "vec3(0.929, 0.512, 0.298)",
    "vec3(0.940, 0.975, 0.131)",
  ],
  terrain: [
    "vec3(0.200, 0.200, 0.600)",
    "vec3(0.000, 0.600, 0.450)",
    "vec3(0.450, 0.700, 0.300)",
    "vec3(0.750, 0.650, 0.350)",
    "vec3(0.600, 0.450, 0.300)",
    "vec3(1.000, 1.000, 1.000)",
  ],
  turbo: [
    "vec3(0.190, 0.072, 0.232)",
    "vec3(0.252, 0.357, 0.813)",
    "vec3(0.276, 0.718, 0.650)",
    "vec3(0.663, 0.864, 0.196)",
    "vec3(0.974, 0.573, 0.040)",
    "vec3(0.480, 0.016, 0.011)",
  ],
  viridis: [
    "vec3(0.267, 0.005, 0.329)",
    "vec3(0.254, 0.265, 0.530)",
    "vec3(0.164, 0.471, 0.558)",
    "vec3(0.135, 0.659, 0.518)",
    "vec3(0.478, 0.821, 0.318)",
    "vec3(0.993, 0.906, 0.144)",
  ],
};

function getStacColorRampModule(colormap: string): typeof STAC_COLOR_RAMP_MODULE {
  const colors = STAC_COLOR_RAMP_COLORS[colormap.toLowerCase()];
  if (!colors) return STAC_COLOR_RAMP_MODULE;

  const step = 1 / (colors.length - 1);
  const mixes = colors.slice(1).map((color, index) => {
    const lower = (index * step).toFixed(3);
    const upper = ((index + 1) * step).toFixed(3);
    return `rgb = mix(rgb, ${color}, smoothstep(${lower}, ${upper}, v));`;
  });

  return {
    name: `geolibre-stac-color-ramp-${colormap.toLowerCase()}`,
    inject: {
      "fs:DECKGL_FILTER_COLOR": `
        float v = clamp(color.r, 0.0, 1.0);
        vec3 rgb = ${colors[0]};
        ${mixes.join("\n")}
        color = vec4(rgb, color.a);
      `,
    },
  };
}

let stacSearchControl: StacSearchControl | null = null;
// The host API the STAC Search control was opened with, kept so its deck.gl COG
// layers can reach the shared interleaved overlay from the patched hooks below.
let stacSearchApp: GeoLibreAppAPI | null = null;
// Store-derived `beforeId` per STAC Search deck layer id, pushed in by
// `applyStacSearchLayerOrder`. See `renderStacSearchDeckLayers`.
const stacSearchBeforeIds = new Map<string, string | undefined>();
let stacSearchControlMounted = false;
let stacSearchStoreUnsubscribe: (() => void) | null = null;

let stacCogLayerPatched = false;

interface MutableStacSearchControl {
  _addCogLayer?: (url: string, item: StacSearchItem, assetKey: string) => Promise<void>;
  _cogLayers?: Map<string, StacSearchRenderableLayer>;
  _convertS3ToHttps?: (url: string) => string;
  _deckOverlay?: MapboxOverlay | null;
  _ensureOverlay?: () => Promise<void>;
  _emit?: (type: string, detail?: Record<string, unknown>) => void;
  _layerCounter?: number;
  _map?: maplibregl.Map;
  _removeLayer?: (id?: string) => void;
  _render?: () => void;
  _state?: {
    colormap?: string;
    hasLayer?: boolean;
    isRgbMode?: boolean;
    layerCount?: number;
    rescaleMax?: number;
    rescaleMin?: number;
    rgbBands?: {
      b?: string | null;
      g?: string | null;
      r?: string | null;
    };
    selectedBand?: string | null;
    status?: string | null;
  };
}

type StacSearchRenderableLayer =
  | Layer
  | {
      layerId?: string;
      sourceId?: string;
      type?: string;
    };

interface StacSearchLayerSnapshot {
  id: string;
  layer: StacSearchRenderableLayer;
}

interface StacLayerControlPatcher {
  _patchCOGLayer?: (COGLayerClass: unknown) => void;
  _patchCOGLayerForFloat?: (COGLayerClass: unknown) => void;
  _patchCOGLayerForOpacity?: (COGLayerClass: unknown) => void;
}

interface StacCogImageLike {
  cachedTags?: {
    bitsPerSample?: ArrayLike<number>;
    nodata?: number | null;
    photometric?: number;
    sampleFormat?: ArrayLike<number>;
    samplesPerPixel?: number;
  };
  fetchTile: (
    x: number,
    y: number,
    options: {
      boundless: boolean;
      pool?: unknown;
      signal?: AbortSignal;
    },
  ) => Promise<{
    array: {
      data: RasterBandValues;
      height: number;
      layout?: string;
      mask?: Uint8Array | null;
      nodata?: number | null;
      width: number;
    };
  }>;
}

interface StacCogTileOptions {
  device: {
    createTexture: (props: Record<string, unknown>) => unknown;
  };
  pool?: unknown;
  signal?: AbortSignal;
  x: number;
  y: number;
}

interface StacCogTileData {
  byteLength: number;
  height: number;
  isRgb: boolean;
  texture: unknown;
  width: number;
}

interface StacColorStop {
  color: string;
  position: number;
}

interface StacCogRenderOptions {
  colormap: string;
  isRgbMode: boolean;
  rescaleMax: number;
  rescaleMin: number;
}

interface StacCogTextureHelper {
  inferTextureFormat?: (
    samplesPerPixel: number,
    bitsPerSample: unknown,
    sampleFormat: unknown,
  ) => string;
}

export function openStacSearchLayerPanel(app: GeoLibreAppAPI): void {
  void openStandaloneStacSearchControl(app);
}

async function openStandaloneStacSearchControl(app: GeoLibreAppAPI): Promise<boolean> {
  const { StacSearchControl: StacSearchControlClass } = await getComponentsConstructors();

  stacSearchApp = app;
  stacSearchControl ??= createStacSearchControl(StacSearchControlClass);

  if (!stacSearchControlMounted) {
    const added = app.addMapControl(stacSearchControl, stacSearchControlPosition);
    if (!added) {
      stacSearchControl = null;
      return false;
    }
    stacSearchControlMounted = true;
  }

  setTimeout(() => {
    stacSearchControl?.show();
    stacSearchControl?.expand();
  }, 0);
  return true;
}

function createStacSearchControl(
  StacSearchControlClass: StacSearchControlConstructor,
): StacSearchControl {
  const control = new StacSearchControlClass(STAC_SEARCH_OPTIONS);
  control.on("collapse", () => control.hide());
  control.on("display", createStacSearchDisplayHandler(control));
  patchStacSearchCogLayer(control);
  patchStacSearchRasterUrls(control);
  patchStacSearchRemoveLayer(control);
  stacSearchStoreUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    const currentById = new Map(state.layers.map((layer) => [layer.id, layer]));

    for (const layer of previous.layers) {
      if (!isStacSearchControlLayer(layer)) continue;

      const currentLayer = currentById.get(layer.id);
      if (!currentLayer) {
        removeStacSearchControlLayer(layer.id);
        continue;
      }

      if (!isStacSearchControlLayer(currentLayer)) continue;

      if (currentLayer.visible !== layer.visible || currentLayer.opacity !== layer.opacity) {
        setStacSearchControlLayerState(currentLayer.id, currentLayer.visible, currentLayer.opacity);
      }
    }
  });
  return control;
}

export function teardownStacSearchControl(app: GeoLibreAppAPI): void {
  stacSearchStoreUnsubscribe?.();
  stacSearchStoreUnsubscribe = null;
  if (stacSearchControl && stacSearchControlMounted) {
    app.removeMapControl(stacSearchControl);
  }
  stacSearchControl = null;
  stacSearchControlMounted = false;
  stacSearchApp = null;
  // Its deck layers live in the shared overlay, which outlives this control.
  stacSearchBeforeIds.clear();
  setSharedDeckLayers("stac-search", []);
}

function createStacSearchDisplayHandler(control: StacSearchControl): StacSearchEventHandler {
  return (event) => {
    const store = useAppStore.getState();
    for (const snapshot of getStacSearchLayerSnapshots(control)) {
      if (store.layers.some((item) => item.id === snapshot.id)) continue;

      const layer = createStacSearchStoreLayer(
        snapshot,
        event.item ?? event.state.selectedItem,
        event.state.selectedCollection?.id,
        event.state.selectedCatalog?.url,
      );
      store.addLayer(layer);
    }
  };
}

function createStacSearchStoreLayer(
  snapshot: StacSearchLayerSnapshot,
  item?: StacSearchItem | null,
  collectionId?: string,
  catalogUrl?: string,
): GeoLibreLayer {
  const rasterLayerInfo = getStacSearchRasterLayerInfo(snapshot.layer);
  const deckLayerProps = "props" in snapshot.layer ? snapshot.layer.props : {};
  const sourceKind = rasterLayerInfo ? "stac-search-raster" : "stac-search-cog";
  const url = rasterLayerInfo?.tileUrl ?? getDeckLayerSourceUrl(snapshot.layer);
  const nativeLayerIds = rasterLayerInfo ? [rasterLayerInfo.layerId] : [snapshot.id];
  const sourceId = rasterLayerInfo?.sourceId ?? snapshot.id;

  return {
    id: snapshot.id,
    name: stacSearchLayerName(snapshot.id, item, collectionId),
    type: rasterLayerInfo ? "raster" : "cog",
    source: {
      bounds: item?.bbox,
      catalogUrl,
      collectionId,
      itemId: item?.id,
      sourceId,
      type: "raster",
      url,
    },
    visible: true,
    opacity: getStacSearchLayerOpacity(snapshot.layer),
    style: {
      ...DEFAULT_LAYER_STYLE,
      fillOpacity: 1,
    },
    metadata: {
      collectionId,
      customLayerType: "raster",
      // The COG variant renders as a deck.gl layer with no MapLibre style layer
      // to move, so layer-sync must hand its computed `beforeId` to the control
      // instead of calling `moveLayer` (#1718). The raster-tile variant is a
      // real style layer and reorders normally.
      ...(rasterLayerInfo ? {} : { externalDeckLayer: true }),
      externalNativeLayer: true,
      identifiable: false,
      nativeLayerIds,
      sourceId,
      sourceIds: [sourceId],
      sourceKind,
      stacAsset: stacAssetFromLayerId(snapshot.id),
      stacCatalogUrl: catalogUrl,
      stacItemId: item?.id,
      tileType: "raster",
      ...(item?.bbox ? { bounds: item.bbox } : {}),
      ...(deckLayerProps && typeof deckLayerProps === "object" && "_colormap" in deckLayerProps
        ? { colormap: deckLayerProps._colormap }
        : {}),
    },
    sourcePath: url,
  };
}

function isStacSearchControlLayer(layer: GeoLibreLayer): boolean {
  return (
    (layer.type === "cog" || layer.type === "raster") &&
    (layer.metadata.sourceKind === "stac-search-cog" ||
      layer.metadata.sourceKind === "stac-search-raster") &&
    layer.metadata.externalNativeLayer === true
  );
}

function getStacSearchLayerSnapshots(control: StacSearchControl): StacSearchLayerSnapshot[] {
  const mutableControl = control as unknown as MutableStacSearchControl;
  return Array.from(mutableControl._cogLayers?.entries() ?? []).map(([id, layer]) => ({
    id,
    layer,
  }));
}

function patchStacSearchRemoveLayer(control: StacSearchControl): void {
  const mutableControl = control as unknown as MutableStacSearchControl;
  const removeLayer = mutableControl._removeLayer?.bind(control);
  if (!removeLayer) return;

  mutableControl._removeLayer = (id?: string) => {
    const layerIds = id ? [id] : Array.from(mutableControl._cogLayers?.keys() ?? []);
    removeLayer(id);
    // Upstream repaints its own overlay, which GeoLibre bypasses, so drop the
    // removed layers from the shared interleaved overlay here (#1718).
    for (const layerId of layerIds) stacSearchBeforeIds.delete(layerId);
    renderStacSearchDeckLayers();
    const store = useAppStore.getState();
    for (const layerId of layerIds) {
      const layer = store.layers.find((item) => item.id === layerId);
      if (layer && isStacSearchControlLayer(layer)) {
        store.removeLayer(layerId);
      }
    }
  };
}

function patchStacSearchRasterUrls(control: StacSearchControl): void {
  const mutableControl = control as unknown as MutableStacSearchControl;
  const convertS3ToHttps = mutableControl._convertS3ToHttps?.bind(control);
  if (!convertS3ToHttps) return;

  mutableControl._convertS3ToHttps = (url: string) =>
    proxyDevRasterUrl(normalizeStacRasterUrl(convertS3ToHttps(url)));
}

function patchStacSearchCogLayer(control: StacSearchControl): void {
  const mutableControl = control as unknown as MutableStacSearchControl;
  if (
    !mutableControl._ensureOverlay ||
    !mutableControl._convertS3ToHttps ||
    !mutableControl._cogLayers
  ) {
    return;
  }

  mutableControl._addCogLayer = async (url: string, item: StacSearchItem, assetKey: string) => {
    ensureMercatorProjection(mutableControl._map);
    // Deliberately NOT `_ensureOverlay()`: that builds the control's own
    // non-interleaved overlay, which can never be ordered against the style.
    // The shared interleaved overlay renders these layers instead (#1718).
    if (stacSearchApp) await ensureSharedDeckOverlay(stacSearchApp);
    const selectedAsset = getStacSearchSelectedAsset(mutableControl, item, {
      key: assetKey,
      url,
    });
    const layerUrl = normalizeStacRasterUrl(
      mutableControl._convertS3ToHttps?.(selectedAsset.url) ?? selectedAsset.url,
    );
    const { COGLayer: COGLayerClass, texture } = await import("@developmentseed/deck.gl-geotiff");
    const renderProps = await createStacCogRenderProps(
      texture,
      getStacSearchRenderOptions(mutableControl),
    );
    await patchStacSearchCOGLayerClass(COGLayerClass);
    const layerCounter = mutableControl._layerCounter ?? 0;
    mutableControl._layerCounter = layerCounter + 1;
    const id = `stac-search-${item.id}-${selectedAsset.key}-${layerCounter}`;
    const CogLayerConstructor = COGLayerClass as unknown as {
      new (props: Record<string, unknown>): Layer;
    };
    const layer = new CogLayerConstructor({
      geotiff: layerUrl,
      id,
      opacity: 1,
      ...renderProps,
    });
    mutableControl._cogLayers?.set(id, layer as unknown as Layer);
    renderStacSearchDeckLayers();
    if (mutableControl._state) {
      mutableControl._state.hasLayer = true;
      mutableControl._state.layerCount = mutableControl._cogLayers?.size ?? 0;
      mutableControl._state.status = `Displayed: ${id}`;
    }
    mutableControl._render?.();
    mutableControl._emit?.("display", {
      assetKey: selectedAsset.key,
      item,
      layerId: id,
      url: selectedAsset.url,
    });
  };
}

function getStacSearchSelectedAsset(
  control: MutableStacSearchControl,
  item: StacSearchItem,
  fallback: { key: string; url: string },
): { key: string; url: string } {
  const state = control._state;
  if (state?.isRgbMode !== false) return fallback;
  const selectedBand = state.selectedBand;
  if (!selectedBand) return fallback;
  const asset = getStacAsset(item, selectedBand);
  return asset?.href ? { key: selectedBand, url: asset.href } : fallback;
}

function getStacAsset(item: StacSearchItem, key: string): { href?: string } | null {
  const assets = (item as { assets?: Record<string, unknown> }).assets;
  const asset = assets?.[key];
  if (!asset || typeof asset !== "object") return null;
  return asset as { href?: string };
}

function getStacSearchRenderOptions(control: MutableStacSearchControl): StacCogRenderOptions {
  const state = control._state;
  return {
    colormap: state?.colormap ?? STAC_SEARCH_OPTIONS.defaultColormap,
    isRgbMode: state?.isRgbMode ?? STAC_SEARCH_OPTIONS.defaultRgbMode,
    rescaleMax: state?.rescaleMax ?? STAC_SEARCH_OPTIONS.defaultRescaleMax,
    rescaleMin: state?.rescaleMin ?? STAC_SEARCH_OPTIONS.defaultRescaleMin,
  };
}

async function createStacCogRenderProps(
  texture: unknown,
  renderOptions: StacCogRenderOptions,
): Promise<{
  getTileData: (image: StacCogImageLike, options: StacCogTileOptions) => Promise<StacCogTileData>;
  renderTile: (tileData: StacCogTileData) => {
    renderPipeline: Array<{ module: unknown; props?: Record<string, unknown> }>;
  };
}> {
  const { BlackIsZero, CreateTexture, FilterNoDataVal, LinearRescale } =
    await import("@developmentseed/deck.gl-raster/gpu-modules");
  const { getColormap } = (await import("maplibre-gl-components")) as {
    getColormap?: (name: string) => StacColorStop[];
  };
  const inferTextureFormat = (texture as StacCogTextureHelper).inferTextureFormat;

  return {
    getTileData: async (image, options) => {
      const { x, y, device, pool, signal } = options;
      const tile = await image.fetchTile(x, y, {
        boundless: false,
        pool,
        signal,
      });
      const { data, height, layout, mask, nodata, width } = tile.array;
      if (layout === "band-separate") {
        throw new Error("Band-separate GeoTIFF tiles are not supported.");
      }
      const tags = image.cachedTags;
      let samplesPerPixel = tags?.samplesPerPixel ?? 1;
      const bitsPerSample = tags?.bitsPerSample ?? [8];
      const sampleFormat = tags?.sampleFormat ?? [1];
      let textureData: RasterBandValues;
      let textureBitsPerSample = bitsPerSample;
      let textureSampleFormat = sampleFormat;
      let textureFormat: string | undefined;

      if (samplesPerPixel === 1) {
        textureData = createStacSingleBandRgba(data, width, height, {
          colormap: renderOptions.colormap,
          getColormap,
          mask,
          nodata: nodata ?? tags?.nodata ?? null,
          rescaleMax: renderOptions.rescaleMax,
          rescaleMin: renderOptions.rescaleMin,
        });
        samplesPerPixel = 4;
        textureBitsPerSample = [8, 8, 8, 8];
        textureSampleFormat = [1, 1, 1, 1];
        textureFormat = "rgba8unorm";
      } else if (samplesPerPixel === 3) {
        textureData = addOpaqueAlphaChannel(data, width, height, bitsPerSample);
        samplesPerPixel = 4;
      } else {
        textureData = data;
      }

      const format =
        textureFormat ??
        inferTextureFormat?.(samplesPerPixel, textureBitsPerSample, textureSampleFormat) ??
        "r8unorm";
      const textureObject = device.createTexture({
        data: textureData,
        format,
        height,
        sampler: {
          magFilter: "linear",
          minFilter: "linear",
        },
        width,
      });

      return {
        byteLength: textureData.byteLength,
        height,
        isRgb: samplesPerPixel >= 3,
        texture: textureObject,
        width,
      };
    },
    renderTile: (tileData) => {
      const renderPipeline: Array<{
        module: unknown;
        props?: Record<string, unknown>;
      }> = [
        {
          module: CreateTexture,
          props: { textureName: tileData.texture },
        },
      ];
      if (tileData.isRgb) {
        return { renderPipeline };
      }
      const nodata = getStacCogShaderNoData();
      if (nodata !== null) {
        renderPipeline.push({
          module: FilterNoDataVal,
          props: { value: nodata },
        });
      }
      renderPipeline.push({
        module: LinearRescale,
        props: {
          rescaleMax: renderOptions.rescaleMax,
          rescaleMin: renderOptions.rescaleMin,
        },
      });
      renderPipeline.push(
        renderOptions.colormap === "none"
          ? { module: BlackIsZero }
          : { module: getStacColorRampModule(renderOptions.colormap) },
      );
      return { renderPipeline };
    },
  };
}

function createStacSingleBandRgba(
  data: RasterBandValues,
  width: number,
  height: number,
  options: {
    colormap: string;
    getColormap?: (name: string) => StacColorStop[];
    mask?: Uint8Array | null;
    nodata?: number | null;
    rescaleMax: number;
    rescaleMin: number;
  },
): Uint8Array {
  const pixelCount = width * height;
  const output = new Uint8Array(pixelCount * 4);
  const range = options.rescaleMax - options.rescaleMin || 1;
  const stops = getStacColormapStops(options.colormap, options.getColormap);

  for (let index = 0; index < pixelCount; index += 1) {
    const rawValue = Number(data[index]);
    const target = index * 4;
    if (
      options.mask?.[index] === 0 ||
      !Number.isFinite(rawValue) ||
      (options.nodata !== null && options.nodata !== undefined && rawValue === options.nodata)
    ) {
      output[target] = 0;
      output[target + 1] = 0;
      output[target + 2] = 0;
      output[target + 3] = 0;
      continue;
    }

    const normalized = Math.max(0, Math.min(1, (rawValue - options.rescaleMin) / range));
    const color = stops
      ? interpolateStacColormap(stops, normalized)
      : [normalized * 255, normalized * 255, normalized * 255];

    output[target] = Math.round(color[0]);
    output[target + 1] = Math.round(color[1]);
    output[target + 2] = Math.round(color[2]);
    output[target + 3] = 255;
  }

  return output;
}

function getStacColormapStops(
  colormap: string,
  getColormap?: (name: string) => StacColorStop[],
): StacColorStop[] | null {
  if (colormap === "none") return null;
  try {
    const stops = getColormap?.(colormap);
    if (stops?.length) return stops;
  } catch {
    // Fall back to the local shader ramp approximations below.
  }

  const colors = STAC_COLOR_RAMP_COLORS[colormap.toLowerCase()];
  if (!colors) return null;
  return colors.map((color, index) => ({
    color,
    position: colors.length === 1 ? 0 : index / (colors.length - 1),
  }));
}

function interpolateStacColormap(stops: StacColorStop[], value: number): [number, number, number] {
  const sortedStops = stops.slice().sort((left, right) => left.position - right.position);
  const first = sortedStops[0];
  const last = sortedStops[sortedStops.length - 1];
  if (!first || !last) return [0, 0, 0];
  if (value <= first.position) return parseStacColor(first.color);
  if (value >= last.position) return parseStacColor(last.color);

  for (let index = 1; index < sortedStops.length; index += 1) {
    const upper = sortedStops[index];
    const lower = sortedStops[index - 1];
    if (!upper || !lower || value > upper.position) continue;
    const span = upper.position - lower.position || 1;
    const amount = (value - lower.position) / span;
    const lowerColor = parseStacColor(lower.color);
    const upperColor = parseStacColor(upper.color);
    return [
      lowerColor[0] + (upperColor[0] - lowerColor[0]) * amount,
      lowerColor[1] + (upperColor[1] - lowerColor[1]) * amount,
      lowerColor[2] + (upperColor[2] - lowerColor[2]) * amount,
    ];
  }

  return parseStacColor(last.color);
}

function parseStacColor(color: string): [number, number, number] {
  const hex = color.trim().match(/^#?([0-9a-f]{6})$/i)?.[1];
  if (hex) {
    return [
      Number.parseInt(hex.slice(0, 2), 16),
      Number.parseInt(hex.slice(2, 4), 16),
      Number.parseInt(hex.slice(4, 6), 16),
    ];
  }

  const rgb = color.match(/(?:rgb|vec3)\(([\d.]+),\s*([\d.]+),\s*([\d.]+)\)/i);
  if (!rgb) return [0, 0, 0];
  const values = rgb.slice(1, 4).map(Number);
  const scale = values.some((value) => value > 1) ? 1 : 255;
  return [
    Math.round((values[0] ?? 0) * scale),
    Math.round((values[1] ?? 0) * scale),
    Math.round((values[2] ?? 0) * scale),
  ];
}

function addOpaqueAlphaChannel(
  data: RasterBandValues,
  width: number,
  height: number,
  bitsPerSample: ArrayLike<number>,
): RasterBandValues {
  const pixelCount = width * height;
  const Constructor = data.constructor as {
    new (length: number): RasterBandValues;
  };
  const output = new Constructor(pixelCount * 4);
  const alpha = getAlphaValue(data, bitsPerSample);
  for (let index = 0; index < pixelCount; index += 1) {
    const source = index * 3;
    const target = index * 4;
    output[target] = data[source];
    output[target + 1] = data[source + 1];
    output[target + 2] = data[source + 2];
    output[target + 3] = alpha;
  }
  return output;
}

function getAlphaValue(data: RasterBandValues, bitsPerSample: ArrayLike<number>): number {
  if (data instanceof Float32Array || data instanceof Float64Array) return 1;
  const bits = bitsPerSample[0] ?? 8;
  return bits >= 16 ? 65535 : 255;
}

function getStacCogShaderNoData(): number | null {
  return null;
}

async function patchStacSearchCOGLayerClass(COGLayerClass: unknown): Promise<void> {
  if (stacCogLayerPatched) return;
  const { CogLayerControl: CogLayerControlClass, StacLayerControl: StacLayerControlClass } =
    await import("maplibre-gl-components");
  const stacPatcher = new StacLayerControlClass({}) as unknown as StacLayerControlPatcher;
  const cogPatcher = new CogLayerControlClass({}) as unknown as StacLayerControlPatcher;
  stacPatcher._patchCOGLayer?.(COGLayerClass);
  cogPatcher._patchCOGLayerForFloat?.(COGLayerClass);
  cogPatcher._patchCOGLayerForOpacity?.(COGLayerClass);
  stacCogLayerPatched = true;
}

function removeStacSearchControlLayer(id: string): void {
  const mutableControl = stacSearchControl as unknown as MutableStacSearchControl | null;
  mutableControl?._removeLayer?.(id);
}

function setStacSearchControlLayerState(id: string, visible: boolean, opacity: number): void {
  const mutableControl = stacSearchControl as unknown as MutableStacSearchControl | null;
  const layer = mutableControl?._cogLayers?.get(id);
  if (!layer) return;

  const appliedOpacity = visible ? opacity : 0;
  const rasterLayerInfo = getStacSearchRasterLayerInfo(layer);
  if (rasterLayerInfo) {
    const map = (stacSearchControl as unknown as MutableStacSearchControl | null)?._map;
    try {
      map?.setLayoutProperty(rasterLayerInfo.layerId, "visibility", visible ? "visible" : "none");
      map?.setPaintProperty(rasterLayerInfo.layerId, "raster-opacity", appliedOpacity);
    } catch {
      // The layer may have been removed by the upstream control.
    }
    return;
  }

  if (!("clone" in layer) || typeof layer.clone !== "function") return;

  mutableControl?._cogLayers?.set(
    id,
    layer.clone({ opacity: appliedOpacity }) as StacSearchRenderableLayer,
  );
  renderStacSearchDeckLayers();
}

function getStacSearchDeckLayers(control: MutableStacSearchControl): Layer[] {
  return Array.from(control._cogLayers?.values() ?? []).filter(
    (layer): layer is Layer => !getStacSearchRasterLayerInfo(layer),
  );
}

/**
 * Pushes the STAC Search control's deck.gl COG layers into GeoLibre's shared
 * interleaved overlay, each carrying the `beforeId` derived from the store's
 * layer order.
 *
 * Upstream renders them through the control's own non-interleaved
 * `MapboxOverlay`, which owns a separate canvas stacked above the entire
 * MapLibre style — so STAC imagery covered every vector layer no matter where
 * the user placed it in the Layers panel (opengeos/GeoLibre#1718). Interleaved
 * layers are drawn inside the style instead, at the depth their `beforeId`
 * selects, which is what makes panel order mean anything for them.
 */
function renderStacSearchDeckLayers(): void {
  const control = stacSearchControl as unknown as MutableStacSearchControl | null;
  if (!control) return;
  const layers = getStacSearchDeckLayers(control).map((layer) => {
    const beforeId = stacSearchBeforeIds.get(layer.id);
    if ((layer.props as { beforeId?: string }).beforeId === beforeId) return layer;
    return layer.clone({ beforeId } as unknown as Partial<Layer["props"]>);
  });
  setSharedDeckLayers("stac-search", layers);
}

/**
 * Applies a store-derived draw order to a STAC Search deck.gl COG layer.
 *
 * Registered by the app shell as part of the external deck-layer order handler:
 * such a layer is not a real MapLibre style layer, so `moveLayer` cannot reorder
 * it and layer-sync forwards the computed `beforeId` here instead.
 *
 * @param layerId - The store layer id, which doubles as the deck layer id.
 * @param beforeId - The style layer to draw beneath, or undefined for the top.
 * @returns True when the id belongs to the STAC Search control.
 */
export function applyStacSearchLayerOrder(layerId: string, beforeId: string | undefined): boolean {
  const control = stacSearchControl as unknown as MutableStacSearchControl | null;
  const layer = control?._cogLayers?.get(layerId);
  if (!layer || getStacSearchRasterLayerInfo(layer)) return false;
  if (stacSearchBeforeIds.get(layerId) === beforeId) return true;
  stacSearchBeforeIds.set(layerId, beforeId);
  renderStacSearchDeckLayers();
  return true;
}

function getStacSearchRasterLayerInfo(
  layer: StacSearchRenderableLayer,
): { layerId: string; sourceId: string; tileUrl?: string } | null {
  if (!("type" in layer) || layer.type !== "raster") return null;
  if (typeof layer.layerId !== "string" || typeof layer.sourceId !== "string") {
    return null;
  }
  const map = (stacSearchControl as unknown as MutableStacSearchControl | null)?._map;
  const source = map?.getSource(layer.sourceId) as { tiles?: string[] } | undefined;
  return {
    layerId: layer.layerId,
    sourceId: layer.sourceId,
    tileUrl: source?.tiles?.[0],
  };
}

function getDeckLayerSourceUrl(layer: StacSearchRenderableLayer): string {
  if (!("props" in layer)) return "";
  const props = layer.props as Record<string, unknown> | undefined;
  const geotiff = props?.geotiff;
  if (typeof geotiff === "string") return geotiff;
  const sourceUrl = props?.sourceUrl;
  return typeof sourceUrl === "string" ? sourceUrl : "";
}

function normalizeStacRasterUrl(url: string): string {
  return url.replace(
    "copernicus-dem-30m.s3.us-east-1.amazonaws.com",
    "copernicus-dem-30m.s3.eu-central-1.amazonaws.com",
  );
}

function proxyDevRasterUrl(url: string): string {
  if (!isLocalDevHost() || !isRemoteHttpUrl(url)) return url;
  return `${RASTER_PROXY_PATH}?url=${encodeURIComponent(url)}`;
}

function isLocalDevHost(): boolean {
  if (typeof window === "undefined") return false;
  return ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
}

function getStacSearchLayerOpacity(layer: StacSearchRenderableLayer): number {
  if ("props" in layer && typeof layer.props?.opacity === "number") {
    return layer.props.opacity;
  }
  return 1;
}

function stacSearchLayerName(
  id: string,
  item?: StacSearchItem | null,
  collectionId?: string,
): string {
  return [collectionId, item?.id, stacAssetFromLayerId(id)].filter(Boolean).join(" - ") || id;
}

function stacAssetFromLayerId(id: string): string | undefined {
  if (id.startsWith("stac-search-pc-")) return undefined;
  const parts = id.split("-");
  if (parts.length < 4) return undefined;
  return parts[parts.length - 2];
}
