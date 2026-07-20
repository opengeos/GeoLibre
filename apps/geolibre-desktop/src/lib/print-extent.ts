import type { BBox, MapEngineClient } from "@geolibre/map";
import type { FeatureCollection, Polygon } from "geojson";

/** A geographic bounding box as `[west, south, east, north]`. */
export type PrintExtent = BBox;

const PRINT_EXTENT_OVERLAY_ID = "print-extent";

function extentCollection(extent: PrintExtent): FeatureCollection<Polygon> {
  const [west, south, east, north] = extent;
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [west, south],
              [east, south],
              [east, north],
              [west, north],
              [west, south],
            ],
          ],
        },
      },
    ],
  };
}

/** Show or update the retained print-extent overlay through MapEngine. */
export function showPrintExtent(client: MapEngineClient, extent: PrintExtent): void {
  client.interactions.upsertGeoJsonOverlay({
    id: PRINT_EXTENT_OVERLAY_ID,
    data: extentCollection(extent),
    style: {
      fillColor: "#2563eb",
      fillOpacity: 0.12,
      lineColor: "#2563eb",
      lineWidth: 2,
      lineDash: [3, 2],
    },
    visible: true,
  });
}

export function setPrintExtentVisible(client: MapEngineClient, visible: boolean): void {
  client.interactions.setOverlayVisible(PRINT_EXTENT_OVERLAY_ID, visible);
}

export function clearPrintExtent(client: MapEngineClient): void {
  client.interactions.removeOverlay(PRINT_EXTENT_OVERLAY_ID);
}

export interface DrawPrintExtentOptions {
  readonly aspect?: number;
  readonly signal?: AbortSignal;
  readonly drawBox?: boolean;
  readonly onPreview?: (extent: PrintExtent | null) => void;
}

/** Draw bounds through the engine and optionally retain the standard preview. */
export async function drawPrintExtent(
  client: MapEngineClient,
  options: DrawPrintExtentOptions = {},
): Promise<PrintExtent | null> {
  const extent = await client.interactions.drawBounds({
    aspectRatio: options.aspect,
    signal: options.signal,
    onPreview: (preview) => {
      if (preview && options.drawBox !== false) showPrintExtent(client, preview);
      options.onPreview?.(preview);
    },
  });
  if (extent && options.drawBox !== false) showPrintExtent(client, extent);
  return extent;
}
