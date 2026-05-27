import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

/** Sample GeoJSON — populated at runtime from app bundle or fetch */
let sampleData: GeoJSON.FeatureCollection | null = null;

export function setSampleGeoJson(data: GeoJSON.FeatureCollection): void {
  sampleData = data;
}

export const sampleGeoJsonPlugin: GeoLibrePlugin = {
  id: "sample-geojson",
  name: "Add Sample GeoJSON",
  version: "0.1.0",
  activate: (app: GeoLibreAppAPI) => {
    if (sampleData) {
      app.addGeoJsonLayer("Sample Places", sampleData, "sample-data/sample.geojson");
    }
  },
  deactivate: () => {},
};
