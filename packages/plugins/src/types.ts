import type { FeatureCollection } from "geojson";
import type { IControl } from "maplibre-gl";

export type GeoLibreMapControlPosition =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export type GeoLibreBuiltInMapControl =
  | "navigation"
  | "fullscreen"
  | "globe"
  | "layer-control";

export interface GeoLibreAppAPI {
  setBasemap: (styleUrl: string) => void;
  addGeoJsonLayer: (
    name: string,
    data: FeatureCollection,
    sourcePath?: string,
  ) => void;
  getActiveBasemap: () => string;
  addMapControl: (
    control: IControl,
    position?: GeoLibreMapControlPosition,
  ) => boolean;
  removeMapControl: (control: IControl) => void;
  setBuiltInMapControlVisible: (
    control: GeoLibreBuiltInMapControl,
    visible: boolean,
  ) => boolean;
}

export interface GeoLibrePlugin {
  id: string;
  name: string;
  version: string;
  activeByDefault?: boolean;
  activate: (app: GeoLibreAppAPI) => boolean | void;
  deactivate: (app: GeoLibreAppAPI) => void;
}
