import type { GeoLibreLayer } from "@geolibre/core";

// The application's raster bridge for all-layer Identify, shared by every
// renderer's canvas (MapLibre, Mapbox, ArcGIS).

/** One raster result supplied by the application to all-layer Identify. */
export interface MapCanvasRasterIdentifyResult {
  properties: Record<string, unknown>;
  title?: string;
}

/** Application bridge for raster sources owned outside `@geolibre/map`. */
export type MapCanvasRasterIdentify = (
  layer: GeoLibreLayer,
  lngLat: [number, number],
  options: { signal: AbortSignal },
) => Promise<MapCanvasRasterIdentifyResult | null>;
