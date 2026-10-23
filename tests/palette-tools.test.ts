import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NETWORK_TOOLS, STATISTICS_TOOLS, VECTOR_TOOLS } from "@geolibre/processing";
import type { TFunction } from "i18next";
import {
  buildToolbarCommands,
  type ToolbarCommandContext,
} from "../apps/geolibre-desktop/src/components/layout/toolbar/toolbar-commands";
import type { UiProfileSettings } from "../apps/geolibre-desktop/src/hooks/useDesktopSettings";
import {
  commandMenuItem,
  filterCommandsForPalette,
  isCommandAvailableOnMobile,
  isCommandVisibleInProfile,
} from "../apps/geolibre-desktop/src/lib/command-profile-gates";
import { type Command, filterCommands } from "../apps/geolibre-desktop/src/lib/commands";
import {
  filterCommandsByCapabilities,
  filterCommandsByPrivileges,
} from "../apps/geolibre-desktop/src/lib/deployment-gates";
import {
  buildPaletteToolCommands,
  type PaletteToolContext,
} from "../apps/geolibre-desktop/src/lib/palette-tools";
import { groupRankedCommands, paletteRows } from "../apps/geolibre-desktop/src/lib/palette-rows";
import { WHITEBOX_MENU_CATALOG } from "../apps/geolibre-desktop/src/lib/whitebox-menu-catalog";

const noop = () => {};

/** An identity `t` that honours `defaultValue`, like i18next with no catalog. */
const t = ((key: string, options?: { defaultValue?: string }) =>
  options?.defaultValue ?? key) as unknown as TFunction;

type Opened = Array<[string, string]>;

/**
 * A tool context that records which opener each command calls.
 *
 * @param existingIds - Ids the fixed registry already holds.
 * @returns The context and the log of `[opener, toolId]` calls.
 */
function toolContext(existingIds: Iterable<string> = []): {
  context: PaletteToolContext;
  opened: Opened;
} {
  const opened: Opened = [];
  return {
    opened,
    context: {
      t,
      existingIds: new Set(existingIds),
      openWhiteboxTool: (id) => opened.push(["whitebox", id]),
      openVectorTool: (kind) => opened.push(["vector", kind]),
      openNetworkTool: (kind) => opened.push(["network", kind]),
      openStatisticsTool: (kind) => opened.push(["statistics", kind]),
    },
  };
}

const WHITEBOX_IDS = new Set(
  WHITEBOX_MENU_CATALOG.flatMap((category) =>
    category.subcategories.flatMap((subcategory) => subcategory.tools.map((tool) => tool.id)),
  ),
);

/** The fixed registry's ids, from a context whose handlers are all no-ops. */
function fixedRegistryIds(): string[] {
  const base: Partial<ToolbarCommandContext> = {
    t: ((key: string) => key) as unknown as ToolbarCommandContext["t"],
    themeMode: "light",
    shareAvailable: true,
    collaboration: { enabled: true },
    capabilities: { nativeMapInstance: true },
    primaryRenderer: "maplibre",
    plugins: [],
    paletteExcludedPluginIds: new Set(),
    isPluginEngineSupported: () => true,
    earthEngineAvailable: true,
    isActive: () => false,
    mapControllerRef: { current: null },
    addLayer: new Proxy({} as ToolbarCommandContext["addLayer"], { get: () => noop }),
    panels: new Proxy({} as ToolbarCommandContext["panels"], {
      get: () => ({ visible: false, toggle: noop }),
    }),
  };
  const context = new Proxy(base, {
    get: (target, key) => (key in target ? target[key as keyof typeof target] : noop),
  }) as ToolbarCommandContext;
  return buildToolbarCommands(context).map((command) => command.id);
}

/**
 * A UI profile with the given hidden lists.
 *
 * @param hidden - The lists to set; everything else is visible.
 * @returns An enabled profile.
 */
