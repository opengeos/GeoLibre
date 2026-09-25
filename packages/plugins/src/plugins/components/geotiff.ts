// The generic GeoTIFF raster overlay, the fallback renderer for rasters the
// COG control cannot load (local files, non-COG TIFFs).
// Split out of maplibre-components.ts (opengeos/GeoLibre#2633).

import proj4 from "proj4";
import type { Layer } from "@deck.gl/core";
import type { MapboxOverlay } from "@deck.gl/mapbox";
import { RasterLayer, type RasterLayerProps } from "@developmentseed/deck.gl-raster";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, useAppStore } from "@geolibre/core";
import { fromArrayBuffer } from "geotiff";
import type { GeoLibreAppAPI } from "../../types";
import {
  cogRasterControlPosition,
  type CogRasterLayerOptions,
  layerNameFromUrl,
  type RasterBandValues,
} from "./shared";

let geoTiffRasterOverlay: MapboxOverlay | null = null;
let geoTiffRasterOverlayMounted = false;
let geoTiffRasterStoreUnsubscribe: (() => void) | null = null;

const geoTiffRasterLayerProps = new Map<string, GeoTiffRasterLayerState>();
const geoTiffRasterLayers = new Map<string, Layer>();
let geoTiffRasterLayerSequence = 0;

let stacGeoKeysParserPromise: Promise<StacGeoKeysParser> | null = null;

interface GeoTiffRasterLayerState {
  bounds?: [number, number, number, number];
  id: string;
  raster: GeoTiffRasterData;
  name: string;
  opacity: number;
  options: CogRasterLayerOptions;
  url: string;
  visible: boolean;
}

interface GeoTiffRasterData {
  height: number;
  image: ImageData;
  reprojectionFns: RasterLayerProps["reprojectionFns"];
  width: number;
}

interface GeoTiffImageLike {
  getHeight: () => number;
  getOrigin: () => number[];
  getResolution: () => number[];
  getWidth: () => number;
}

type StacGeoKeysParser = (geoKeys: Record<string, unknown>) => Promise<{
  coordinatesUnits: string;
  def: string;
  parsed: Record<string, unknown>;
} | null>;

export function teardownGeoTiffRasterOverlay(app: GeoLibreAppAPI): void {
  geoTiffRasterStoreUnsubscribe?.();
  geoTiffRasterStoreUnsubscribe = null;
  geoTiffRasterLayerProps.clear();
  geoTiffRasterLayers.clear();
  updateGeoTiffRasterOverlayLayers();
  if (geoTiffRasterOverlay && geoTiffRasterOverlayMounted) {
    app.removeMapControl(geoTiffRasterOverlay);
  }
  geoTiffRasterOverlay = null;
  geoTiffRasterOverlayMounted = false;
}

export async function addGeoTiffRasterLayer(
  app: GeoLibreAppAPI,
  options: CogRasterLayerOptions,
  cause: unknown = undefined,
): Promise<string> {
  const overlay = await ensureGeoTiffRasterOverlay(app);
  if (!overlay) {
    throw new Error("The generic GeoTIFF raster overlay could not be added to the map.", { cause });
  }

  const id = createGeoTiffRasterLayerId();
  const url = options.url.trim();
  const name = options.name?.trim() || layerNameFromUrl(url, id);
  const rasterInput = await fetchGeoTiffRasterInput(app, options, url, cause);
  const { bounds, raster } = await loadGeoTiffRasterData(rasterInput, options);
  const { data: _data, ...stateOptions } = options;
  const state: GeoTiffRasterLayerState = {
    bounds,
    id,
    name,
    opacity: options.opacity ?? 1,
    options: {
      ...stateOptions,
      url,
    },
    raster,
    url,
    visible: true,
  };

  geoTiffRasterLayerProps.set(id, state);
  geoTiffRasterLayers.set(id, createGeoTiffDeckLayer(state));
  updateGeoTiffRasterOverlayLayers();
  addOrUpdateGeoTiffStoreLayer(state);
  app.fitBounds?.(bounds);
  return id;
}

