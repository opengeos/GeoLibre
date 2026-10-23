import type { Map, GeoJSONSource } from "maplibre-gl";
import type { StacItem } from "./types";
import { INTERNAL_LAYER_METADATA } from "./utils";

const SOURCE_ID = "vantor-highlight-source";
const FILL_LAYER_ID = "vantor-highlight-fill";
const LINE_LAYER_ID = "vantor-highlight-line";

const EMPTY_FC: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

export class HighlightLayer {
  private map: Map;

  constructor(map: Map) {
    this.map = map;
    this.init();
  }

  private init(): void {
    this.map.addSource(SOURCE_ID, {
      type: "geojson",
      data: EMPTY_FC,
    });

    this.map.addLayer({
      id: FILL_LAYER_ID,
      type: "fill",
      source: SOURCE_ID,
      metadata: INTERNAL_LAYER_METADATA,
      paint: {
        "fill-color": "#FFEB3B",
        "fill-opacity": 0.3,
      },
    });

    this.map.addLayer({
      id: LINE_LAYER_ID,
      type: "line",
      source: SOURCE_ID,
      metadata: INTERNAL_LAYER_METADATA,
      paint: {
        "line-color": "#FFC107",
        "line-width": 3,
      },
    });
  }

  highlight(item: StacItem): void {
    const source = this.map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    if (!source || !item.geometry) return;

    source.setData({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: item.geometry,
          properties: { id: item.id },
        },
      ],
    });

    // Fly to the footprint
    if (item.bbox) {
      this.map.fitBounds(
        [
          [item.bbox[0], item.bbox[1]],
          [item.bbox[2], item.bbox[3]],
        ],
        { padding: 50, maxZoom: 15, duration: 500 },
      );
    }
  }

  clear(): void {
    const source = this.map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    if (source) {
      source.setData(EMPTY_FC);
    }
  }

  remove(): void {
    if (this.map.getLayer(LINE_LAYER_ID)) {
      this.map.removeLayer(LINE_LAYER_ID);
    }
    if (this.map.getLayer(FILL_LAYER_ID)) {
      this.map.removeLayer(FILL_LAYER_ID);
    }
    if (this.map.getSource(SOURCE_ID)) {
      this.map.removeSource(SOURCE_ID);
    }
  }
}
