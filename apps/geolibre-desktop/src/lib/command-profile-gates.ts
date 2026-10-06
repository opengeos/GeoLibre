// Applies the interface profile (`ui-profile.ts`) and the mobile platform gate
// to the command palette.
//
// The toolbar menus hide what the active UI profile hides and what a mobile
// platform cannot run (the sidecar-backed tools). The palette reaches the same
// handlers without going through a menu, so without this table an item a
// beginner profile hid — or a Format Conversion tool on Android — would still
// be one Ctrl+K away. Unlike `deployment-gates.ts` this is clutter control, not
// access control: it only narrows what the palette *lists*. The shortcut layer
// and the cheat sheet keep the full registry, so hiding the View menu does not
// silently unbind "N" or "[".

import type { UiProfileSettings } from "../hooks/useDesktopSettings";
import type { Command } from "./commands";
import {
  DATA_SOURCE_CATALOG,
  isDataSourceVisible,
  isMenuItemVisible,
  isMenuVisible,
  isPluginVisible,
  type TopLevelMenuId,
} from "./ui-profile";

/** The top-level menu each command family lives in, keyed by id prefix. */
const COMMAND_MENU_PREFIXES: ReadonlyArray<readonly [string, TopLevelMenuId]> = [
  ["project.", "project"],
  ["add.", "addData"],
  ["proc.", "processing"],
  ["control.", "controls"],
  ["view.", "view"],
  ["help.", "help"],
  ["plugin.", "plugins"],
  // `settings.` has no entry: the Settings menu cannot be hidden, so the
  // profile UI is never locked away.
];

/**
 * The `MENU_ITEM_CATALOG` id that hides each command, keyed by command id or id
 * prefix (a trailing "."). Ordered: the first match wins, so an exact id can sit
 * ahead of the family prefix it would otherwise fall under. Commands with no
 * entry are governed by their menu alone.
 */
const COMMAND_MENU_ITEMS: ReadonlyArray<readonly [string, string]> = [
  ["project.new", "project.new"],
  // The starter examples open inside the New Project dialog.
  ["project.examples", "project.new"],
  ["project.open-file", "project.openFrom"],
  ["project.open-url", "project.openFrom"],
  ["project.save-as", "project.saveAs"],
  ["project.save", "project.save"],
  ["project.share", "project.share"],
  ["project.collaborate", "project.collaborate"],
  ["project.print-layout", "project.printLayout"],
  ["proc.whitebox", "processing.whitebox"],
  // One palette entry per Whitebox tool, gated like the category submenus.
  ["proc.whitebox.", "processing.whitebox"],
  ["proc.sql", "processing.sqlWorkspace"],
  ["proc.python", "processing.pythonConsole"],
  ["proc.assistant", "processing.assistant"],
  ["proc.geocode", "processing.geocode"],
  ["proc.modelBuilder", "processing.modelBuilder"],
  ["proc.batchTools", "processing.batchTools"],
  ["proc.segmentation", "processing.segmentation"],
  ["proc.objectDetection", "processing.objectDetection"],
  ["proc.segmentEverything", "processing.segmentEverything"],
  ["proc.conversion.", "processing.conversion"],
  ["proc.vector.", "processing.vector"],
  ["proc.network.", "processing.network"],
  ["proc.statistics.", "processing.statistics"],
  ["proc.raster.", "processing.raster"],
  // The Georeferencer sits at the foot of the Raster submenu.
  ["proc.georeferencer", "processing.raster"],
  ["proc.planetary-computer", "processing.planetaryComputer"],
  ["proc.earth-engine", "processing.earthEngine"],
  ["control.effects", "controls.atmosphereEffects"],
  ["control.directions", "controls.directions"],
  ["control.search", "controls.search"],
  ["control.colorbar", "controls.colorbar"],
  ["control.legend", "controls.legend"],
  ["control.html", "controls.html"],
  ["control.image", "controls.image"],
  ["control.measure", "controls.measure"],
  ["control.bookmark", "controls.bookmark"],
  ["control.minimap", "controls.minimap"],
  ["control.view-state", "controls.viewState"],
  ["control.field-collection", "controls.fieldCollection"],
  ["control.gps-tracking", "controls.gpsTracking"],
  // The remaining `control.<id>` commands toggle built-in map controls.
  ["control.", "controls.mapControl."],
  ["view.zoom-in", "view.zoomIn"],
  ["view.zoom-out", "view.zoomOut"],
  ["view.previous", "view.previousView"],
  ["view.next", "view.nextView"],
  ["view.reset-north", "view.resetNorth"],
  ["view.reset-pitch-bearing", "view.resetPitchBearing"],
  ["view.reset-pitch", "view.resetPitch"],
  ["view.set-view", "view.setView"],
  ["view.color-vision.", "view.colorVision"],
  ["help.shortcuts", "help.keyboardShortcuts"],
  ["help.website", "help.website"],
  ["help.github", "help.github"],
  ["help.diagnostics", "help.diagnostics"],
  ["help.feedback", "help.feedback"],
  ["help.updates", "help.checkForUpdates"],
  ["help.about", "help.about"],
  ["settings.manage-plugins", "settings.managePlugins"],
  ["settings.style-manager", "settings.styleManager"],
];