function profile(hidden: Partial<UiProfileSettings> = {}): UiProfileSettings {
  return {
    enabled: true,
    level: null,
    onboarded: true,
    locked: false,
    hiddenDataSources: [],
    hiddenPlugins: [],
    hiddenMenus: [],
    hiddenMenuItems: [],
    ...hidden,
  } as UiProfileSettings;
}

const command = (id: string, group = "G", title = id): Command => ({
  id,
  title,
  group,
  run: noop,
});

describe("buildPaletteToolCommands", () => {
  it("lists every client tool and every Whitebox tool once, under proc. ids", () => {
    const { context } = toolContext();
    const commands = buildPaletteToolCommands(context);
    const ids = commands.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length, "ids are unique");
    assert.equal(
      commands.length,
      VECTOR_TOOLS.length + NETWORK_TOOLS.length + STATISTICS_TOOLS.length + WHITEBOX_IDS.size,
    );
    assert.ok(ids.every((id) => id.startsWith("proc.")));
    assert.ok(commands.length > 1_000, "the Whitebox catalog is included");
  });

  it("skips tools the fixed registry already lists under the same id", () => {
    const fixed = fixedRegistryIds();
    const { context } = toolContext(fixed);
    const ids = buildPaletteToolCommands(context).map((entry) => entry.id);
    assert.ok(!ids.includes("proc.vector.buffer"), "Buffer has a fixed command");
    assert.ok(ids.includes("proc.vector.random-extract"), "Random extract has none");
    assert.ok(ids.every((id) => !fixed.includes(id)));
  });

  it("preselects the chosen tool in the dialog that runs it", () => {
    const { context, opened } = toolContext();
    const byId = new Map(buildPaletteToolCommands(context).map((entry) => [entry.id, entry]));
    byId.get("proc.whitebox.slope")?.run();
    byId.get("proc.vector.buffer")?.run();
    byId.get("proc.network.isochrone")?.run();
    byId.get("proc.statistics.kernel-density")?.run();
    assert.deepEqual(opened, [
      ["whitebox", "slope"],
      ["vector", "buffer"],
      ["network", "isochrone"],
      ["statistics", "kernel-density"],
    ]);
  });

  it("titles tools from the catalog and keeps English names searchable", () => {
    const { context } = toolContext(fixedRegistryIds());
    const tools = buildPaletteToolCommands(context);
    const slope = tools.find((entry) => entry.id === "proc.whitebox.slope");
    assert.equal(slope?.title, "Slope");
    assert.equal(slope?.group, "processing.whitebox.toolbox");
    const vector = tools.find((entry) => entry.id === "proc.vector.random-extract");
    assert.equal(vector?.group, "toolbar.commandGroup.tools");
    // "fill_depressions" is reachable by its words as well as its title.
    const hits = filterCommands(tools, "fill depressions").map((entry) => entry.id);
    assert.ok(hits.includes("proc.whitebox.fill_depressions"));
  });

  it("finds Whitebox and client tools by name", () => {
    const { context } = toolContext(fixedRegistryIds());
    const tools = buildPaletteToolCommands(context);
    const slope = filterCommands(tools, "slope").map((entry) => entry.id);
    assert.equal(slope[0], "proc.whitebox.slope", "the exact-title prefix match ranks first");
    const stops = filterCommands(tools, "detect stops").map((entry) => entry.id);
    assert.ok(stops.includes("proc.vector.detect-stops"));
  });
});

