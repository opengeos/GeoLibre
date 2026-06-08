export function getSpatialExtensionPath(
  env?: Record<string, string | undefined>,
): string | undefined {
  const value = env?.VITE_DUCKDB_SPATIAL_EXTENSION_PATH;
  return value && value.trim() ? value.trim() : undefined;
}
