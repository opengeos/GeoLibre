import type { MapRendererKind } from "@geolibre/core";

// These loaders still depend on MapLibre protocols or custom render passes.
// Keep the menu and command palette in agreement until they have adapters.
// Sources drawn through the shared deck.gl overlay (Deck.gl Layer, 3D Model,
// DuckDB, 3D Tiles, LiDAR) are not listed: `@deck.gl/mapbox` hosts them on
// Mapbox natively. KML/KMZ is not listed either: off the globe it goes through
// the host KML importer, the same path a dropped file takes on any renderer.
const MAPBOX_UNSUPPORTED_SOURCES = new Set(["mbtiles", "splatting", "cesium-ion", "czml"]);

// Adapted deck.gl plugins are gated separately by flat/local view capabilities.
// STAC's browser draws its results as MapLibre/Mapbox layers, and the SDK has
// no video overlay.
const ARCGIS_UNSUPPORTED_SOURCES = new Set([
  ...[...MAPBOX_UNSUPPORTED_SOURCES].filter((id) => id !== "mbtiles"),
  "stac",
  "video",
]);

const ARCGIS_DECK_SOURCES = new Set(["deckgl-viz", "gltf-model", "lidar", "duckdb", "3d-tiles"]);

export function requiresArcgisDeckOverlay(id: string): boolean {
  return ARCGIS_DECK_SOURCES.has(id);
}

export function supportsAddDataRenderer(
  id: string,
  renderer: MapRendererKind,
  deckOverlay = true,
): boolean {
  if (renderer === "mapbox") return !MAPBOX_UNSUPPORTED_SOURCES.has(id);
  if (renderer === "arcgis")
    return !ARCGIS_UNSUPPORTED_SOURCES.has(id) && (deckOverlay || !requiresArcgisDeckOverlay(id));
  return true;
}
