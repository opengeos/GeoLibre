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

/**
 * Plugins toggled from other menus (Effects/Directions/Reverse Geocode via the
 * Controls menu, deck.gl viz via Add Data), so they are excluded from the
 * Plugins menu and from the UI-profile plugin lists. Keep in sync with
 * `PluginsMenu`'s skip list. Literal ids (mirroring `EFFECTS_PLUGIN_ID` etc.
 * from `@geolibre/plugins`) so this module stays free of the heavy plugin
 * barrel and can be unit-tested in Node.
 */
export const MENU_MANAGED_PLUGIN_IDS = new Set<string>([
  "maplibre-atmosphere-effects", // EFFECTS_PLUGIN_ID
  "maplibre-gl-directions", // DIRECTIONS_PLUGIN_ID
  "maplibre-reverse-geocode", // REVERSE_GEOCODE_PLUGIN_ID
  "maplibre-deckgl-viz", // DECK_VIZ_PLUGIN_ID
]);

/** The plugin ids that participate in the UI profile (excludes the menu-managed
 * plugins above), used when computing presets. */
export function toggleablePluginIds(
  plugins: ReadonlyArray<{ id: string }>,
): string[] {
  return plugins
    .filter((plugin) => !MENU_MANAGED_PLUGIN_IDS.has(plugin.id))
    .map((plugin) => plugin.id);
}

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
  { id: "duckdb", section: "databases", labelKey: "toolbar.item.duckdbLayer", tier: "intermediate" },
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
  "maplibre-gl-usgs-lidar": "advanced",
  "maplibre-gl-overture-maps": "advanced",
  "maplibre-gl-time-slider": "advanced",
  "maplibre-gl-components": "advanced",
  "maplibre-gl-streetview": "advanced",
};

/** Top-level toolbar menus that can be hidden as a whole (Settings is excluded
 * so the profile UI can never be locked away). */
export type TopLevelMenuId =
  | "project"
  | "edit"
  | "view"
  | "addData"
  | "processing"
  | "controls"
  | "plugins"
  | "help";

export interface TopLevelMenuEntry {
  id: TopLevelMenuId;
  labelKey: ParseKeys;
  tier: ComplexityTier;
}

/** Hideable top-level menus, in toolbar order. */
export const TOP_LEVEL_MENUS: readonly TopLevelMenuEntry[] = [
  { id: "project", labelKey: "toolbar.menu.project", tier: "basic" },
  { id: "edit", labelKey: "toolbar.menu.edit", tier: "basic" },
  { id: "view", labelKey: "toolbar.menu.view", tier: "basic" },
  { id: "addData", labelKey: "toolbar.menu.addData", tier: "basic" },
  // Processing exposes analysis tools aimed at intermediate+ users; hide the
  // whole menu for beginners.
  { id: "processing", labelKey: "toolbar.menu.processing", tier: "intermediate" },
  { id: "controls", labelKey: "toolbar.menu.controls", tier: "basic" },
  // The Layer Control and Basemap plugins are active by default, so the Plugins
  // menu must stay reachable at every level to toggle them; the advanced plugins
  // inside are still hidden per their own tier.
  { id: "plugins", labelKey: "toolbar.menu.plugins", tier: "basic" },
  { id: "help", labelKey: "toolbar.menu.help", tier: "basic" },
];

/** The menu a catalog item belongs to: a hideable top-level menu, or Settings
 * (whose dropdown items are toggleable even though the menu itself always shows). */
export type MenuOwnerId = TopLevelMenuId | "settings";

export interface MenuItemCatalogEntry {
  id: string;
  /** Owning menu id, used to group the Settings checklist. */
  menuId: MenuOwnerId;
  labelKey: ParseKeys;
  tier: ComplexityTier;
}

/**
 * Individually toggleable items across the Project, Edit, Processing, Controls,
 * Settings, and Help menus. Submenus (Conversion, Vector, Raster, …) are single
 * toggles, not per-tool. Add Data items and plugins use `DATA_SOURCE_CATALOG`
 * and `PLUGIN_TIERS` instead. Keep ids in sync with the menu components.
 */
