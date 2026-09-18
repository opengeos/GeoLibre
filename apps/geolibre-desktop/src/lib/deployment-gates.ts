// Maps the app's own surfaces onto the deployment capability vocabulary
// (`@geolibre/core`'s `DeploymentCapability`, issue #1673).
//
// The vocabulary is deliberately coarse, so each surface needs a table saying
// which of its ids fall under which capability. Keeping those tables in one
// module is the point: the toolbar menus, the Project menu, the command
// palette, the cheat sheet, and the global shortcut layer all reach the same
// handlers, and a gate applied to only some of them is not a gate.
//
// This is not the interface profile (`ui-profile.ts`), which hides items to
// reduce clutter and which the user can turn back on. A denied capability is a
// statement by whoever stood the deployment up.

import type { AppPrivilege, DeploymentCapability } from "@geolibre/core";
import type { Command } from "./commands";

/**
 * The capability each command family needs, keyed by command-id prefix.
 *
 * Ordered: the first matching prefix wins, so a specific id can be listed ahead
 * of the family prefix it belongs to.
 */
const COMMAND_CAPABILITY_PREFIXES: ReadonlyArray<readonly [string, DeploymentCapability]> = [
  // A review comment is stored in the project file, so it is project authoring
  // rather than adding data, despite sitting in the Add Data group.
  ["add.comment", "project:edit"],
  ["add.", "data:add"],
  ["proc.", "processing:run"],
  // The print layout designer exists to get a rendering back out, and sharing
  // puts the project itself on a server outside the deployment. Both are
  // classified the same way in PROJECT_MENU_ITEM_CAPABILITIES below; the two
  // tables disagreeing is what leaves an action hidden in the menu but live in
  // the palette.
  ["project.print-layout", "export:data"],
  ["project.share", "export:data"],
  // Includes opening a different project: a deployment that pins what may be
  // authored also pins which project is on screen.
  ["project.", "project:edit"],
  // Activating a plugin and opening the marketplace both belong to the plugin
  // gate, not the settings one: the toolbar hides the whole Plugins menu on
  // `plugins:install`, and "Manage plugins" is the marketplace despite its
  // `settings.` id.
  ["plugin.", "plugins:install"],
  ["settings.manage-plugins", "plugins:install"],
  ["settings.", "settings:manage"],
  // `control.`, `view.`, and `help.` are unprivileged: they move the camera,
  // toggle map decorations, and open documentation. A locked-down deployment
  // still wants all of them.
];

/**
 * The capability a command requires, or undefined when it requires none.
 *
 * @param id - The command id, e.g. `"proc.whitebox"`.
 * @returns The required capability, or undefined for unprivileged commands.
 */
export function commandCapability(id: string): DeploymentCapability | undefined {
  for (const [prefix, capability] of COMMAND_CAPABILITY_PREFIXES) {
    if (id.startsWith(prefix)) return capability;
  }
  return undefined;
}

/**
 * Drop commands this deployment is not allowed to run.
 *
 * The capability checks on the toolbar menus only hide menus. The command
 * palette, the cheat sheet, and the global shortcut layer reach the same
 * `run()` handlers without going through a menu, so they have to be filtered
 * too — an unfiltered palette leaves a denied action both advertised and
 * callable.
 *
 * @param commands - The full command registry.
 * @param capabilities - What this deployment may do.
 * @returns The commands whose required capability is granted.
 */
export function filterCommandsByCapabilities(
  commands: Command[],
  capabilities: ReadonlySet<DeploymentCapability>,
): Command[] {
  return commands.filter((command) => {
    const required = commandCapability(command.id);
    return !required || capabilities.has(required);
  });
}

// The same job for the *application privilege* vocabulary (`AppPrivilege`,
// issue #1672), which is finer-grained than the deployment one and describes
// what the session's role may do rather than what the build may offer. Both
// tables live here for the reason this module exists: the palette, the cheat
// sheet, and the global shortcut layer call a command's `run()` without going
// near the menu it also appears in, so a gate applied only to the menu is not a
// gate. A command must clear both vocabularies to survive.

