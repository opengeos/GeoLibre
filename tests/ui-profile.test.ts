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
  isDataSourceVisible,
  isPluginVisible,
  levelAllowsTier,
  pluginTier,
  presetHiddenSets,
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
    assert.equal(result.onboarded, false);
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
