// Customizable UI profiles / data-source filtering (issue #500).
//
// A single complexity *tier* drives everything. Each filterable item (a data
// source in the Add Data menu, or a plugin in the Plugins menu) is assigned a
// tier; an experience-level preset shows every item at or below the chosen
// level. Presets compute concrete hidden-id lists, which is all the runtime
// filters on. See `docs/ui-profiles.md`.

import type { ParseKeys } from "i18next";
import type {
  ExperienceLevel,
  UiProfileSettings,
} from "../hooks/useDesktopSettings";

export type ComplexityTier = "basic" | "intermediate" | "advanced";

/** Section groupings shared with the Add Data menu and the Settings checklist. */
export type DataSourceSection =
  | "files"
  | "webServices"
  | "cloud"
  | "threeD"
  | "databases";

export interface DataSourceCatalogEntry {
  /** Stable id used in the hidden list and as the Add Data menu handler key. */
  id: string;
  section: DataSourceSection;
  labelKey: ParseKeys;
  tier: ComplexityTier;
}

/** i18n label key for each data-source section header. */
export const DATA_SOURCE_SECTION_LABEL_KEYS: Record<
  DataSourceSection,
  ParseKeys
> = {
  files: "toolbar.item.sectionFiles",
  webServices: "toolbar.item.sectionWebServices",
  cloud: "toolbar.item.sectionCloudFormats",
  threeD: "toolbar.item.section3dLayers",
  databases: "toolbar.item.sectionDatabases",
};

/** Section render order, matching the Add Data menu. */
export const DATA_SOURCE_SECTION_ORDER: readonly DataSourceSection[] = [
  "files",
  "webServices",
  "cloud",
  "threeD",
  "databases",
];

/**
 * Every Add Data menu item, in menu order. The `id` is the contract between the
 * menu (which maps ids to handlers), the Settings checklist, and the persisted
 * hidden list. Keep this in sync with `AddDataMenu.tsx`.
 */
export const DATA_SOURCE_CATALOG: readonly DataSourceCatalogEntry[] = [
  // Files
  { id: "vector", section: "files", labelKey: "toolbar.item.vectorLayer", tier: "basic" },
  { id: "raster", section: "files", labelKey: "toolbar.item.rasterLayer", tier: "basic" },
  { id: "delimited-text", section: "files", labelKey: "toolbar.layerType.delimitedText", tier: "basic" },
  { id: "gpx", section: "files", labelKey: "toolbar.layerType.gpx", tier: "intermediate" },
  { id: "mbtiles", section: "files", labelKey: "toolbar.layerType.mbtiles", tier: "basic" },
  { id: "osm-pbf", section: "files", labelKey: "toolbar.item.osmPbfLayer", tier: "advanced" },
  // Web services
  { id: "xyz", section: "webServices", labelKey: "toolbar.layerType.xyz", tier: "basic" },
  { id: "wms", section: "webServices", labelKey: "toolbar.layerType.wms", tier: "basic" },
  { id: "wfs", section: "webServices", labelKey: "toolbar.layerType.wfs", tier: "intermediate" },
  { id: "wmts", section: "webServices", labelKey: "toolbar.layerType.wmts", tier: "intermediate" },
  { id: "arcgis", section: "webServices", labelKey: "toolbar.layerType.arcgis", tier: "intermediate" },
  { id: "stac", section: "webServices", labelKey: "toolbar.item.stacLayer", tier: "advanced" },
  { id: "video", section: "webServices", labelKey: "toolbar.layerType.video", tier: "advanced" },
  { id: "deckgl-viz", section: "webServices", labelKey: "toolbar.layerType.deckglViz", tier: "advanced" },
  // Cloud formats
  { id: "geoparquet", section: "cloud", labelKey: "toolbar.item.geoparquetLayer", tier: "basic" },
  { id: "flatgeobuf", section: "cloud", labelKey: "toolbar.item.flatgeobufLayer", tier: "intermediate" },
  { id: "pmtiles", section: "cloud", labelKey: "toolbar.item.pmtilesLayer", tier: "intermediate" },
  { id: "zarr", section: "cloud", labelKey: "toolbar.item.zarrLayer", tier: "advanced" },
  { id: "netcdf", section: "cloud", labelKey: "toolbar.item.netcdfHdf", tier: "advanced" },
  // 3D layers
  { id: "lidar", section: "threeD", labelKey: "toolbar.item.lidarLayer", tier: "advanced" },
  { id: "splatting", section: "threeD", labelKey: "toolbar.item.splattingLayer", tier: "advanced" },
  { id: "3d-tiles", section: "threeD", labelKey: "toolbar.item.threeDTilesLayer", tier: "advanced" },
  { id: "gltf-model", section: "threeD", labelKey: "toolbar.layerType.gltfModel", tier: "advanced" },
  // Databases
  { id: "duckdb", section: "databases", labelKey: "toolbar.item.duckdbLayer", tier: "basic" },
  { id: "postgres", section: "databases", labelKey: "toolbar.layerType.postgres", tier: "advanced" },
];

