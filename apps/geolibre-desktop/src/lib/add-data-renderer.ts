import type { MapRendererKind } from "@geolibre/core";

// These loaders still depend on MapLibre protocols or custom render passes.
// Keep the menu and command palette in agreement until they have adapters.
// Sources drawn through the shared deck.gl overlay (Deck.gl Layer, 3D Model,
// DuckDB, 3D Tiles, LiDAR) are not listed: `@deck.gl/mapbox` hosts them on
// Mapbox natively. KML/KMZ is not listed either: off the globe it goes through
// the host KML importer, the same path a dropped file takes on any renderer.
const MAPBOX_UNSUPPORTED_SOURCES = new Set(["mbtiles", "splatting", "cesium-ion", "czml"]);

// The ArcGIS renderer has no deck.gl overlay or custom-layer host yet, so on
// top of the Mapbox list every source drawn through one of those is out, as are
// the archives and cloud rasters that need a MapLibre protocol (see
// packages/map/src/arcgis-layers.ts for what it does draw).
const ARCGIS_UNSUPPORTED_SOURCES = new Set([
  ...MAPBOX_UNSUPPORTED_SOURCES,
  "pmtiles",
  "cog",
  "zarr",
  "lidar",
  "3d-tiles",
  "deckgl",
  "3d-model",
  "duckdb",
  "netcdf",
]);

export function supportsAddDataRenderer(id: string, renderer: MapRendererKind): boolean {
  if (renderer === "mapbox") return !MAPBOX_UNSUPPORTED_SOURCES.has(id);
  if (renderer === "arcgis") return !ARCGIS_UNSUPPORTED_SOURCES.has(id);
  return true;
}