export const MENU_ITEM_CATALOG: readonly MenuItemCatalogEntry[] = [
  // Project
  { id: "project.new", menuId: "project", labelKey: "toolbar.item.newEllipsis", tier: "basic" },
  { id: "project.openFrom", menuId: "project", labelKey: "toolbar.item.openFrom", tier: "basic" },
  { id: "project.openRecent", menuId: "project", labelKey: "toolbar.item.openRecent", tier: "basic" },
  { id: "project.save", menuId: "project", labelKey: "common.save", tier: "basic" },
  { id: "project.saveAs", menuId: "project", labelKey: "toolbar.item.saveAsEllipsis", tier: "basic" },
  { id: "project.share", menuId: "project", labelKey: "toolbar.item.shareEllipsis", tier: "intermediate" },
  { id: "project.collaborate", menuId: "project", labelKey: "toolbar.item.collaborateEllipsis", tier: "advanced" },
  { id: "project.print", menuId: "project", labelKey: "toolbar.item.printEllipsis", tier: "intermediate" },
  // Print Layout is the primary way any user turns a map into a shareable PDF/PNG
  // deliverable, so it stays visible for every profile (GH #529).
  { id: "project.printLayout", menuId: "project", labelKey: "toolbar.item.printLayoutEllipsis", tier: "basic" },
  { id: "project.offlineRegion", menuId: "project", labelKey: "toolbar.item.offlineRegionEllipsis", tier: "advanced" },
  { id: "project.offlineManager", menuId: "project", labelKey: "toolbar.item.offlineManagerEllipsis", tier: "advanced" },
  { id: "project.storymap", menuId: "project", labelKey: "toolbar.item.storymapEllipsis", tier: "advanced" },
  // Edit
  { id: "edit.undo", menuId: "edit", labelKey: "toolbar.item.undo", tier: "basic" },
  { id: "edit.redo", menuId: "edit", labelKey: "toolbar.item.redo", tier: "basic" },
  // View
  { id: "view.zoomIn", menuId: "view", labelKey: "toolbar.item.zoomIn", tier: "basic" },
  { id: "view.zoomOut", menuId: "view", labelKey: "toolbar.item.zoomOut", tier: "basic" },
  { id: "view.previousView", menuId: "view", labelKey: "toolbar.item.previousView", tier: "basic" },
  { id: "view.nextView", menuId: "view", labelKey: "toolbar.item.nextView", tier: "basic" },
  { id: "view.resetNorth", menuId: "view", labelKey: "toolbar.item.resetNorth", tier: "basic" },
  { id: "view.resetPitchBearing", menuId: "view", labelKey: "toolbar.item.resetPitchBearing", tier: "basic" },
  { id: "view.setView", menuId: "view", labelKey: "toolbar.item.setView", tier: "intermediate" },
  // Processing
  { id: "processing.assistant", menuId: "processing", labelKey: "toolbar.command.assistant", tier: "intermediate" },
  { id: "processing.whitebox", menuId: "processing", labelKey: "toolbar.item.whitebox", tier: "advanced" },
  { id: "processing.sqlWorkspace", menuId: "processing", labelKey: "toolbar.command.sqlWorkspace", tier: "intermediate" },
  { id: "processing.pythonConsole", menuId: "processing", labelKey: "toolbar.command.pythonConsole", tier: "advanced" },
  { id: "processing.notebook", menuId: "processing", labelKey: "toolbar.command.notebook", tier: "advanced" },
  { id: "processing.dashboard", menuId: "processing", labelKey: "toolbar.command.dashboard", tier: "intermediate" },
  { id: "processing.geocode", menuId: "processing", labelKey: "toolbar.item.geocode", tier: "intermediate" },
  { id: "processing.modelBuilder", menuId: "processing", labelKey: "toolbar.item.modelBuilder", tier: "advanced" },
  { id: "processing.conversion", menuId: "processing", labelKey: "toolbar.item.conversion", tier: "intermediate" },
  { id: "processing.vector", menuId: "processing", labelKey: "toolbar.item.vector", tier: "intermediate" },
  { id: "processing.network", menuId: "processing", labelKey: "toolbar.item.network", tier: "advanced" },
  { id: "processing.statistics", menuId: "processing", labelKey: "toolbar.item.statistics", tier: "advanced" },
  { id: "processing.raster", menuId: "processing", labelKey: "toolbar.item.raster", tier: "advanced" },
  { id: "processing.segmentation", menuId: "processing", labelKey: "toolbar.command.segmentation", tier: "advanced" },
  { id: "processing.planetaryComputer", menuId: "processing", labelKey: "toolbar.command.planetaryComputer", tier: "advanced" },
  { id: "processing.earthEngine", menuId: "processing", labelKey: "toolbar.command.earthEngine", tier: "advanced" },
  // Controls — built-in map controls
  { id: "controls.mapControl.navigation", menuId: "controls", labelKey: "toolbar.mapControl.navigation", tier: "basic" },
  { id: "controls.mapControl.fullscreen", menuId: "controls", labelKey: "toolbar.mapControl.fullscreen", tier: "basic" },
  // Shown on the map by default, so toggleable at every level (a beginner must
  // be able to turn it off).
  { id: "controls.mapControl.compass", menuId: "controls", labelKey: "toolbar.mapControl.compass", tier: "basic" },
  { id: "controls.mapControl.geolocate", menuId: "controls", labelKey: "toolbar.mapControl.geolocate", tier: "intermediate" },
  // Globe, Scale, and Attribution are shown on the map by default, so they must
  // be toggleable at every level (otherwise a beginner sees them with no way to
  // turn them off).
  { id: "controls.mapControl.globe", menuId: "controls", labelKey: "toolbar.mapControl.globe", tier: "basic" },
  { id: "controls.mapControl.terrain", menuId: "controls", labelKey: "toolbar.mapControl.terrain", tier: "intermediate" },
  { id: "controls.mapControl.scale", menuId: "controls", labelKey: "toolbar.mapControl.scale", tier: "basic" },
  { id: "controls.mapControl.attribution", menuId: "controls", labelKey: "toolbar.mapControl.attribution", tier: "basic" },
  { id: "controls.mapControl.logo", menuId: "controls", labelKey: "toolbar.mapControl.logo", tier: "advanced" },
  // Controls — overlays and panels
  // Basic so Beginners keep the toggle: Atmospheric Effects is activeByDefault,
  // so hiding it would leave the effect on with no way to turn it off.
  { id: "controls.atmosphereEffects", menuId: "controls", labelKey: "toolbar.item.atmosphereEffects", tier: "basic" },
  { id: "controls.spinGlobe", menuId: "controls", labelKey: "toolbar.item.spinGlobe", tier: "intermediate" },
  { id: "controls.directions", menuId: "controls", labelKey: "toolbar.item.directions", tier: "intermediate" },
  { id: "controls.reverseGeocode", menuId: "controls", labelKey: "toolbar.item.reverseGeocode", tier: "intermediate" },
  { id: "controls.search", menuId: "controls", labelKey: "toolbar.item.search", tier: "basic" },
  { id: "controls.colorbar", menuId: "controls", labelKey: "toolbar.item.colorbar", tier: "intermediate" },
  { id: "controls.legend", menuId: "controls", labelKey: "toolbar.item.legend", tier: "intermediate" },
  { id: "controls.html", menuId: "controls", labelKey: "toolbar.item.html", tier: "advanced" },
  { id: "controls.measure", menuId: "controls", labelKey: "toolbar.item.measure", tier: "intermediate" },
  { id: "controls.bookmark", menuId: "controls", labelKey: "toolbar.item.bookmark", tier: "intermediate" },
  { id: "controls.minimap", menuId: "controls", labelKey: "toolbar.item.minimap", tier: "intermediate" },
  { id: "controls.viewState", menuId: "controls", labelKey: "toolbar.item.viewState", tier: "advanced" },
  { id: "controls.fieldCollection", menuId: "controls", labelKey: "toolbar.item.fieldCollection", tier: "advanced" },
  // Settings (the Settings menu and its Language/Layout/Interface entries always show)
  { id: "settings.mapPreferences", menuId: "settings", labelKey: "settings.menu.mapPreferences", tier: "intermediate" },
  { id: "settings.geocoding", menuId: "settings", labelKey: "settings.menu.geocoding", tier: "advanced" },
  // Kept in step with the AI Assistant (which reads its API key from here).
  { id: "settings.environment", menuId: "settings", labelKey: "settings.menu.environmentVariables", tier: "intermediate" },
  { id: "settings.managePlugins", menuId: "settings", labelKey: "settings.menu.managePlugins", tier: "intermediate" },
  // Help
  { id: "help.commandPalette", menuId: "help", labelKey: "toolbar.item.commandPalette", tier: "basic" },
  { id: "help.keyboardShortcuts", menuId: "help", labelKey: "toolbar.command.keyboardShortcuts", tier: "intermediate" },
  { id: "help.diagnostics", menuId: "help", labelKey: "toolbar.command.diagnostics", tier: "advanced" },
  { id: "help.feedback", menuId: "help", labelKey: "toolbar.command.giveFeedback", tier: "intermediate" },
  { id: "help.checkForUpdates", menuId: "help", labelKey: "toolbar.command.checkForUpdates", tier: "intermediate" },
  { id: "help.about", menuId: "help", labelKey: "toolbar.command.about", tier: "basic" },
];