/**
 * Complexity tier per plugin id (the stable ids defined in
 * `packages/plugins/src/plugins/*`). Plugins not listed here default to
 * `intermediate`, so they are visible at Intermediate and Advanced but hidden
 * for Beginners.
 */
export const PLUGIN_TIERS: Record<string, ComplexityTier> = {
  "maplibre-layer-control": "basic",
  "maplibre-gl-basemap-control": "basic",
  "maplibre-gl-geo-editor": "basic",
  // Advanced web services and specialist tools.
  "maplibre-gl-fema-wms": "advanced",
  "maplibre-gl-nasa-earthdata": "advanced",
  "maplibre-gl-enviroatlas": "advanced",
  "maplibre-gl-national-map": "advanced",
  "maplibre-gl-esri-wayback": "advanced",
  "maplibre-gl-geoagent": "advanced",
  "maplibre-gl-lidar": "advanced",
  "maplibre-gl-overture-maps": "advanced",
  "maplibre-gl-time-slider": "advanced",
  "maplibre-gl-components": "advanced",
  "maplibre-gl-streetview": "advanced",
};

const DEFAULT_PLUGIN_TIER: ComplexityTier = "intermediate";

const TIER_RANK: Record<ComplexityTier, number> = {
  basic: 0,
  intermediate: 1,
  advanced: 2,
};

const LEVEL_RANK: Record<ExperienceLevel, number> = {
  beginner: 0,
  intermediate: 1,
  advanced: 2,
};

/** Whether the given experience level reveals items of the given tier. */
export function levelAllowsTier(
  level: ExperienceLevel,
  tier: ComplexityTier,
): boolean {
  return TIER_RANK[tier] <= LEVEL_RANK[level];
}

/** The tier for a plugin id, falling back to the default for unlisted plugins. */
export function pluginTier(pluginId: string): ComplexityTier {
  return PLUGIN_TIERS[pluginId] ?? DEFAULT_PLUGIN_TIER;
}

/**
 * Compute the hidden data-source and plugin id lists for an experience-level
 * preset. Used by the onboarding wizard, the Settings preset buttons, and the
 * admin config loader.
 *
 * @param level - The chosen experience level.
 * @param pluginIds - All currently registered plugin ids to tier.
 * @returns The hidden id lists to store on {@link UiProfileSettings}.
 */
export function presetHiddenSets(
  level: ExperienceLevel,
  pluginIds: readonly string[],
): { hiddenDataSources: string[]; hiddenPlugins: string[] } {
  const hiddenDataSources = DATA_SOURCE_CATALOG.filter(
    (entry) => !levelAllowsTier(level, entry.tier),
  ).map((entry) => entry.id);
  const hiddenPlugins = pluginIds.filter(
    (id) => !levelAllowsTier(level, pluginTier(id)),
  );
  return { hiddenDataSources, hiddenPlugins };
}

/** Whether a data-source id should be shown in the Add Data menu. */
export function isDataSourceVisible(
  profile: UiProfileSettings,
  id: string,
): boolean {
  return !profile.enabled || !profile.hiddenDataSources.includes(id);
}

/** Whether a plugin id should be shown in the Plugins menu. */
export function isPluginVisible(
  profile: UiProfileSettings,
  id: string,
): boolean {
  return !profile.enabled || !profile.hiddenPlugins.includes(id);
}
