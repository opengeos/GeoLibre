import { getRuntimeEnvironment } from "@geolibre/core";

export function getSpatialExtensionPath(
  env?: Record<string, string | undefined>,
): string | undefined {
  const runtimeEnv = env ?? getRuntimeEnvironment();
  const value = runtimeEnv.VITE_DUCKDB_SPATIAL_EXTENSION_PATH;
  return value && value.trim() ? value.trim() : undefined;
}