/**
 * Commands whose real control lives outside any profile-hideable menu, so the
 * profile never hides them: the theme toggle is a standalone toolbar button and
 * the Comments panel is a sidebar rail, both rendered whatever the profile.
 */
const PROFILE_EXEMPT_COMMANDS: ReadonlySet<string> = new Set(["view.theme", "view.comments"]);

const DATA_SOURCE_IDS: ReadonlySet<string> = new Set(DATA_SOURCE_CATALOG.map((entry) => entry.id));

/**
 * Commands the Processing menu hides on Android/iOS: everything that needs the
 * Python sidecar, which mobile platforms cannot run. Matches the `!mobile`
 * gates in `ProcessingMenu` (Format Conversion, the rasterio Raster leaves and
 * the Georeferencer below them, AI Segmentation). The WebAssembly Whitebox
 * toolbox and the client-side vector, network and statistics tools stay.
 */
const MOBILE_HIDDEN_PREFIXES: readonly string[] = [
  "proc.conversion.",
  "proc.raster.",
  "proc.georeferencer",
  "proc.segmentation",
];

/**
 * Whether `id` matches a table key: exactly, or as a prefix when the key ends
 * in ".".
 *
 * @param id - The command id.
 * @param key - The table key.
 * @returns Whether the key covers the id.
 */
function matches(id: string, key: string): boolean {
  return key.endsWith(".") ? id.startsWith(key) : id === key;
}

/**
 * The `MENU_ITEM_CATALOG` id that hides a command, if any.
 *
 * @param id - The command id, e.g. `"proc.vector.buffer"`.
 * @returns The menu-item id, or undefined when only the menu governs it.
 */
export function commandMenuItem(id: string): string | undefined {
  for (const [key, item] of COMMAND_MENU_ITEMS) {
    if (!matches(id, key)) continue;
    // A prefix that maps to a prefix (`control.` → `controls.mapControl.`)
    // carries the rest of the id over.
    return item.endsWith(".") ? item + id.slice(key.length) : item;
  }
  return undefined;
}

/**
 * Whether the active interface profile shows a command's menu entry.
 *
 * @param profile - The stored UI-profile settings.
 * @param id - The command id.
 * @returns False when the profile hides the command's menu, menu item, data
 *   source, or plugin.
 */
export function isCommandVisibleInProfile(profile: UiProfileSettings, id: string): boolean {
  if (!profile.enabled || PROFILE_EXEMPT_COMMANDS.has(id)) return true;
  const menu = COMMAND_MENU_PREFIXES.find(([prefix]) => id.startsWith(prefix))?.[1];
  if (menu && !isMenuVisible(profile, menu)) return false;
  if (id.startsWith("plugin.")) return isPluginVisible(profile, id.slice("plugin.".length));
  if (id.startsWith("add.")) {
    const source = id.slice("add.".length);
    return !DATA_SOURCE_IDS.has(source) || isDataSourceVisible(profile, source);
  }
  const item = commandMenuItem(id);
  return !item || isMenuItemVisible(profile, item);
}

/**
 * Whether a command is offered on a mobile platform.
 *
 * @param id - The command id.
 * @returns False for the sidecar-backed commands mobile platforms cannot run.
 */
export function isCommandAvailableOnMobile(id: string): boolean {
  return !MOBILE_HIDDEN_PREFIXES.some((key) => matches(id, key));
}

/**
 * Narrow the palette's commands to what the matching menus would show.
 *
 * @param commands - The commands that cleared the deployment and privilege gates.
 * @param profile - The stored UI-profile settings.
 * @param mobile - Whether the app runs on Android/iOS.
 * @returns The commands the palette may list.
 */
export function filterCommandsForPalette(
  commands: readonly Command[],
  profile: UiProfileSettings,
  mobile: boolean,
): Command[] {
  return commands.filter(
    (command) =>
      isCommandVisibleInProfile(profile, command.id) &&
      (!mobile || isCommandAvailableOnMobile(command.id)),
  );
}
