import { DEFAULT_BASEMAP } from "@geolibre/core";
import type { GeoLibreLayer, MapViewState } from "@geolibre/core";
import maplibregl from "maplibre-gl";
import { LayerControl } from "maplibre-gl-layer-control";
import { getLayerBounds } from "./geojson-loader";
import { removeLayerFromMap, syncLayer } from "./layer-sync";

const DEFAULT_PROJECTION: maplibregl.ProjectionSpecification = {
  type: "globe",
};
const DEFAULT_MAX_PITCH = 85;

export type BuiltInMapControl =
  | "navigation"
  | "fullscreen"
  | "globe"
  | "layer-control";

export const DEFAULT_BUILT_IN_CONTROL_VISIBILITY: Record<
  BuiltInMapControl,
  boolean
> = {
  navigation: true,
  fullscreen: true,
  globe: true,
  "layer-control": true,
};

export class MapController {
  private map: maplibregl.Map | null = null;
  private navigationControl: maplibregl.NavigationControl | null = null;
  private fullscreenControl: maplibregl.FullscreenControl | null = null;
  private globeControl: maplibregl.GlobeControl | null = null;
  private layerControl: LayerControl | null = null;
  private basemapStyleUrl = DEFAULT_BASEMAP;
  private layerIds: string[] = [];
  private controlVisibility: Record<BuiltInMapControl, boolean> = {
    ...DEFAULT_BUILT_IN_CONTROL_VISIBILITY,
  };

  init(
    container: HTMLElement,
    options: {
      styleUrl?: string;
      mapView?: MapViewState;
    },
  ): maplibregl.Map {
    const view = options.mapView;
    this.basemapStyleUrl = options.styleUrl ?? DEFAULT_BASEMAP;
    this.map = new maplibregl.Map({
      container,
      style: this.basemapStyleUrl,
      center: view?.center ?? [-100, 40],
      zoom: view?.zoom ?? 2,
      bearing: view?.bearing ?? 0,
      pitch: view?.pitch ?? 0,
      maxPitch: DEFAULT_MAX_PITCH,
    });
    this.map.on("style.load", () => {
      this.enforceDefaultProjection();
      this.addLayerControl();
    });
    this.map.once("load", () => {
      this.enforceDefaultProjection();
      this.addLayerControl();
    });
    this.map.once("idle", () => this.enforceDefaultProjection());
    this.addNavigationControl();
    this.addFullscreenControl();
    this.addGlobeControl();
    return this.map;
  }

  getMap(): maplibregl.Map | null {
    return this.map;
  }

  addControl(
    control: maplibregl.IControl,
    position: maplibregl.ControlPosition = "top-right",
  ): boolean {
    if (!this.map) return false;
    this.map.addControl(control, position);
    return true;
  }

  removeControl(control: maplibregl.IControl): void {
    if (!this.map) return;
    try {
      this.map.removeControl(control);
    } catch {
      // MapLibre throws when a control has already been removed.
    }
  }

  setBuiltInControlVisible(
    control: BuiltInMapControl,
    visible: boolean,
  ): boolean {
    this.controlVisibility[control] = visible;

    if (visible) {
      if (control === "navigation") return this.addNavigationControl();
      if (control === "fullscreen") return this.addFullscreenControl();
      if (control === "globe") return this.addGlobeControl();
      return this.addLayerControl();
    }

    if (control === "navigation") this.removeNavigationControl();
    else if (control === "fullscreen") this.removeFullscreenControl();
    else if (control === "globe") this.removeGlobeControl();
    else this.removeLayerControl();
    return true;
  }

  destroy(): void {
    this.removeNavigationControl();
    this.removeFullscreenControl();
    this.removeGlobeControl();
    this.removeLayerControl();
    this.map?.remove();
    this.map = null;
  }

  setStyle(url: string): void {
    if (!this.map) return;
    this.basemapStyleUrl = url;
    this.removeLayerControl();
    this.map.setStyle(url);
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
        center: [-100, 40],
        zoom: 2,
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

  private enforceDefaultProjection(): void {
    if (!this.map) return;
    try {
      if (this.map.getProjection()?.type === DEFAULT_PROJECTION.type) return;
      this.map.setProjection(DEFAULT_PROJECTION);
    } catch {
      this.map.once("idle", () => this.enforceDefaultProjection());
    }
  }

  private addLayerControl(): boolean {
    if (
      !this.map ||
      this.layerControl ||
      !this.controlVisibility["layer-control"]
    ) {
      return false;
    }
    this.layerControl = new LayerControl({
      basemapStyleUrl: this.basemapStyleUrl,
      collapsed: true,
      panelWidth: 340,
      panelMinWidth: 240,
      panelMaxWidth: 450,
    });
    this.map.addControl(this.layerControl, "top-right");
    return true;
  }

  private removeLayerControl(): void {
    if (!this.map || !this.layerControl) return;
    this.removeControl(this.layerControl);
    this.layerControl = null;
  }

  private addNavigationControl(): boolean {
    if (
      !this.map ||
      this.navigationControl ||
      !this.controlVisibility.navigation
    ) {
      return false;
    }
    this.navigationControl = new maplibregl.NavigationControl();
    this.map.addControl(this.navigationControl, "top-right");
    return true;
  }

  private removeNavigationControl(): void {
    if (!this.navigationControl) return;
    this.removeControl(this.navigationControl);
    this.navigationControl = null;
  }

  private addFullscreenControl(): boolean {
    if (
      !this.map ||
      this.fullscreenControl ||
      !this.controlVisibility.fullscreen
    ) {
      return false;
    }
    this.fullscreenControl = new maplibregl.FullscreenControl();
    this.map.addControl(this.fullscreenControl, "top-right");
    return true;
  }

  private removeFullscreenControl(): void {
    if (!this.fullscreenControl) return;
    this.removeControl(this.fullscreenControl);
    this.fullscreenControl = null;
  }

  private addGlobeControl(): boolean {
    if (!this.map || this.globeControl || !this.controlVisibility.globe) {
      return false;
    }
    this.globeControl = new maplibregl.GlobeControl();
    this.map.addControl(this.globeControl, "top-right");
    return true;
  }

  private removeGlobeControl(): void {
    if (!this.globeControl) return;
    this.removeControl(this.globeControl);
    this.globeControl = null;
  }
}

export function createMapController(): MapController {
  return new MapController();
}