/**
 * What a command requires from the application privilege model.
 *
 * Two modes, because the two real cases differ: an Add Data command is admitted
 * by *either* add privilege (one dialog takes a local file and a URL, so it
 * cannot be split more finely), while a sidecar-backed tool needs *both*
 * `processing:run` and `processing:sidecar` — it is a processing tool first, and
 * the sidecar is how it runs.
 */
export interface CommandPrivilegeRule {
  /** The privileges named by the rule. */
  privileges: readonly AppPrivilege[];
  /** `any`: one grant admits the command. `all`: every listed privilege is required. */
  mode: "any" | "all";
}

/** A rule satisfied by any one of the listed privileges. */
function any(...privileges: AppPrivilege[]): CommandPrivilegeRule {
  return { privileges, mode: "any" };
}

/** A rule requiring every listed privilege. */
function all(...privileges: AppPrivilege[]): CommandPrivilegeRule {
  return { privileges, mode: "all" };
}

/**
 * The application privileges each command family needs, keyed by command-id
 * prefix.
 *
 * Ordered like `COMMAND_CAPABILITY_PREFIXES`: first matching prefix wins, so a
 * specific id can be listed ahead of the family prefix it belongs to.
 */
const COMMAND_PRIVILEGE_PREFIXES: ReadonlyArray<readonly [string, CommandPrivilegeRule]> = [
  // A review comment annotates the project rather than bringing data in.
  ["add.comment", any("layers:edit")],
  // The Add Data panels take a local file and a URL through the same dialog, so
  // a command here cannot be classified more finely than "may bring in data at
  // all". Either privilege admits it; a finer split would have to live in the
  // panel, where the user picks a file or types a URL.
  ["add.", any("layers:add-local", "layers:add-remote")],
  ["proc.assistant", any("assistant:use")],
  // The three sidecar-backed families: AI Segmentation, Format Conversion
  // (`proc.conversion.*`), and the Raster tools (`proc.raster.*`). They need
  // `processing:run` as well as `processing:sidecar` — a sidecar tool is a
  // processing tool first, and the sidecar is only how it runs. The Processing
  // menu gates all three the same way (`sidecarDenied`), and the two tables
  // disagreeing is what leaves an action greyed out in a menu but live in the
  // palette. `proc.vector.*` is deliberately absent: Turf runs client-side.
  ["proc.segmentation", all("processing:run", "processing:sidecar")],
  ["proc.conversion.", all("processing:run", "processing:sidecar")],
  ["proc.raster.", all("processing:run", "processing:sidecar")],
  // Two catalog browsers filed under `proc.` that add remote imagery rather than
  // run a tool. Classified with the Processing menu's own gates for them, so the
  // palette and the menu agree.
  ["proc.planetary-computer", any("layers:add-remote")],
  ["proc.earth-engine", any("layers:add-remote")],
  ["proc.", any("processing:run")],
  // The print layout designer exists to produce a rendering; Share and
  // collaboration both put the project on a server outside this machine. Matches
  // how the Project menu gates the same three actions.
  ["project.print-layout", any("export:image")],
  ["project.share", any("project:share")],
  ["project.collaborate", any("project:share")],
  // Covers `project.save-as` as well as `project.save`.
  ["project.save", any("project:save")],
  ["plugin.", any("plugins:install")],
  ["settings.manage-plugins", any("plugins:install")],
  ["settings.", any("settings:manage")],
  // `project.new` / `project.open-*`, `control.`, `view.`, and `help.` are
  // unprivileged: this vocabulary has no "may author the project at all" term,
  // and the rest move the camera, toggle decorations, and open documentation.
];

/**
 * The privilege rule a command must satisfy, or undefined when it requires none.
 *
 * @param id - The command id, e.g. `"proc.whitebox"`.
 * @returns The rule, or undefined for unprivileged commands.
 */
export function commandAppPrivileges(id: string): CommandPrivilegeRule | undefined {
  for (const [prefix, rule] of COMMAND_PRIVILEGE_PREFIXES) {
    if (id.startsWith(prefix)) return rule;
  }
  return undefined;
}

