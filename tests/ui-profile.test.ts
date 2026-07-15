import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_UI_PROFILE_SETTINGS,
  useDesktopSettingsStore,
  type DesktopSettings,
  type UiProfileSettings,
} from "../apps/geolibre-desktop/src/hooks/useDesktopSettings";
import {
  DATA_SOURCE_CATALOG,
  MENU_ITEM_CATALOG,
  TOP_LEVEL_MENUS,
  activeInterfaceProfile,
  isDataSourceVisible,
  isMenuItemVisible,
  isMenuVisible,
  isPluginVisible,
  levelAllowsTier,
  pluginTier,
  presetHiddenSets,
  showsAdvancedNotices,
} from "../apps/geolibre-desktop/src/lib/ui-profile";

function profile(patch: Partial<UiProfileSettings>): UiProfileSettings {
  return { ...DEFAULT_UI_PROFILE_SETTINGS, ...patch };
}

describe("ui-profile tiers", () => {
  it("reveals lower tiers as the level rises", () => {
    assert.equal(levelAllowsTier("beginner", "basic"), true);
    assert.equal(levelAllowsTier("beginner", "intermediate"), false);
    assert.equal(levelAllowsTier("beginner", "advanced"), false);
    assert.equal(levelAllowsTier("intermediate", "intermediate"), true);
    assert.equal(levelAllowsTier("intermediate", "advanced"), false);
    assert.equal(levelAllowsTier("advanced", "advanced"), true);
  });

  it("defaults unlisted plugins to intermediate", () => {
    assert.equal(pluginTier("some-unknown-plugin"), "intermediate");
    assert.equal(pluginTier("maplibre-layer-control"), "basic");
    assert.equal(pluginTier("maplibre-gl-geoagent"), "advanced");
  });
});

describe("showsAdvancedNotices", () => {
  it("shows when the profile is disabled", () => {
    assert.equal(
      showsAdvancedNotices(profile({ enabled: false, level: "beginner" })),
      true,
    );
  });

  it("hides for the Beginner and Intermediate presets", () => {
    assert.equal(
      showsAdvancedNotices(profile({ enabled: true, level: "beginner" })),
      false,
    );
    assert.equal(
      showsAdvancedNotices(profile({ enabled: true, level: "intermediate" })),
      false,
    );
  });

  it("shows for the Advanced preset and for a custom profile", () => {
    assert.equal(
      showsAdvancedNotices(profile({ enabled: true, level: "advanced" })),
      true,
    );
    assert.equal(
      showsAdvancedNotices(profile({ enabled: true, level: null })),
      true,
    );
  });
});

describe("presetHiddenSets", () => {
  const pluginIds = [
    "maplibre-layer-control", // basic
    "maplibre-gl-swipe", // intermediate (default)
    "maplibre-gl-geoagent", // advanced
  ];

  it("advanced hides nothing", () => {
    const sets = presetHiddenSets("advanced", pluginIds);
    assert.deepEqual(sets.hiddenDataSources, []);
    assert.deepEqual(sets.hiddenPlugins, []);
  });

  it("keeps Natural Earth for beginners but not the browser it is built on", () => {
    // Natural Earth is a fixed set of curated layers, so it stays at every
    // level; the general Source Cooperative browser expects a product id and
    // does not.
    const sets = presetHiddenSets("beginner", [
      "maplibre-gl-natural-earth",
      "maplibre-gl-source-coop",
    ]);
    assert.deepEqual(sets.hiddenPlugins, ["maplibre-gl-source-coop"]);
  });

  it("beginner hides every non-basic item", () => {
    const sets = presetHiddenSets("beginner", pluginIds);
    const basicIds = DATA_SOURCE_CATALOG.filter(
      (entry) => entry.tier === "basic",
    ).map((entry) => entry.id);
    for (const id of sets.hiddenDataSources) {
      assert.ok(!basicIds.includes(id), `${id} should stay visible`);
    }
    // A known advanced source is hidden; a known basic source is not.
    assert.ok(sets.hiddenDataSources.includes("postgres"));
    assert.ok(!sets.hiddenDataSources.includes("vector"));
    assert.deepEqual(sets.hiddenPlugins, [
      "maplibre-gl-swipe",
      "maplibre-gl-geoagent",
    ]);
  });

  it("intermediate keeps basic + intermediate, hides advanced", () => {
    const sets = presetHiddenSets("intermediate", pluginIds);
    assert.deepEqual(sets.hiddenPlugins, ["maplibre-gl-geoagent"]);
    assert.ok(sets.hiddenDataSources.includes("zarr")); // advanced
    assert.ok(!sets.hiddenDataSources.includes("wfs")); // intermediate
  });
});