async function ensureGeoTiffRasterOverlay(app: GeoLibreAppAPI): Promise<MapboxOverlay | null> {
  const { MapboxOverlay: MapboxOverlayClass } = await import("@deck.gl/mapbox");
  geoTiffRasterOverlay ??= new MapboxOverlayClass({
    interleaved: false,
    layers: [],
  });

  if (!geoTiffRasterOverlayMounted) {
    const added = app.addMapControl(geoTiffRasterOverlay, cogRasterControlPosition);
    if (!added) {
      geoTiffRasterOverlay = null;
      return null;
    }
    geoTiffRasterOverlayMounted = true;
  }

  geoTiffRasterStoreUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    const currentById = new Map(state.layers.map((layer) => [layer.id, layer]));

    for (const layer of previous.layers) {
      if (!isGeoTiffRasterLayer(layer)) continue;

      const currentLayer = currentById.get(layer.id);
      if (!currentLayer) {
        geoTiffRasterLayerProps.delete(layer.id);
        geoTiffRasterLayers.delete(layer.id);
        continue;
      }

      if (!isGeoTiffRasterLayer(currentLayer)) continue;

      if (currentLayer.visible !== layer.visible || currentLayer.opacity !== layer.opacity) {
        const rasterState = geoTiffRasterLayerProps.get(layer.id);
        if (!rasterState) continue;
        rasterState.visible = currentLayer.visible;
        rasterState.opacity = currentLayer.opacity;
        geoTiffRasterLayerProps.set(layer.id, rasterState);
        geoTiffRasterLayers.set(layer.id, createGeoTiffDeckLayer(rasterState));
      }
    }

    updateGeoTiffRasterOverlayLayers();
  });

  return geoTiffRasterOverlay;
}

async function fetchGeoTiffRasterInput(
  app: GeoLibreAppAPI,
  options: CogRasterLayerOptions,
  url: string,
  cause: unknown,
): Promise<ArrayBuffer> {
  if (options.data) return options.data;

  if (app.fetchArrayBuffer) {
    try {
      return await app.fetchArrayBuffer(url);
    } catch (error) {
      throw new Error("The raster URL could not be fetched.", {
        cause: error || cause,
      });
    }
  }

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return await response.arrayBuffer();
  } catch (error) {
    throw new Error("The raster URL could not be fetched.", {
      cause: error || cause,
    });
  }
}

async function loadGeoTiffRasterData(
  input: ArrayBuffer,
  options: CogRasterLayerOptions,
): Promise<{
  bounds: [number, number, number, number];
  raster: GeoTiffRasterData;
}> {
  const tiff = await fromArrayBuffer(input);
  const image = await tiff.getImage();
  const projection = await parseGeoTiffProjection(image.getGeoKeys() ?? {});
  if (!projection) {
    throw new Error("Could not determine the GeoTIFF projection.");
  }

  const imageBounds = image.getBoundingBox();
  if (imageBounds.length !== 4) {
    throw new Error("Could not determine the GeoTIFF bounds.");
  }
  const bounds = getGeoTiffGeographicBounds(
    imageBounds as [number, number, number, number],
    projection.def,
  );
  const reprojectionFns = createGeoTiffReprojectionFns(image, projection.def);
  const sampleCount = image.getSamplesPerPixel();
  const sample = Math.min(getFirstRasterBand(options.bands), sampleCount - 1);
  const bandValues = (await image.readRasters({
    interleave: true,
    samples: [sample],
  })) as RasterBandValues & { height?: number; width?: number };
  const width = bandValues.width ?? image.getWidth();
  const height = bandValues.height ?? image.getHeight();
  const imageData = createRasterImageData(bandValues, width, height, options);

  return {
    bounds,
    raster: {
      height,
      image: imageData,
      reprojectionFns,
      width,
    },
  };
}

async function parseGeoTiffProjection(
  geoKeys: Record<string, unknown>,
): Promise<Awaited<ReturnType<StacGeoKeysParser>>> {
  const parser = await getStacGeoKeysParser();
  return parser(geoKeys);
}

function createGeoTiffReprojectionFns(
  image: GeoTiffImageLike,
  sourceProjection: Parameters<typeof proj4>[0],
): RasterLayerProps["reprojectionFns"] {
  const [originX, originY] = image.getOrigin();
  const [resolutionX, resolutionY] = image.getResolution();
  const converter = proj4(sourceProjection, "EPSG:4326");

  return {
    forwardTransform: (x, y) => [originX + x * resolutionX, originY + y * resolutionY],
    inverseTransform: (x, y) => [(x - originX) / resolutionX, (y - originY) / resolutionY],
    forwardReproject: (x, y) => converter.forward([x, y]),
    inverseReproject: (x, y) => converter.inverse([x, y]),
  };
}

