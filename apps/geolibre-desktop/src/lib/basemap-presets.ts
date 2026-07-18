import { getProtomapsStyleUrl, OPENFREEMAP_BASEMAPS, PROTOMAPS_BASEMAPS } from "@geolibre/core";

/**
 * Ids of the predefined basemaps that resolve to a ready-to-use style URL
 * (OpenFreeMap plus the Protomaps flavors). Excludes the dialog-only sentinels
 * for the blank background and a custom URL.
 */
export type PresetBasemapId =
  | (typeof OPENFREEMAP_BASEMAPS)[number]["id"]
  | (typeof PROTOMAPS_BASEMAPS)[number]["id"];

/** A predefined basemap reduced to the fields the pickers need. */
export interface PresetBasemap {
  id: PresetBasemapId;
  name: string;
  styleUrl: string;
}

/**
 * The OpenFreeMap "Liberty 3D" preset id. It shares Liberty's style URL but
 * additionally tilts the camera into a 3D view, so callers special-case it. The
 * `satisfies` constraint keeps this literal in sync with `OPENFREEMAP_BASEMAPS`:
 * renaming the id there turns this into a compile error rather than a silently
 * dead branch.
 */
export const LIBERTY_3D_ID = "liberty-3d" satisfies PresetBasemapId;

/** The OpenFreeMap presets, always available (no API key required). */
export function getOpenFreeMapPresets(): PresetBasemap[] {
  return OPENFREEMAP_BASEMAPS.map((basemap) => ({
    id: basemap.id,
    name: basemap.name,
    styleUrl: basemap.styleUrl,
  }));
}

/**
 * Resolves the selectable Protomaps basemaps for the current runtime
 * environment. Returns an empty list when no `VITE_PROTOMAPS_API_KEY` is
 * configured (build-time or via Settings → Environment variables), in which
 * case the Protomaps section is hidden.
 */
export function resolveProtomapsPresets(): PresetBasemap[] {
  return PROTOMAPS_BASEMAPS.flatMap((basemap) => {
    const styleUrl = getProtomapsStyleUrl(basemap.flavor);
    return styleUrl ? [{ id: basemap.id, name: basemap.name, styleUrl }] : [];
  });
}