/** Group order + header label key for the per-menu item checklists in Settings. */
export const MENU_ITEM_GROUPS: ReadonlyArray<{
  menuId: MenuOwnerId;
  labelKey: ParseKeys;
}> = [
  { menuId: "project", labelKey: "toolbar.menu.project" },
  { menuId: "edit", labelKey: "toolbar.menu.edit" },
  { menuId: "view", labelKey: "toolbar.menu.view" },
  { menuId: "processing", labelKey: "toolbar.menu.processing" },
  { menuId: "controls", labelKey: "toolbar.menu.controls" },
  { menuId: "settings", labelKey: "settings.title" },
  { menuId: "help", labelKey: "toolbar.menu.help" },
];

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
export interface HiddenSets {
  hiddenDataSources: string[];
  hiddenPlugins: string[];
  hiddenMenus: string[];
  hiddenMenuItems: string[];
}

export function presetHiddenSets(
  level: ExperienceLevel,
  pluginIds: readonly string[],
): HiddenSets {
  const hiddenDataSources = DATA_SOURCE_CATALOG.filter(
    (entry) => !levelAllowsTier(level, entry.tier),
  ).map((entry) => entry.id);
  const hiddenPlugins = pluginIds.filter(
    (id) => !levelAllowsTier(level, pluginTier(id)),
  );
  const hiddenMenus = TOP_LEVEL_MENUS.filter(
    (menu) => !levelAllowsTier(level, menu.tier),
  ).map((menu) => menu.id);
  const hiddenMenuItems = MENU_ITEM_CATALOG.filter(
    (entry) => !levelAllowsTier(level, entry.tier),
  ).map((entry) => entry.id);
  return { hiddenDataSources, hiddenPlugins, hiddenMenus, hiddenMenuItems };
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

/** Whether a top-level toolbar menu should be shown. */
export function isMenuVisible(
  profile: UiProfileSettings,
  menuId: string,
): boolean {
  return !profile.enabled || !profile.hiddenMenus.includes(menuId);
}

/** Whether a menu-item catalog id should be shown in its menu. */
export function isMenuItemVisible(
  profile: UiProfileSettings,
  itemId: string,
): boolean {
  return !profile.enabled || !profile.hiddenMenuItems.includes(itemId);
}

/**
 * The four interface-profile states surfaced in the UI. The three
 * experience levels are developer-curated presets; `"custom"` is entered
 * automatically when the user toggles an individual item away from a preset.
 */
export type InterfaceProfile = ExperienceLevel | "custom";

/** Interface-profile options in display order (the three presets, then custom). */
export const INTERFACE_PROFILES: readonly InterfaceProfile[] = [
  "beginner",
  "intermediate",
  "advanced",
  "custom",
];

/**
 * Derive the active interface profile from the stored settings.
 * A disabled profile (the legacy/default "show everything" state) reads as
 * Advanced, since the Advanced preset also reveals every item. An enabled
 * profile reports its preset level, or `"custom"` once the user has hand-edited
 * the hidden lists.
 *
 * @param profile - The stored UI-profile settings.
 * @returns The active interface profile to highlight in the UI.
 */
export function activeInterfaceProfile(
  profile: UiProfileSettings,
): InterfaceProfile {
  if (!profile.enabled) return "advanced";
  return profile.level ?? "custom";
}

/**
 * Whether advanced, developer-facing notices (the layer-panel "Advanced
 * formats" footer, the Layout tab's URL-params note) should be shown. Hidden for
 * the curated Beginner/Intermediate presets; shown when the profile is off, on
 * the Advanced preset, or for a custom profile.
 */
export function showsAdvancedNotices(profile: UiProfileSettings): boolean {
  if (!profile.enabled) return true;
  return profile.level === null || profile.level === "advanced";
}
