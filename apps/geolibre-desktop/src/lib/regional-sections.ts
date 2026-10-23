import type { RegionalBasemapRegionId } from "@geolibre/core";

/**
 * The i18n key for a region's heading inside the Regional basemaps section.
 * Shared by the New Project and Change Basemap panels.
 *
 * Returns a literal key so the typed `t()` accepts it. The switch is exhaustive
 * over {@link RegionalBasemapRegionId}, so a new region fails to compile until
 * a heading is added here — the same guard `planetaryBasemapSectionKey` gives
 * the celestial-body sections.
 */
export function regionalBasemapRegionKey(regionId: RegionalBasemapRegionId) {
  switch (regionId) {
    case "china":
      return "basemapPicker.regionChina" as const;
  }
}
