/** A well-known XYZ raster tile basemap the assistant can add by name. */
export interface NamedTileBasemap {
  id: string;
  label: string;
  /** XYZ URL template with {z}/{x}/{y} placeholders. */
  url: string;
  attribution: string;
  tileSize?: number;
}

/**
 * Curated registry of common imagery/tile basemaps so the assistant can add,
 * e.g., "Google Satellite" without needing to look up a URL. These are raster
 * XYZ layers (added on the map), distinct from the MapLibre vector styles that
 * `set_basemap` switches between.
 */
export const NAMED_TILE_BASEMAPS: readonly NamedTileBasemap[] = [
  {
    id: "google-satellite",
    label: "Google Satellite",
    url: "https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}",
    attribution: "© Google",
  },
  {
    id: "google-hybrid",
    label: "Google Hybrid",
    url: "https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
    attribution: "© Google",
  },
  {
    id: "google-roads",
    label: "Google Roads",
    url: "https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}",
    attribution: "© Google",
  },
  {
    id: "google-terrain",
    label: "Google Terrain",
    url: "https://mt1.google.com/vt/lyrs=p&x={x}&y={y}&z={z}",
    attribution: "© Google",
  },
  {
    id: "esri-imagery",
    label: "Esri World Imagery",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "© Esri, Maxar, Earthstar Geographics",
  },
  {
    id: "esri-topo",
    label: "Esri World Topo",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
    attribution: "© Esri",
  },
  {
    id: "osm",
    label: "OpenStreetMap",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "© OpenStreetMap contributors",
  },
  {
    id: "opentopomap",
    label: "OpenTopoMap",
    url: "https://a.tile.opentopomap.org/{z}/{x}/{y}.png",
    attribution: "© OpenTopoMap (CC-BY-SA)",
  },
  {
    id: "carto-dark",
    label: "CARTO Dark Matter",
    url: "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
    attribution: "© CARTO, © OpenStreetMap contributors",
  },
];

/** Tokenize a reference into lowercase word parts (splitting on non-alphanum). */
function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Resolve a basemap by id or (fuzzy) label, e.g. "google satellite",
 * "esri imagery", or "satellite". Tries exact id, exact label, substring, then
 * a token-subset match (every word of the query appears in the id+label).
 */
export function findNamedTileBasemap(reference: string): NamedTileBasemap | null {
  const target = reference.trim().toLowerCase();
  if (!target) return null;
  const exact =
    NAMED_TILE_BASEMAPS.find((basemap) => basemap.id === target) ??
    NAMED_TILE_BASEMAPS.find(
      (basemap) => basemap.label.toLowerCase() === target,
    ) ??
    NAMED_TILE_BASEMAPS.find((basemap) =>
      basemap.label.toLowerCase().includes(target),
    );
  if (exact) return exact;
  const queryTokens = tokens(target);
  if (queryTokens.length === 0) return null;
  return (
    NAMED_TILE_BASEMAPS.find((basemap) => {
      const haystack = tokens(`${basemap.id} ${basemap.label}`);
      return queryTokens.every((token) => haystack.includes(token));
    }) ?? null
  );
}
