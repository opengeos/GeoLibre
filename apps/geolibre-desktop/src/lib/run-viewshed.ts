import { useAppStore } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import {
  assembleTerrainDem,
  computeViewshedAsync,
  viewshedToRgba,
  MAX_VIEWSHED_RADIUS_METERS,
  MIN_VIEWSHED_RADIUS_METERS,
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

/** Marks the layer as a viewshed result, for panels that gate on provenance. */
export const VIEWSHED_SOURCE_KIND = "viewshed";

export interface RunViewshedOptions {
  lng: number;
  lat: number;
  /** Frames the result after adding it, as the sibling quick actions do. */
  mapControllerRef?: React.RefObject<MapController | null>;
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
 *   be fetched or the result could not be encoded.
 */
export async function runViewshed(options: RunViewshedOptions): Promise<ViewshedRunResult | null> {
  // Clamped on both bounds here, not just the max: assembleTerrainDem floors to
  // MIN_VIEWSHED_RADIUS_METERS internally, so clamping only the ceiling would
  // let computeViewshed cull against a smaller radius than the DEM was built
  // for -- the analysed square and the visibility limit would disagree.
  const radiusMeters = Math.min(
    MAX_VIEWSHED_RADIUS_METERS,
    Math.max(MIN_VIEWSHED_RADIUS_METERS, options.radiusMeters),
  );
  const dem = await assembleTerrainDem({
    lng: options.lng,
    lat: options.lat,
    radiusMeters,
  });
  if (!dem) return null;

  const result = await computeViewshedAsync(
    dem,
    {
      lng: options.lng,
      lat: options.lat,
      heightMeters: options.observerHeightMeters ?? DEFAULT_OBSERVER_HEIGHT_METERS,
    },
    radiusMeters,
  );
  // Not checked for zero: computeViewshed always marks the observer's own cell,
  // so visibleCells is at least 1 by construction.

  const url = await rgbaToPngDataUrl(viewshedToRgba(result), result.width, result.height);
  if (!url) return null;

  const [west, south, east, north] = result.bbox;
  // The store's own image-overlay action rather than a hand-rolled layer: it
  // owns id generation, the default style, `source.type`, and the metadata
  // merge, and is what the KML ground-overlay and Georeferencer paths use.
  const layerId = useAppStore.getState().addImageOverlayLayer(
    options.layerName,
    {
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
    {
      // fitLayer resolves an extent from geojson, then source/metadata bounds,
      // then the live source's bounds. An ImageSource exposes only coordinates,
      // so without this the Layers panel's zoom-to button does nothing.
      bounds: result.bbox,
      sourceKind: VIEWSHED_SOURCE_KIND,
      metadata: {
        viewshed: {
          lng: options.lng,
          lat: options.lat,
          radiusMeters,
          observerHeightMeters: options.observerHeightMeters ?? DEFAULT_OBSERVER_HEIGHT_METERS,
          observerGroundMeters: result.observerGroundMeters,
        },
      },
    },
  );

  // Frame the result, like every sibling quick action does after adding its
  // layer. At the larger radii the square can fall outside the viewport even
  // though the clicked point was on screen, and a banner that flashes and
  // clears with nothing visible reads as "nothing happened".
  const added = useAppStore.getState().layers.find((entry) => entry.id === layerId);
  if (added) options.mapControllerRef?.current?.fitLayer(added);

  return {
    layerId,
    visibleFraction: result.visibleCells / (result.width * result.height),
    observerGroundMeters: result.observerGroundMeters,
  };
}