function getFirstRasterBand(bands: string | undefined): number {
  const parsed = Number.parseInt(bands?.split(",")[0]?.trim() || "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed - 1 : 0;
}

function createRasterImageData(
  values: RasterBandValues,
  width: number,
  height: number,
  options: CogRasterLayerOptions,
): ImageData {
  const stats = getRasterValueStats(values, options.nodata);
  const useAutoScale =
    (options.rescaleMin ?? 0) === 0 && (options.rescaleMax ?? 255) === 255 && stats.max > 255;
  const min = useAutoScale ? stats.min : (options.rescaleMin ?? stats.min);
  const max = useAutoScale ? stats.max : (options.rescaleMax ?? stats.max);
  const scale = max > min ? max - min : 1;
  const pixels = new Uint8ClampedArray(width * height * 4);

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const pixelIndex = index * 4;
    if (!Number.isFinite(value) || (options.nodata !== undefined && value === options.nodata)) {
      pixels[pixelIndex + 3] = 0;
      continue;
    }

    const normalized = Math.max(0, Math.min(1, (value - min) / scale));
    const [red, green, blue] = colorFromRasterValue(normalized, options.colormap);
    pixels[pixelIndex] = red;
    pixels[pixelIndex + 1] = green;
    pixels[pixelIndex + 2] = blue;
    pixels[pixelIndex + 3] = 255;
  }

  return new ImageData(pixels, width, height);
}

function getRasterValueStats(
  values: RasterBandValues,
  nodata: number | undefined,
): { max: number; min: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!Number.isFinite(value) || (nodata !== undefined && value === nodata)) {
      continue;
    }
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: 0, max: 1 };
  }
  return { min, max };
}

function colorFromRasterValue(
  value: number,
  colormap: CogRasterLayerOptions["colormap"],
): [number, number, number] {
  if (colormap === "terrain") {
    return interpolateColorRamp(value, [
      [51, 102, 51],
      [180, 170, 120],
      [255, 255, 255],
    ]);
  }
  if (colormap === "viridis") {
    return interpolateColorRamp(value, [
      [68, 1, 84],
      [33, 145, 140],
      [253, 231, 37],
    ]);
  }
  if (colormap === "plasma") {
    return interpolateColorRamp(value, [
      [13, 8, 135],
      [203, 71, 119],
      [240, 249, 33],
    ]);
  }
  if (colormap === "inferno" || colormap === "magma") {
    return interpolateColorRamp(value, [
      [0, 0, 4],
      [187, 55, 84],
      [252, 255, 164],
    ]);
  }
  if (colormap === "cividis") {
    return interpolateColorRamp(value, [
      [0, 34, 77],
      [126, 124, 120],
      [255, 233, 69],
    ]);
  }
  if (colormap === "turbo" || colormap === "jet") {
    return interpolateColorRamp(value, [
      [48, 18, 59],
      [33, 145, 140],
      [253, 231, 37],
      [122, 4, 3],
    ]);
  }
  const gray = Math.round(value * 255);
  return [gray, gray, gray];
}

function interpolateColorRamp(
  value: number,
  stops: [number, number, number][],
): [number, number, number] {
  if (stops.length === 1) return stops[0];
  const scaled = value * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(scaled));
  const ratio = scaled - index;
  const start = stops[index];
  const end = stops[index + 1];
  return [
    Math.round(start[0] + (end[0] - start[0]) * ratio),
    Math.round(start[1] + (end[1] - start[1]) * ratio),
    Math.round(start[2] + (end[2] - start[2]) * ratio),
  ];
}

function getGeoTiffGeographicBounds(
  projectedBounds: [number, number, number, number],
  sourceProjection: Parameters<typeof proj4>[0],
): [number, number, number, number] {
  const converter = proj4(sourceProjection, "EPSG:4326");
  const [minX, minY, maxX, maxY] = projectedBounds;
  const corners = [
    converter.forward([minX, minY]),
    converter.forward([maxX, minY]),
    converter.forward([maxX, maxY]),
    converter.forward([minX, maxY]),
  ];
  const longitudes = corners.map(([longitude]) => longitude);
  const latitudes = corners.map(([, latitude]) => latitude);
  return [
    Math.min(...longitudes),
    Math.min(...latitudes),
    Math.max(...longitudes),
    Math.max(...latitudes),
  ];
}

