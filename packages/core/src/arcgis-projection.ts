/**
 * Projections the ArcGIS renderer can draw its flat map in (issue #2708).
 *
 * MapLibre and Mapbox only draw Web Mercator and a globe, but the ArcGIS Maps
 * SDK reprojects vector layers on the client into any projected coordinate
 * system it knows by WKID. `preferences.map.arcgisWkid` names that system;
 * absent means the default Web Mercator map. The SDK cannot reproject tiled
 * layers (XYZ, Esri basemaps), so in another projection those do not draw.
 */

/** A projection offered in the settings picker. */
export interface ArcgisProjectionPreset {
  /** The Esri or EPSG well-known ID the SDK resolves. */
  wkid: number;
  /** English name; the UI translates it by `id`. */
  name: string;
  /** Stable key for the translated name (`settings.map.arcgisProjections.<id>`). */
  id: string;
}

/** WKIDs that are Web Mercator, i.e. the default map. */
const WEB_MERCATOR_WKIDS: ReadonlySet<number> = new Set([3857, 102100, 102113, 900913]);

/** Presets, verified to load and frame in the SDK pinned by `ARCGIS_SDK_VERSION`. */
export const ARCGIS_PROJECTION_PRESETS: readonly ArcgisProjectionPreset[] = [
  { id: "spilhaus", wkid: 54099, name: "Spilhaus (World Ocean)" },
  { id: "equalEarth", wkid: 8857, name: "Equal Earth" },
  { id: "robinson", wkid: 54030, name: "Robinson" },
  { id: "winkelTripel", wkid: 54042, name: "Winkel Tripel" },
  { id: "mollweide", wkid: 54009, name: "Mollweide" },
  { id: "plateCarree", wkid: 4326, name: "Plate Carrée (WGS 84)" },
  { id: "northPolar", wkid: 3995, name: "Arctic Polar Stereographic" },
  { id: "southPolar", wkid: 3031, name: "Antarctic Polar Stereographic" },
];

/**
 * Normalize a stored ArcGIS projection WKID.
 *
 * Args:
 *   value: The raw `preferences.map.arcgisWkid` value.
 *
 * Returns:
 *   A positive integer WKID other than Web Mercator, or `undefined` for the
 *   default Web Mercator map (absent, malformed or a Web Mercator code).
 */
export function normalizeArcgisWkid(value: unknown): number | undefined {
  const wkid = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof wkid !== "number" || !Number.isInteger(wkid) || wkid <= 0) return undefined;
  return WEB_MERCATOR_WKIDS.has(wkid) ? undefined : wkid;
}
