import type { FeatureCollection } from "geojson";

export interface GeoLibreAppAPI {
  setBasemap: (styleUrl: string) => void;
  addGeoJsonLayer: (
    name: string,
    data: FeatureCollection,
    sourcePath?: string,
  ) => void;
  getActiveBasemap: () => string;
}

export interface GeoLibrePlugin {
  id: string;
  name: string;
  version: string;
  activate: (app: GeoLibreAppAPI) => void;
  deactivate: (app: GeoLibreAppAPI) => void;
}
