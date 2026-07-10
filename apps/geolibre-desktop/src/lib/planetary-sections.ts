import type { EllipsoidId } from "@geolibre/core";

/**
 * The i18n key for a planetary basemap section heading, keyed by the celestial
 * body it depicts. Shared by the New Project and Change Basemap panels, which
 * both render {@link PLANETARY_BASEMAP_GROUPS} as one section per body.
 *
 * Returns a literal key so the typed `t()` accepts it. Bodies without a
 * dedicated heading fall back to the Mars section (the only other grouped body).
 */
export function planetaryBodySectionKey(ellipsoidId: EllipsoidId) {
  return ellipsoidId === "moon"
    ? ("basemapPicker.sectionMoon" as const)
    : ("basemapPicker.sectionMars" as const);
}
