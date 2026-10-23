import assert from "node:assert/strict";
import { it } from "node:test";
import { migrateMapboxTokenSettings } from "../apps/geolibre-desktop/src/lib/mapbox-token-settings";
import { normalizeDesktopSettings } from "../apps/geolibre-desktop/src/hooks/useDesktopSettings";
import { mergeRuntimeEnv } from "../apps/geolibre-desktop/src/lib/assistant/provider";
import { getMapboxAccessToken } from "@geolibre/core";

it("migrates active legacy tokens without mutating the project before Save", () => {
  const variables = [
    { key: "VITE_MAPBOX_ACCESS_TOKEN", value: " project-token ", enabled: true },
    { key: "MAPBOX_TOKEN", value: "fallback", enabled: true },
    { key: "MAPBOX_TOKEN", value: "disabled", enabled: false },
    { key: "OTHER", value: "keep", enabled: true },
  ];
  const result = migrateMapboxTokenSettings(variables, "device-token");
  assert.equal(result.token, "project-token");
  assert.deepEqual(result.variables, variables.slice(2));
  assert.equal(variables.length, 4);
});

it("preserves device-token precedence over the bare alias and accepts old bare tokens", () => {
  const variables = [{ key: "MAPBOX_TOKEN", value: " old-token ", enabled: true }];
  assert.equal(migrateMapboxTokenSettings(variables, "device-token").token, "device-token");
  assert.equal(migrateMapboxTokenSettings(variables).token, "old-token");
  assert.equal(migrateMapboxTokenSettings([]).token, "");
});

it("normalizes device settings and resolves runtime Mapbox overrides", () => {
  assert.equal(
    normalizeDesktopSettings({ mapboxAccessToken: " token " }).mapboxAccessToken,
    "token",
  );
  assert.equal(normalizeDesktopSettings({}).mapboxAccessToken, "");
  const sources = {
    osEnv: { VITE_MAPBOX_ACCESS_TOKEN: "build-token" },
    aiEnv: {},
    geocoderEnv: {},
    cesiumEnv: {},
    mapboxEnv: { VITE_MAPBOX_ACCESS_TOKEN: "device-token" },
    projectEnv: {},
  };
  assert.equal(getMapboxAccessToken(mergeRuntimeEnv(sources)), "device-token");
  assert.equal(
    getMapboxAccessToken(
      mergeRuntimeEnv({
        ...sources,
        projectEnv: { VITE_MAPBOX_ACCESS_TOKEN: "explicit-token" },
      }),
    ),
    "explicit-token",
  );
});
