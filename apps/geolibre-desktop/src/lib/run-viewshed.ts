import { DEFAULT_LAYER_STYLE, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import {
  assembleTerrainDem,
  computeViewshed,
  viewshedToRgba,
  MAX_VIEWSHED_RADIUS_METERS,
} from "@geolibre/processing";

/**
 * Run a viewshed from a clicked map point and add the result as a layer
 * (issue #1815).
 *
 * The result is an `image` layer — a translucent wash over the visible ground,
 * pinned to the analysed square by its corner coordinates. That reuses the
 * overlay path the Raster Georeferencer already established, so the viewshed
 * gets opacity, ordering, zoom-to and removal from the Layers panel for free,
 * with no new layer type.
 *
 * A PNG data URL rather than a blob URL: the layer is saved with the project,
 * and a blob URL would be dead the next time it opened.
 */

/** Default eye height above ground — a standing person. */
export const DEFAULT_OBSERVER_HEIGHT_METERS = 1.8;

export interface RunViewshedOptions {
  lng: number;
  lat: number;
  radiusMeters: number;
  observerHeightMeters?: number;
  /** Layer name; callers pass a translated string. */
  layerName: string;
}

export interface ViewshedRunResult {
  layerId: string;
  /** Share of the analysed area that is visible, 0-1. */
  visibleFraction: number;
  observerGroundMeters: number;
}

/** Encode an RGBA grid as a PNG data URL. */
async function rgbaToPngDataUrl(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<string | null> {
  try {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D | null;
    if (!context) return null;
    // Built via createImageData rather than `new ImageData(rgba, ...)`: the
    // constructor's typing requires an ArrayBuffer-backed view, and copying into
    // a context-owned buffer sidesteps that without an assertion.
    const image = context.createImageData(width, height);
    image.data.set(rgba);
    context.putImageData(image, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/**
 * Compute a viewshed and add it to the map.
 *
 * @returns The new layer and coverage stats, or null when the terrain could not
 *   be fetched or nothing proved visible.
 */
export async function runViewshed(options: RunViewshedOptions): Promise<ViewshedRunResult | null> {
  const radiusMeters = Math.min(options.radiusMeters, MAX_VIEWSHED_RADIUS_METERS);
  const dem = await assembleTerrainDem({
    lng: options.lng,
    lat: options.lat,
    radiusMeters,
  });
  if (!dem) return null;

  const result = computeViewshed(
    dem,
    {
      lng: options.lng,
      lat: options.lat,
      heightMeters: options.observerHeightMeters ?? DEFAULT_OBSERVER_HEIGHT_METERS,
    },
    radiusMeters,
  );
  if (result.visibleCells === 0) return null;

  const url = await rgbaToPngDataUrl(viewshedToRgba(result), result.width, result.height);
  if (!url) return null;

  const [west, south, east, north] = result.bbox;
  const layer: GeoLibreLayer = {
    id: `viewshed-${Date.now().toString(36)}`,
    name: options.layerName,
    type: "image",
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    source: {
      url,
      // Top-left, top-right, bottom-right, bottom-left, matching the image
      // source contract in layer-sync.
      coordinates: [
        [west, north],
        [east, north],
        [east, south],
        [west, south],
      ],
    },
    metadata: {
      viewshed: {
        lng: options.lng,
        lat: options.lat,
        radiusMeters,
        observerHeightMeters: options.observerHeightMeters ?? DEFAULT_OBSERVER_HEIGHT_METERS,
        observerGroundMeters: result.observerGroundMeters,
      },
    },
  };

  useAppStore.getState().addLayer(layer);

  return {
    layerId: layer.id,
    visibleFraction: result.visibleCells / (result.width * result.height),
    observerGroundMeters: result.observerGroundMeters,
  };
}
