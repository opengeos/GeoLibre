import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeoLibreToolbarMenu, ToolbarMenuEntry } from "../packages/plugins/src";
import {
  toolbarMenusByOwner,
  withPluginMenuFolded,
} from "../apps/geolibre-desktop/src/lib/plugin-toolbar-menus";
import { normalizeDesktopSettings } from "../apps/geolibre-desktop/src/hooks/useDesktopSettings";

function menu(id: string, itemCount = 1): GeoLibreToolbarMenu {
  return {
    id,
    label: id,
    items: Array.from({ length: itemCount }, (_, index) => ({
      id: `item-${index}`,
      label: `Item ${index}`,
      onSelect: () => undefined,
    })),
  };
}

describe("toolbarMenusByOwner", () => {
  it("groups menus by owner and skips unowned and empty menus", () => {
    const entries: ToolbarMenuEntry[] = [
      { menu: menu("a1"), ownerPluginId: "plugin-a" },
      { menu: menu("b1"), ownerPluginId: "plugin-b" },
      { menu: menu("a2"), ownerPluginId: "plugin-a" },
      { menu: menu("empty", 0), ownerPluginId: "plugin-c" },
      { menu: menu("host") },
    ];
    const byOwner = toolbarMenusByOwner(entries);
    assert.deepEqual(
      [...byOwner].map(([owner, menus]) => [owner, menus.map((m) => m.id)]),
      [
        ["plugin-a", ["a1", "a2"]],
        ["plugin-b", ["b1"]],
      ],
    );
  });
});

describe("withPluginMenuFolded", () => {
  it("adds and removes a plugin id without duplicates or mutation", () => {
    const start = ["plugin-a"];
    assert.deepEqual(withPluginMenuFolded(start, "plugin-b", true), ["plugin-a", "plugin-b"]);
    assert.deepEqual(withPluginMenuFolded(start, "plugin-a", true), ["plugin-a"]);
    assert.deepEqual(withPluginMenuFolded(start, "plugin-a", false), []);
    assert.deepEqual(withPluginMenuFolded(start, "plugin-z", false), ["plugin-a"]);
    assert.deepEqual(start, ["plugin-a"]);
  });
});

describe("foldedPluginMenus desktop setting", () => {
  it("defaults to empty and normalizes stored values", () => {
    assert.deepEqual(normalizeDesktopSettings({}).foldedPluginMenus, []);
    assert.deepEqual(
      normalizeDesktopSettings({ foldedPluginMenus: [" plugin-a ", "plugin-a", 3, ""] })
        .foldedPluginMenus,
      ["plugin-a"],
    );
  });
});
