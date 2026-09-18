import type { Map, MapMouseEvent, GeoJSONSource } from "maplibre-gl";
import type { BBox } from "./types";
import { INTERNAL_LAYER_METADATA } from "./utils";

const SOURCE_ID = "vantor-draw-bbox-source";
const FILL_LAYER_ID = "vantor-draw-bbox-fill";
const LINE_LAYER_ID = "vantor-draw-bbox-line";

const EMPTY_FC: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

export class DrawBBox {
  private map: Map;
  private active = false;
  private startPoint: [number, number] | null = null;
  private resolvePromise: ((bbox: BBox) => void) | null = null;
  private rejectPromise: ((reason: Error) => void) | null = null;

  private boundMouseDown: (e: MapMouseEvent) => void;
  private boundMouseMove: (e: MapMouseEvent) => void;
  private boundMouseUp: (e: MapMouseEvent) => void;

  constructor(map: Map) {
    this.map = map;
    this.boundMouseDown = this.onMouseDown.bind(this);
    this.boundMouseMove = this.onMouseMove.bind(this);
    this.boundMouseUp = this.onMouseUp.bind(this);
    this.initLayers();
  }

  private initLayers(): void {
    if (this.map.getSource(SOURCE_ID)) return;

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
        "fill-color": "#1976D2",
        "fill-opacity": 0.1,
      },
    });

    this.map.addLayer({
      id: LINE_LAYER_ID,
      type: "line",
      source: SOURCE_ID,
      metadata: INTERNAL_LAYER_METADATA,
      paint: {
        "line-color": "#1976D2",
        "line-width": 2,
        "line-dasharray": [3, 3],
      },
    });
  }

  activate(): Promise<BBox> {
    return new Promise((resolve, reject) => {
      if (this.active) this.deactivate();
      this.resolvePromise = resolve;
      this.rejectPromise = reject;
      this.active = true;
      this.startPoint = null;

      this.map.getCanvas().style.cursor = "crosshair";
      this.map.dragPan.disable();

      this.map.on("mousedown", this.boundMouseDown);
    });
  }

  deactivate(): void {
    this.active = false;
    this.startPoint = null;
    this.map.getCanvas().style.cursor = "";
    this.map.dragPan.enable();

    this.map.off("mousedown", this.boundMouseDown);
    this.map.off("mousemove", this.boundMouseMove);
    this.map.off("mouseup", this.boundMouseUp);

    const reject = this.rejectPromise;
    this.resolvePromise = null;
    this.rejectPromise = null;
    if (reject) {
      const error = new Error("Bounding-box drawing cancelled.");
      error.name = "AbortError";
      reject(error);
    }
  }

  clear(): void {
    const source = this.map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    if (source) {
      source.setData(EMPTY_FC);
    }
  }

  setBBox(bbox: BBox): void {
    this.initLayers();
    const source = this.map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    if (source) {
      source.setData({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [bbox.west, bbox.south],
                  [bbox.east, bbox.south],
                  [bbox.east, bbox.north],
                  [bbox.west, bbox.north],
                  [bbox.west, bbox.south],
                ],
              ],
            },
            properties: {},
          },
        ],
      });
    }
  }

  private onMouseDown(e: MapMouseEvent): void {
    if (!this.active) return;
    e.preventDefault();

    this.startPoint = [e.lngLat.lng, e.lngLat.lat];

    this.map.on("mousemove", this.boundMouseMove);
    this.map.on("mouseup", this.boundMouseUp);
  }

  private onMouseMove(e: MapMouseEvent): void {
    if (!this.active || !this.startPoint) return;

    const currentPoint: [number, number] = [e.lngLat.lng, e.lngLat.lat];
    this.updateRectangle(this.startPoint, currentPoint);
  }

  private onMouseUp(e: MapMouseEvent): void {
    if (!this.active || !this.startPoint) return;

    const endPoint: [number, number] = [e.lngLat.lng, e.lngLat.lat];
    const bbox: BBox = {
      west: Math.min(this.startPoint[0], endPoint[0]),
      south: Math.min(this.startPoint[1], endPoint[1]),
      east: Math.max(this.startPoint[0], endPoint[0]),
      north: Math.max(this.startPoint[1], endPoint[1]),
    };

    this.updateRectangle(this.startPoint, endPoint);
    const resolve = this.resolvePromise;
    this.resolvePromise = null;
    this.rejectPromise = null;
    this.deactivate();
    resolve?.(bbox);
  }

  private updateRectangle(start: [number, number], end: [number, number]): void {
    const source = this.map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    if (!source) return;

    const west = Math.min(start[0], end[0]);
    const south = Math.min(start[1], end[1]);
    const east = Math.max(start[0], end[0]);
    const north = Math.max(start[1], end[1]);

    source.setData({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
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
          properties: {},
        },
      ],
    });
  }

  removeLayers(): void {
    if (this.active) {
      this.deactivate();
    }
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
