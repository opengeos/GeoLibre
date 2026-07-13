import {
  getEllipsoid,
  type PlanetaryBasemap,
  type PlanetaryBasemapSectionId,
} from "@geolibre/core";

/**
 * The i18n key for a planetary basemap section heading. Shared by the New
 * Project and Change Basemap panels, which render {@link PLANETARY_BASEMAP_GROUPS}
 * as one section per id: dedicated headings for the Moon and Mars, and a single
 * "Other celestial bodies" heading for the rest.
 *
 * Returns a literal key so the typed `t()` accepts it. The switch is exhaustive
 * over {@link PlanetaryBasemapSectionId}, so a new section id fails to compile
 * until a heading is added here.
 */
export function planetaryBasemapSectionKey(sectionId: PlanetaryBasemapSectionId) {
  switch (sectionId) {
    case "moon":
      return "basemapPicker.sectionMoon" as const;
    case "mars":
      return "basemapPicker.sectionMars" as const;
    case "other":
      return "basemapPicker.sectionOther" as const;
  }
}

/**
 * The button label for a planetary basemap within a picker section. Bodies with
 * a dedicated section (Moon, Mars) show just the basemap name; in the combined
 * "other" section the body name is prefixed so the buttons stay unambiguous —
 * otherwise the three Galilean-moon mosaics all read "Galileo / Voyager", and
 * Pluto and Charon both read "New Horizons Mosaic".
 */
export function planetaryBasemapLabel(
  basemap: PlanetaryBasemap,
  sectionId: PlanetaryBasemapSectionId,
): string {
  if (sectionId !== "other") return basemap.name;
  return `${getEllipsoid(basemap.ellipsoidId).name} — ${basemap.name}`;
}