describe("palette gates on tool commands", () => {
  const { context } = toolContext();
  const tools = buildPaletteToolCommands(context);

  it("drops every tool when the deployment withholds processing", () => {
    assert.deepEqual(filterCommandsByCapabilities(tools, new Set(["data:add"])), []);
    assert.deepEqual(filterCommandsByPrivileges(tools, ["layers:add-local"]), []);
    assert.equal(
      filterCommandsByPrivileges(tools, ["processing:run"]).length,
      tools.length,
      "client and Whitebox tools need no sidecar",
    );
  });

  it("follows the profile's Processing toggles", () => {
    const noWhitebox = filterCommandsForPalette(
      tools,
      profile({ hiddenMenuItems: ["processing.whitebox"] }),
      false,
    );
    assert.ok(noWhitebox.length > 0);
    assert.ok(noWhitebox.every((entry) => !entry.id.startsWith("proc.whitebox.")));
    const noStats = filterCommandsForPalette(
      tools,
      profile({ hiddenMenuItems: ["processing.statistics", "processing.network"] }),
      false,
    );
    assert.ok(noStats.every((entry) => !/^proc\.(statistics|network)\./.test(entry.id)));
    assert.deepEqual(
      filterCommandsForPalette(tools, profile({ hiddenMenus: ["processing"] }), false),
      [],
    );
  });

  it("keeps the browser-side tools on mobile", () => {
    assert.equal(filterCommandsForPalette(tools, profile(), true).length, tools.length);
  });
});

describe("command-profile-gates", () => {
  it("shows everything while the profile is off", () => {
    const off = { ...profile({ hiddenMenus: ["processing"] }), enabled: false };
    assert.ok(isCommandVisibleInProfile(off, "proc.whitebox.slope"));
  });

  it("maps command ids onto the menu-item catalog", () => {
    assert.equal(commandMenuItem("proc.whitebox"), "processing.whitebox");
    assert.equal(commandMenuItem("proc.whitebox.slope"), "processing.whitebox");
    assert.equal(commandMenuItem("project.save-as"), "project.saveAs");
    assert.equal(commandMenuItem("view.reset-pitch"), "view.resetPitch");
    assert.equal(commandMenuItem("view.reset-pitch-bearing"), "view.resetPitchBearing");
    assert.equal(commandMenuItem("control.compass"), "controls.mapControl.compass");
    assert.equal(commandMenuItem("control.gps-tracking"), "controls.gpsTracking");
    assert.equal(commandMenuItem("proc.georeferencer"), "processing.raster");
    assert.equal(commandMenuItem("settings.simplify-interface"), undefined);
    assert.equal(commandMenuItem("project.examples"), "project.new");
    assert.equal(commandMenuItem("view.color-vision.protanopia"), "view.colorVision");
    assert.equal(commandMenuItem("view.color-vision.off"), "view.colorVision");
  });

  it("hides commands for hidden menus, items, data sources, and plugins", () => {
    const hidden = profile({
      hiddenMenus: ["view"],
      hiddenMenuItems: ["controls.gpsTracking", "help.diagnostics"],
      hiddenDataSources: ["lidar"],
      hiddenPlugins: ["demo"],
    });
    const visible = (id: string) => isCommandVisibleInProfile(hidden, id);
    assert.ok(!visible("view.zoom-in"));
    // Their controls live outside the View menu, so hiding it keeps them.
    assert.ok(visible("view.theme"));
    assert.ok(visible("view.comments"));
    assert.ok(!visible("control.gps-tracking"));
    assert.ok(visible("control.field-collection"));
    assert.ok(!visible("help.diagnostics"));
    assert.ok(visible("help.about"));
    assert.ok(!visible("add.lidar"));
    assert.ok(visible("add.vector"));
    assert.ok(visible("add.comment"), "not a data source");
    assert.ok(!visible("plugin.demo"));
    assert.ok(visible("plugin.other"));
    // Settings can never be hidden, so the way back to the profile UI stays.
    assert.ok(visible("settings.simplify-interface"));
  });

  it("hides the sidecar-backed commands on mobile", () => {
    for (const id of [
      "proc.conversion.raster-to-cog",
      "proc.raster.slope",
      "proc.georeferencer",
      "proc.segmentation",
    ]) {
      assert.ok(!isCommandAvailableOnMobile(id), id);
    }
    for (const id of ["proc.whitebox", "proc.whitebox.slope", "proc.vector.buffer", "proc.sql"]) {
      assert.ok(isCommandAvailableOnMobile(id), id);
    }
  });

  it("narrows the fixed registry without reordering it", () => {
    const commands = [command("proc.raster.slope"), command("view.zoom-in"), command("proc.sql")];
    assert.deepEqual(
      filterCommandsForPalette(commands, profile({ hiddenMenus: ["view"] }), true).map(
        (entry) => entry.id,
      ),
      ["proc.sql"],
    );
  });
});

