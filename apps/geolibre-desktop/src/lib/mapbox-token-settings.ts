import type { RuntimeEnvironmentVariable } from "@geolibre/core";

const tokenKeys = new Set(["VITE_MAPBOX_ACCESS_TOKEN", "MAPBOX_TOKEN"]);

/** Move the old shortcut's enabled rows into the device-local settings draft. */
export function migrateMapboxTokenSettings(
  variables: RuntimeEnvironmentVariable[],
  deviceToken = "",
) {
  const enabled = Object.fromEntries(
    variables
      .filter((variable) => variable.enabled)
      .map((variable) => [variable.key.trim(), variable.value]),
  );
  return {
    token:
      enabled.VITE_MAPBOX_ACCESS_TOKEN?.trim() ||
      deviceToken.trim() ||
      enabled.MAPBOX_TOKEN?.trim() ||
      "",
    variables: variables.filter(
      (variable) => !variable.enabled || !tokenKeys.has(variable.key.trim()),
    ),
  };
}