function createGeoTiffDeckLayer(state: GeoTiffRasterLayerState): Layer {
  return new RasterLayer({
    id: state.id,
    image: state.raster.image,
    height: state.raster.height,
    opacity: state.visible ? state.opacity : 0,
    pickable: false,
    reprojectionFns: state.raster.reprojectionFns,
    width: state.raster.width,
  }) as unknown as Layer;
}

function updateGeoTiffRasterOverlayLayers(): void {
  geoTiffRasterOverlay?.setProps({
    layers: Array.from(geoTiffRasterLayers.values()),
  });
}

function addOrUpdateGeoTiffStoreLayer(state: GeoTiffRasterLayerState): void {
  const store = useAppStore.getState();
  const layer = createGeoTiffRasterStoreLayer(state);
  if (store.layers.some((item) => item.id === layer.id)) {
    store.updateLayer(layer.id, {
      metadata: layer.metadata,
      opacity: layer.opacity,
      source: layer.source,
      style: layer.style,
      visible: layer.visible,
    });
    return;
  }
  store.addLayer(layer, state.options.beforeLayerId);
}

function createGeoTiffRasterStoreLayer(state: GeoTiffRasterLayerState): GeoLibreLayer {
  const bands = state.options.bands?.trim() || "1";
  const colormap = state.options.colormap ?? "none";
  const rescaleMin = state.options.rescaleMin ?? 0;
  const rescaleMax = state.options.rescaleMax ?? 255;
  const nodata = state.options.nodata;

  return {
    id: state.id,
    name: state.name,
    type: "cog",
    source: {
      bands,
      bounds: state.bounds,
      colormap,
      nodata,
      rescaleMax,
      rescaleMin,
      sourceId: state.id,
      type: "raster",
      url: state.url,
    },
    visible: state.visible,
    opacity: state.opacity,
    style: {
      ...DEFAULT_LAYER_STYLE,
      fillOpacity: 1,
    },
    metadata: {
      bands,
      colormap,
      customLayerType: "raster",
      externalNativeLayer: true,
      identifiable: false,
      nativeLayerIds: [state.id],
      nodata,
      rasterFormat: "geotiff",
      rescaleMax,
      rescaleMin,
      sourceId: state.id,
      sourceKind: "geotiff-url",
      tileType: "raster",
    },
    sourcePath: state.url,
  };
}

function isGeoTiffRasterLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "cog" &&
    layer.metadata.sourceKind === "geotiff-url" &&
    layer.metadata.externalNativeLayer === true
  );
}

function getStacGeoKeysParser(): Promise<StacGeoKeysParser> {
  stacGeoKeysParserPromise ??= createStacGeoKeysParser();
  return stacGeoKeysParserPromise;
}

async function createStacGeoKeysParser(): Promise<StacGeoKeysParser> {
  const geokeysToProj4 = await import("geotiff-geokeys-to-proj4");
  registerStacCommonProjections();

  return async (geoKeys) => {
    try {
      const projection = geokeysToProj4.toProj4(geoKeys as never);
      if (!projection?.proj4) return null;
      const def = projection.proj4.replace(/\+axis=\w+\s*/g, "");
      proj4.defs("custom", def);
      return {
        coordinatesUnits: projection.coordinatesUnits || "metre",
        def,
        parsed: (proj4.defs("custom") as Record<string, unknown>) ?? {},
      };
    } catch {
      return null;
    }
  };
}

function registerStacCommonProjections(): void {
  proj4.defs("EPSG:4326", "+proj=longlat +datum=WGS84 +no_defs +type=crs");
  proj4.defs(
    "EPSG:3857",
    "+proj=merc +a=6378137 +b=6378137 +lat_ts=0.0 +lon_0=0.0 " +
      "+x_0=0.0 +y_0=0 +k=1.0 +units=m +nadgrids=@null +wktext " +
      "+no_defs +type=crs",
  );
}

function createGeoTiffRasterLayerId(): string {
  geoTiffRasterLayerSequence += 1;
  return `geotiff-layer-${geoTiffRasterLayerSequence}`;
}

export function shouldUseGenericGeoTiffRenderer(url: string): boolean {
  const isTiffPath = /\.tiff?$/i.test(url);
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(url);
  if (!hasScheme) return isTiffPath;

  try {
    const parsedUrl = new URL(url);
    const isTiff = /\.tiff?$/i.test(parsedUrl.pathname);
    return isTiff && parsedUrl.protocol === "file:";
  } catch {
    return isTiffPath;
  }
}