/**
 * Whether a set of granted privileges satisfies a rule.
 *
 * @param rule - The rule from {@link commandAppPrivileges}.
 * @param granted - The privileges the session's role holds.
 * @returns Whether the command may run.
 */
function satisfies(rule: CommandPrivilegeRule, granted: ReadonlySet<AppPrivilege>): boolean {
  return rule.mode === "all"
    ? rule.privileges.every((privilege) => granted.has(privilege))
    : rule.privileges.some((privilege) => granted.has(privilege));
}

/**
 * Drop commands the session's role is not allowed to run.
 *
 * The counterpart to {@link filterCommandsByCapabilities} for the application
 * privilege model. The toolbar menus *disable* what a role withholds, so the
 * user can see it exists and read why; the palette, cheat sheet, and shortcut
 * layer have no such affordance and call `run()` directly, so they drop it
 * instead — the same treatment the deployment gate gives.
 *
 * @param commands - The command registry.
 * @param privileges - What the session's role may do.
 * @returns The commands whose required privilege is granted.
 */
export function filterCommandsByPrivileges(
  commands: Command[],
  privileges: readonly AppPrivilege[],
): Command[] {
  const granted = new Set<AppPrivilege>(privileges);
  return commands.filter((command) => {
    const rule = commandAppPrivileges(command.id);
    return !rule || satisfies(rule, granted);
  });
}

/**
 * The capability each Project-menu item needs, keyed by its `ui-profile.ts`
 * menu-item catalog id.
 *
 * Spelled out per id rather than by prefix, because the Project menu mixes
 * authoring, export, and navigation under one `project.` namespace. An id
 * absent from this table is unprivileged.
 */
const PROJECT_MENU_ITEM_CAPABILITIES: Readonly<Record<string, DeploymentCapability>> = {
  "project.new": "project:edit",
  // Opening (from a file, from the recent list, from a QGIS/ArcGIS import) puts
  // a different project on screen, which is exactly what a pinned deployment
  // does not want; it is also the path by which the app reads arbitrary files.
  "project.openFrom": "project:edit",
  "project.openRecent": "project:edit",
  "project.import": "project:edit",
  "project.history": "project:edit",
  "project.save": "project:edit",
  "project.saveAs": "project:edit",
  "project.duplicate": "project:edit",
  "project.saveAsTemplate": "project:edit",
  "project.collaborate": "project:edit",
  "project.storymap": "project:edit",
  // Everything that gets data or a rendering back out of the deployment.
  "project.share": "export:data",
  "project.exportHtml": "export:data",
  "project.print": "export:data",
  "project.printLayout": "export:data",
  "project.offlineRegion": "export:data",
};

/**
 * The capability each Edit-menu item needs, keyed by its `ui-profile.ts`
 * menu-item catalog id.
 *
 * Only the items that change the project are listed. The selection tools
 * (select by expression/location, invert, clear, zoom to selection) act on
 * `selectedFeatureIds`, which is ephemeral store state that never reaches the
 * project file — a kiosk still wants them.
 */
const EDIT_MENU_ITEM_CAPABILITIES: Readonly<Record<string, DeploymentCapability>> = {
  "edit.undo": "project:edit",
  "edit.redo": "project:edit",
  // "Export Selection" names an export but adds a layer built from features
  // already loaded — no file, URL, or service — so by the vocabulary's own
  // definitions this is authoring the project, not `data:add` or `export:data`.
  "edit.exportSelection": "project:edit",
};

/**
 * The capability an Edit-menu item requires, or undefined when it requires
 * none.
 *
 * @param id - The menu-item catalog id, e.g. `"edit.undo"`.
 * @returns The required capability, or undefined for unprivileged items.
 */
export function editMenuItemCapability(id: string): DeploymentCapability | undefined {
  return EDIT_MENU_ITEM_CAPABILITIES[id];
}

/**
 * The capability a Project-menu item requires, or undefined when it requires
 * none.
 *
 * @param id - The menu-item catalog id, e.g. `"project.saveAs"`.
 * @returns The required capability, or undefined for unprivileged items.
 */
export function projectMenuItemCapability(id: string): DeploymentCapability | undefined {
  return PROJECT_MENU_ITEM_CAPABILITIES[id];
}
