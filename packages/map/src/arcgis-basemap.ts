import { basemapToCesiumImagery, BLANK_BASEMAP } from "@geolibre/core";
import { webTileTemplate } from "./arcgis-layers";

/**
 * What the ArcGIS map draws as its basemap (issue #2421).
 *
 * The SDK understands neither MapLibre style URLs nor GeoLibre's `geolibre://`
 * sentinels, so — exactly as the globe does through `basemapToCesiumImagery` —
 * the shared project basemap is translated into tiles the SDK can draw. Two
 * things are ArcGIS-specific:
 *
 * - A project can pin an Esri basemap style (`preferences.map.arcgisBasemap`,
 *   e.g. `arcgis/streets`, the new-project default) the way it pins a Mapbox
 *   style. Esri's basemap styles service needs an API key, so without one the
 *   pin draws Esri World Imagery, a keyless tiled service, instead of showing
 *   an error tile. Picking a shared basemap clears the pin, and that basemap
 *   is then translated.
 * - The translation is engine-free (plain descriptors), so it is tested
 *   without the SDK and the engine only instantiates the result.
 */
export type ArcgisBasemapPlan =
  | { kind: "none" }
  /** An Esri basemap style id for `new Map({ basemap })`; needs an API key. */
  | { kind: "esri-style"; id: string }
  /** An ArcGIS tiled MapServer (the GeoLibre catalog's Esri imagery entries). */
  | { kind: "tile-service"; url: string }
  | {
      kind: "web-tile";
      urlTemplate: string;
      subDomains?: string[];
      copyright: string;
      /** A transparent roads-and-labels layer drawn above the imagery. */
      overlay?: { urlTemplate: string; subDomains?: string[] };
    };

/** The Esri basemap style used when a project has none and a key is present. */
export const DEFAULT_ARCGIS_BASEMAP = "arcgis/streets";

/**
 * Esri basemap styles offered in the app, by their basemap styles service id.
 * Kept short on purpose: the Basemaps panel is the place for a full picker.
 */
export const ARCGIS_BASEMAP_STYLES: readonly { id: string; name: string }[] = [
  { id: "arcgis/streets", name: "ArcGIS Streets" },
  { id: "arcgis/navigation", name: "ArcGIS Navigation" },
  { id: "arcgis/topographic", name: "ArcGIS Topographic" },
  { id: "arcgis/light-gray", name: "ArcGIS Light Gray" },
  { id: "arcgis/dark-gray", name: "ArcGIS Dark Gray" },
  { id: "arcgis/imagery", name: "ArcGIS Imagery" },
  { id: "arcgis/imagery/standard", name: "ArcGIS Imagery (no labels)" },
  { id: "arcgis/oceans", name: "ArcGIS Oceans" },
  { id: "arcgis/outdoor", name: "ArcGIS Outdoor" },
  { id: "osm/standard", name: "OpenStreetMap (Esri)" },
];

/** Whether `id` names an Esri basemap style (`arcgis/...` or `osm/...`). */
export function isArcgisBasemapStyle(id: unknown): id is string {
  return typeof id === "string" && /^(?:arcgis|osm)\/[a-z0-9-]+(?:\/[a-z0-9-]+)?$/.test(id);
}

/**
 * Keyless Esri World Imagery: the basemap without an API key, and the
 * fallback for a shared basemap with no raster form.
 */
export const ARCGIS_KEYLESS_BASEMAP_URL =
  "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer";

/**
 * Plan the basemap for the shared project basemap `styleUrl`, the project's
 * ArcGIS style override, and whether an API key is available.
 */
export function planArcgisBasemap(
  styleUrl: string | undefined,
  arcgisBasemap: string | undefined,
  hasApiKey: boolean,
): ArcgisBasemapPlan {
  if (isArcgisBasemapStyle(arcgisBasemap))
    return hasApiKey
      ? { kind: "esri-style", id: arcgisBasemap }
      : { kind: "tile-service", url: ARCGIS_KEYLESS_BASEMAP_URL };
  if (styleUrl === BLANK_BASEMAP) return { kind: "none" };
  const imagery = basemapToCesiumImagery(styleUrl);
  switch (imagery.kind) {
    case "none":
      return { kind: "none" };
    case "arcgis":
      return { kind: "tile-service", url: imagery.url };
    case "xyz": {
      // A TMS template has no SDK form, so it falls back to keyless imagery.
      if (imagery.scheme === "tms") break;
      try {
        const template = webTileTemplate(imagery.template);
        return {
          kind: "web-tile",
          ...template,
          copyright: stripHtml(imagery.attribution),
          ...(imagery.overlayTemplate ? { overlay: webTileTemplate(imagery.overlayTemplate) } : {}),
        };
      } catch {
        break;
      }
    }
    default:
      break;
  }
  return { kind: "tile-service", url: ARCGIS_KEYLESS_BASEMAP_URL };
}

/** The SDK renders copyright as text; the catalog carries HTML links. */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Whether two plans would draw the same basemap. */
export function sameArcgisBasemapPlan(a: ArcgisBasemapPlan, b: ArcgisBasemapPlan): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