describe("menu presets and predicates", () => {
  it("advanced hides no menus or items", () => {
    const sets = presetHiddenSets("advanced", []);
    assert.deepEqual(sets.hiddenMenus, []);
    assert.deepEqual(sets.hiddenMenuItems, []);
  });

  it("beginner hides the Processing menu and advanced items", () => {
    const sets = presetHiddenSets("beginner", []);
    // The Processing menu is intermediate-tier, so beginners don't see it.
    assert.deepEqual(sets.hiddenMenus, ["processing"]);
    assert.ok(!sets.hiddenMenus.includes("project"));
    // Advanced items are hidden; basic ones are not.
    assert.ok(sets.hiddenMenuItems.includes("processing.raster"));
    assert.ok(sets.hiddenMenuItems.includes("help.diagnostics"));
    assert.ok(!sets.hiddenMenuItems.includes("project.save"));
    assert.ok(!sets.hiddenMenuItems.includes("edit.undo"));
    // Default-on controls stay reachable for beginners.
    assert.ok(!sets.hiddenMenuItems.includes("controls.mapControl.globe"));
    assert.ok(!sets.hiddenMenuItems.includes("controls.mapControl.scale"));
    assert.ok(!sets.hiddenMenuItems.includes("controls.mapControl.attribution"));
    // Items intentionally kept out of the beginner set.
    assert.ok(sets.hiddenMenuItems.includes("processing.assistant"));
    assert.ok(sets.hiddenMenuItems.includes("controls.legend"));
    assert.ok(sets.hiddenMenuItems.includes("settings.environment"));
    assert.ok(sets.hiddenDataSources.includes("duckdb"));
  });

  it("never hides the Settings menu (excluded from TOP_LEVEL_MENUS)", () => {
    assert.ok(!TOP_LEVEL_MENUS.some((menu) => menu.id === "settings"));
  });

  it("never hides the Settings Interface entry", () => {
    assert.ok(
      !MENU_ITEM_CATALOG.some((entry) => entry.id === "settings.interface"),
    );
  });

  it("respects enabled for menu and item predicates", () => {
    const disabled = profile({ enabled: false, hiddenMenus: ["help"] });
    assert.equal(isMenuVisible(disabled, "help"), true);
    const enabled = profile({
      enabled: true,
      hiddenMenus: ["help"],
      hiddenMenuItems: ["processing.raster"],
    });
    assert.equal(isMenuVisible(enabled, "help"), false);
    assert.equal(isMenuVisible(enabled, "project"), true);
    assert.equal(isMenuItemVisible(enabled, "processing.raster"), false);
    assert.equal(isMenuItemVisible(enabled, "processing.vector"), true);
  });
});

describe("visibility predicates", () => {
  it("shows everything when the profile is disabled", () => {
    const disabled = profile({ enabled: false, hiddenDataSources: ["postgres"] });
    assert.equal(isDataSourceVisible(disabled, "postgres"), true);
  });

  it("hides listed ids only when enabled", () => {
    const enabled = profile({
      enabled: true,
      hiddenDataSources: ["postgres"],
      hiddenPlugins: ["maplibre-gl-geoagent"],
    });
    assert.equal(isDataSourceVisible(enabled, "postgres"), false);
    assert.equal(isDataSourceVisible(enabled, "vector"), true);
    assert.equal(isPluginVisible(enabled, "maplibre-gl-geoagent"), false);
    assert.equal(isPluginVisible(enabled, "maplibre-layer-control"), true);
  });
});

describe("activeInterfaceProfile", () => {
  it("reads the legacy/default disabled profile as Advanced", () => {
    // Everything is visible when disabled, which matches the Advanced preset.
    assert.equal(activeInterfaceProfile(profile({ enabled: false })), "advanced");
    assert.equal(
      activeInterfaceProfile(profile({ enabled: false, level: "beginner" })),
      "advanced",
    );
  });

  it("reports the active preset level when enabled", () => {
    assert.equal(
      activeInterfaceProfile(profile({ enabled: true, level: "beginner" })),
      "beginner",
    );
    assert.equal(
      activeInterfaceProfile(profile({ enabled: true, level: "intermediate" })),
      "intermediate",
    );
    assert.equal(
      activeInterfaceProfile(profile({ enabled: true, level: "advanced" })),
      "advanced",
    );
  });

  it("reports Custom when enabled with a hand-edited (null-level) profile", () => {
    assert.equal(
      activeInterfaceProfile(
        profile({ enabled: true, level: null, hiddenMenus: ["help"] }),
      ),
      "custom",
    );
    // Even with all hidden lists empty, level=null means the user has hand-edited
    // their way back to "show everything": still Custom, not Advanced.
    assert.equal(
      activeInterfaceProfile(profile({ enabled: true, level: null })),
      "custom",
    );
  });
});

describe("normalizeUiProfileSettings (via the store)", () => {
  function normalized(uiProfile: unknown): UiProfileSettings {
    useDesktopSettingsStore.getState().setDesktopSettings({
      uiProfile,
    } as unknown as DesktopSettings);
    return useDesktopSettingsStore.getState().desktopSettings.uiProfile;
  }

  it("defaults to everything visible for legacy settings", () => {
    assert.deepEqual(normalized(undefined), DEFAULT_UI_PROFILE_SETTINGS);
  });

  it("rejects tampered non-boolean and unknown-level values", () => {
    const result = normalized({
      enabled: "yes",
      level: "expert",
      onboarded: 1,
      locked: "true",
      hiddenDataSources: ["postgres", 42, "postgres", ""],
      hiddenPlugins: "nope",
    });
    assert.equal(result.enabled, false);
    assert.equal(result.level, null);
    // Non-boolean falls back to the default (welcome dialog off by default).
    assert.equal(result.onboarded, true);
    assert.equal(result.locked, false);
    // Non-strings dropped, duplicates/blank removed.
    assert.deepEqual(result.hiddenDataSources, ["postgres"]);
    assert.deepEqual(result.hiddenPlugins, []);
  });

  it("preserves valid values", () => {
    const result = normalized({
      enabled: true,
      level: "beginner",
      onboarded: true,
      locked: true,
      hiddenDataSources: ["postgres"],
      hiddenPlugins: ["maplibre-gl-geoagent"],
    });
    assert.equal(result.enabled, true);
    assert.equal(result.level, "beginner");
    assert.equal(result.locked, true);
    assert.deepEqual(result.hiddenPlugins, ["maplibre-gl-geoagent"]);
  });
});