describe("groupRankedCommands", () => {
  it("keeps each group in one section, ordered by its best match", () => {
    const grouped = groupRankedCommands([
      command("a", "Whitebox"),
      command("b", "Processing"),
      command("c", "Whitebox"),
      command("d", "Tools"),
      command("e", "Processing"),
    ]);
    assert.deepEqual(
      grouped.map((entry) => entry.id),
      ["a", "c", "b", "e", "d"],
    );
  });

  it("is group-first: a group's prefix match stays ahead of a later group's exact match", () => {
    const ranked = filterCommands(
      [
        command("wb.exact", "Whitebox", "Slope"),
        command("proc.exact", "Processing", "Slope"),
        command("wb.prefix", "Whitebox", "Slope Vs Aspect Plot"),
      ],
      "slope",
    );
    // Global rank: both exact matches, then the prefix match.
    assert.deepEqual(
      ranked.map((entry) => entry.id),
      ["wb.exact", "proc.exact", "wb.prefix"],
    );
    // Grouped: the best match is still first, each group renders once.
    assert.deepEqual(
      groupRankedCommands(ranked).map((entry) => entry.id),
      ["wb.exact", "wb.prefix", "proc.exact"],
    );
  });

  it("renders the Whitebox heading once for a query spanning rank tiers", () => {
    const fixed = fixedRegistryIds().map((id) =>
      command(id, "Processing", id === "proc.raster.reclassify" ? "Reclassify" : id),
    );
    const { context } = toolContext(fixedRegistryIds());
    const ranked = filterCommands([...fixed, ...buildPaletteToolCommands(context)], "reclass");
    const headings = paletteRows(groupRankedCommands(ranked))
      .rows.filter((row) => row.kind === "group")
      .map((row) => (row.kind === "group" ? row.label : ""));
    assert.equal(new Set(headings).size, headings.length, headings.join(", "));
  });
});

describe("paletteRows", () => {
  it("adds a heading wherever the group changes and indexes each command's row", () => {
    const { rows, rowOfCommand } = paletteRows([
      command("a", "One"),
      command("b", "One"),
      command("c", "Two"),
      command("d", "One"),
    ]);
    assert.deepEqual(
      rows.map((row) => (row.kind === "group" ? `#${row.label}` : row.command.id)),
      ["#One", "a", "b", "#Two", "c", "#One", "d"],
    );
    assert.deepEqual(rowOfCommand, [1, 2, 4, 6]);
  });
});

describe("palette search speed", () => {
  it("filters the fixed registry plus every tool within a frame", () => {
    const fixed = fixedRegistryIds().map((id) => command(id, "Group", id.replace(/[.-]/g, " ")));
    const { context } = toolContext(fixedRegistryIds());
    const all = [...fixed, ...buildPaletteToolCommands(context)];
    const queries = ["b", "bu", "buf", "buffer", "slope", "fill dep", "raster to", "zzz"];
    filterCommands(all, "warm up");
    const started = performance.now();
    const rounds = 20;
    for (let round = 0; round < rounds; round += 1) {
      for (const query of queries) filterCommands(all, query);
    }
    const perQuery = (performance.now() - started) / (rounds * queries.length);
    // One keystroke filters ~1,200 entries; generous headroom for slow CI.
    assert.ok(perQuery < 16, `filtering took ${perQuery.toFixed(2)} ms per query`);
  });
});
