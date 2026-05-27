import { DEFAULT_BASEMAP } from "@geolibre/core";
import type { GeoLibreLayer, MapViewState } from "@geolibre/core";
import maplibregl from "maplibre-gl";
import { getLayerBounds } from "./geojson-loader";
import { removeLayerFromMap, syncLayer } from "./layer-sync";

export class MapController {
  private map: maplibregl.Map | null = null;
  private layerIds: string[] = [];

  init(
    container: HTMLElement,
    options: {
      styleUrl?: string;
      mapView?: MapViewState;
    },
  ): maplibregl.Map {
    const view = options.mapView;
    this.map = new maplibregl.Map({
      container,
      style: options.styleUrl ?? DEFAULT_BASEMAP,
      center: view?.center ?? [-98.5795, 39.8283],
      zoom: view?.zoom ?? 3,
      bearing: view?.bearing ?? 0,
      pitch: view?.pitch ?? 0,
    });
    this.map.addControl(new maplibregl.NavigationControl(), "top-right");
    return this.map;
  }

  getMap(): maplibregl.Map | null {
    return this.map;
  }

  destroy(): void {
    this.map?.remove();
    this.map = null;
  }

  setStyle(url: string): void {
    this.map?.setStyle(url);
  }

  applyView(view: MapViewState): void {
    if (!this.map) return;
    this.map.jumpTo({
      center: view.center,
      zoom: view.zoom,
      bearing: view.bearing,
      pitch: view.pitch,
    });
  }

  readView(): MapViewState {
    if (!this.map) {
      return {
        center: [-98.5795, 39.8283],
        zoom: 3,
        bearing: 0,
        pitch: 0,
      };
    }
    const c = this.map.getCenter();
    const b = this.map.getBounds();
    return {
      center: [c.lng, c.lat],
      zoom: this.map.getZoom(),
      bearing: this.map.getBearing(),
      pitch: this.map.getPitch(),
      bbox: [
        b.getWest(),
        b.getSouth(),
        b.getEast(),
        b.getNorth(),
      ],
    };
  }

  syncLayers(layers: GeoLibreLayer[]): void {
    if (!this.map || !this.map.isStyleLoaded()) return;

    const nextIds = layers.map((l) => l.id);
    for (const id of this.layerIds) {
      if (!nextIds.includes(id)) {
        removeLayerFromMap(this.map, id);
      }
    }

    for (const layer of layers) {
      syncLayer(this.map, layer);
    }
    this.layerIds = nextIds;
  }

  private styleLoadHandler: (() => void) | null = null;

  waitAndSyncLayers(layers: GeoLibreLayer[]): void {
    if (!this.map) return;

    if (this.styleLoadHandler) {
      this.map.off("style.load", this.styleLoadHandler);
    }

    const run = () => this.syncLayers(layers);
    this.styleLoadHandler = run;

    if (this.map.isStyleLoaded()) {
      run();
    } else {
      this.map.once("load", run);
    }
    this.map.on("style.load", run);
  }

  fitLayer(layer: GeoLibreLayer): void {
    const bounds = getLayerBounds(layer);
    if (!bounds || !this.map) return;
    this.map.fitBounds(
      [
        [bounds[0], bounds[1]],
        [bounds[2], bounds[3]],
      ],
      { padding: 40, duration: 800 },
    );
  }

  fitBounds(bounds: [number, number, number, number]): void {
    if (!this.map) return;
    this.map.fitBounds(
      [
        [bounds[0], bounds[1]],
        [bounds[2], bounds[3]],
      ],
      { padding: 40, duration: 800 },
    );
  }
}

export function createMapController(): MapController {
  return new MapController();
}
