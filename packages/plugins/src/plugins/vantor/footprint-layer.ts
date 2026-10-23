import type { Map, MapMouseEvent, GeoJSONSource } from "maplibre-gl";
import type { StacItem } from "./types";
import { INTERNAL_LAYER_METADATA, itemsToFeatureCollection } from "./utils";

const SOURCE_ID = "vantor-footprints-source";
const FILL_LAYER_ID = "vantor-footprints-fill";
const PRE_LINE_LAYER_ID = "vantor-footprints-pre-line";
const POST_LINE_LAYER_ID = "vantor-footprints-post-line";

export class FootprintLayer {
  private map: Map;
  private clickHandler: ((e: MapMouseEvent) => void) | null = null;
  private onClickCallback: ((itemId: string) => void) | null = null;
  private mouseEnterHandler: (() => void) | null = null;
  private mouseLeaveHandler: (() => void) | null = null;

  constructor(map: Map) {
    this.map = map;
  }

  setItems(items: StacItem[]): void {
    const fc = itemsToFeatureCollection(items);

    if (this.map.getSource(SOURCE_ID)) {
      (this.map.getSource(SOURCE_ID) as GeoJSONSource).setData(fc);
    } else {
      this.map.addSource(SOURCE_ID, {
        type: "geojson",
        data: fc,
        promoteId: "id",
      });

      this.map.addLayer({
        id: FILL_LAYER_ID,
        type: "fill",
        source: SOURCE_ID,
        metadata: INTERNAL_LAYER_METADATA,
        paint: {
          "fill-color": [
            "case",
            ["==", ["get", "phase"], "pre"],
            "#2196F3",
            ["==", ["get", "phase"], "post"],
            "#F44336",
            "#9E9E9E",
          ],
          "fill-opacity": 0.1,
        },
      });

      this.map.addLayer({
        id: PRE_LINE_LAYER_ID,
        type: "line",
        source: SOURCE_ID,
        metadata: INTERNAL_LAYER_METADATA,
        filter: ["==", ["get", "phase"], "pre"],
        paint: {
          "line-color": "#2196F3",
          "line-width": 2,
          "line-opacity": 0.8,
        },
      });

      this.map.addLayer({
        id: POST_LINE_LAYER_ID,
        type: "line",
        source: SOURCE_ID,
        metadata: INTERNAL_LAYER_METADATA,
        filter: ["==", ["get", "phase"], "post"],
        paint: {
          "line-color": "#F44336",
          "line-width": 2,
          "line-opacity": 0.8,
        },
      });

      // Change cursor on hover
      this.mouseEnterHandler = () => {
        this.map.getCanvas().style.cursor = "pointer";
      };
      this.mouseLeaveHandler = () => {
        this.map.getCanvas().style.cursor = "";
      };
      this.map.on("mouseenter", FILL_LAYER_ID, this.mouseEnterHandler);
      this.map.on("mouseleave", FILL_LAYER_ID, this.mouseLeaveHandler);
    }
  }

  onClick(callback: (itemId: string) => void): void {
    this.onClickCallback = callback;

    if (this.clickHandler) {
      this.map.off("click", FILL_LAYER_ID, this.clickHandler);
    }

    this.clickHandler = (e: MapMouseEvent) => {
      const features = this.map.queryRenderedFeatures(e.point, {
        layers: [FILL_LAYER_ID],
      });
      if (features && features.length > 0) {
        const itemId = features[0].properties?.id as string;
        if (itemId && this.onClickCallback) {
          this.onClickCallback(itemId);
        }
      }
    };

    this.map.on("click", FILL_LAYER_ID, this.clickHandler);
  }

  fitToBounds(items: StacItem[]): void {
    if (items.length === 0) return;

    // Compute bounds as a plain [[w,s],[e,n]] array rather than constructing a
    // maplibregl.LngLatBounds: when this runs in a host (e.g. GeoLibre) the map
    // belongs to a different maplibre-gl instance, and a foreign LngLatBounds
    // fails the host's instanceof check in fitBounds and is silently ignored.
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (const item of items) {
      if (item.bbox && item.bbox.length >= 4) {
        west = Math.min(west, item.bbox[0]);
        south = Math.min(south, item.bbox[1]);
        east = Math.max(east, item.bbox[2]);
        north = Math.max(north, item.bbox[3]);
      }
    }

    if (west <= east && south <= north) {
      this.map.fitBounds(
        [
          [west, south],
          [east, north],
        ],
        { padding: 50 },
      );
    }
  }

  remove(): void {
    if (this.clickHandler) {
      this.map.off("click", FILL_LAYER_ID, this.clickHandler);
      this.clickHandler = null;
    }
    if (this.mouseEnterHandler) {
      this.map.off("mouseenter", FILL_LAYER_ID, this.mouseEnterHandler);
      this.mouseEnterHandler = null;
    }
    if (this.mouseLeaveHandler) {
      this.map.off("mouseleave", FILL_LAYER_ID, this.mouseLeaveHandler);
      this.mouseLeaveHandler = null;
    }

    for (const layerId of [POST_LINE_LAYER_ID, PRE_LINE_LAYER_ID, FILL_LAYER_ID]) {
      if (this.map.getLayer(layerId)) {
        this.map.removeLayer(layerId);
      }
    }

    if (this.map.getSource(SOURCE_ID)) {
      this.map.removeSource(SOURCE_ID);
    }
  }
}
