import type { EllipsoidId } from "@geolibre/core";

/**
 * The i18n key for a planetary basemap section heading, keyed by the celestial
 * body it depicts. Shared by the New Project and Change Basemap panels, which
 * both render {@link PLANETARY_BASEMAP_GROUPS} as one section per body.
 *
 * Returns a literal key so the typed `t()` accepts it. Throws for a body with
 * no dedicated heading so a future basemap group (e.g. Mercury) added without a
 * matching section fails loudly instead of being silently captioned "Mars".
 */
export function planetaryBodySectionKey(ellipsoidId: EllipsoidId) {
  switch (ellipsoidId) {
    case "moon":
      return "basemapPicker.sectionMoon" as const;
    case "mars":
      return "basemapPicker.sectionMars" as const;
    default:
      throw new Error(
        `no planetary basemap section heading for "${ellipsoidId}"`,
      );
  }
}
