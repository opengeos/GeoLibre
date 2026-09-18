import type {
  AppCapabilities,
  AppPrivilege,
  AppRole,
  GeoLibreLayer,
  LayerCapabilities,
} from "./types";

/**
 * Default inferred capabilities for a layer based on its type and metadata.
 *
 * Inferred rules:
 * - `query`: true for all valid layers.
 * - `create`, `update`, `delete`: true for in-memory or editable GeoJSON vector layers,
 *   false for derived queries (DuckDB/SQL), read-only vector tiles, and raster layers.
 * - `export`: true by default.
 */
export function inferLayerCapabilities(layer: GeoLibreLayer): Required<LayerCapabilities> {
  const isVector = layer.type === "geojson";
  const isDuckDB =
    layer.metadata?.sourceKind === "duckdb-query" ||
    (layer.type === "geojson" && typeof layer.metadata?.query === "string");
  const isExternalNative = layer.metadata?.externalNativeLayer === true;
  const isSketches = layer.metadata?.sourceKind === "geoeditor-sketches";
  const isSqlQuery = layer.metadata?.sourceKind === "sql-query";

  const isReadOnlyVector = isExternalNative && layer.metadata?.sourceKind !== "maplibre-gl-vector";
  const isEditable = isVector && !isDuckDB && !isReadOnlyVector && !isSketches && !isSqlQuery;

  return {
    query: true,
    create: isEditable,
    update: isEditable,
    delete: isEditable,
    export: true,
  };
}

/**
 * Resolves the effective capabilities for a layer by overlaying any explicit
 * capability overrides on top of inferred defaults.
 */
export function resolveLayerCapabilities(
  layer: GeoLibreLayer | undefined,
): Required<LayerCapabilities> {
  if (!layer) {
    return {
      query: false,
      create: false,
      update: false,
      delete: false,
      export: false,
    };
  }

  const defaults = inferLayerCapabilities(layer);
  if (!layer.capabilities) {
    return defaults;
  }

  return {
    query: layer.capabilities.query ?? defaults.query,
    create: layer.capabilities.create ?? defaults.create,
    update: layer.capabilities.update ?? defaults.update,
    delete: layer.capabilities.delete ?? defaults.delete,
    export: layer.capabilities.export ?? defaults.export,
  };
}

/**
 * Normalizes an untrusted capabilities value from JSON/project data.
 */
export function normalizeLayerCapabilities(raw: unknown): LayerCapabilities | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const caps: LayerCapabilities = {};
  let hasAny = false;

  if (typeof obj.query === "boolean") {
    caps.query = obj.query;
    hasAny = true;
  }
  if (typeof obj.create === "boolean") {
    caps.create = obj.create;
    hasAny = true;
  }
  if (typeof obj.update === "boolean") {
    caps.update = obj.update;
    hasAny = true;
  }
  if (typeof obj.delete === "boolean") {
    caps.delete = obj.delete;
    hasAny = true;
  }
  if (typeof obj.export === "boolean") {
    caps.export = obj.export;
    hasAny = true;
  }

  return hasAny ? caps : undefined;
}

/**
 * All supported application privilege identifiers in GeoLibre.
 */
export const ALL_APP_PRIVILEGES: readonly AppPrivilege[] = [
  "layers:edit",
  "layers:add-remote",
  "layers:add-local",
  "processing:run",
  "processing:sidecar",
  "project:save",
  "project:share",
  "project:share-public",
  "plugins:install",
  "assistant:use",
  "connections:manage",
  "export:data",
  "export:image",
  "settings:manage",
] as const;

/**
 * Standard privilege bundles for named application roles.
 */
export const ROLE_PRIVILEGES: Record<Exclude<AppRole, "custom">, readonly AppPrivilege[]> = {
  viewer: ["export:image", "export:data"],
  editor: [
    "export:image",
    "export:data",
    "layers:edit",
    "layers:add-local",
    "layers:add-remote",
    "processing:run",
    "project:save",
  ],
  publisher: [
    "export:image",
    "export:data",
    "layers:edit",
    "layers:add-local",
    "layers:add-remote",
    "processing:run",
    "project:save",
    "project:share",
    "project:share-public",
    "processing:sidecar",
    "assistant:use",
  ],
  administrator: ALL_APP_PRIVILEGES,
};

/**
 * Resolves the effective privilege list for a given role, applying custom overrides if specified.
 */
export function resolveRolePrivileges(
  role: AppRole,
  customPrivileges?: readonly AppPrivilege[],
): AppPrivilege[] {
  if (role === "custom") {
    if (!customPrivileges || customPrivileges.length === 0) return [];
    const validSet = new Set<AppPrivilege>(ALL_APP_PRIVILEGES);
    return [...new Set(customPrivileges.filter((p) => validSet.has(p)))];
  }
  return [...ROLE_PRIVILEGES[role]];
}

/**
 * Intersects multiple sets of privileges to derive the effective permissions when multiple
 * policies (e.g. deployment, organization, and share link) apply simultaneously.
 */
export function intersectPrivileges(...privilegeSets: (readonly AppPrivilege[])[]): AppPrivilege[] {
  if (privilegeSets.length === 0) return [];
  if (privilegeSets.length === 1) return [...new Set(privilegeSets[0])];
  let current = new Set<AppPrivilege>(privilegeSets[0]);
  for (let i = 1; i < privilegeSets.length; i++) {
    const nextSet = new Set<AppPrivilege>(privilegeSets[i]);
    current = new Set([...current].filter((p) => nextSet.has(p)));
  }
  return [...current];
}

/**
 * Evaluates whether an application capability set grants a specific privilege.
 */
export function hasAppPrivilege(
  capabilities: AppCapabilities | undefined,
  privilege: AppPrivilege,
): boolean {
  if (!capabilities) return true;
  return capabilities.privileges.includes(privilege);
}

/**
 * Resolves why a privilege is withheld: its own reason if it has one, otherwise
 * the reason recorded for the capability set as a whole.
 *
 * @param capabilities - The active capability set, if any.
 * @param privilege - The privilege being explained.
 * @returns The reason, or undefined when none was recorded.
 */
export function appPrivilegeReason(
  capabilities: AppCapabilities | undefined,
  privilege: AppPrivilege,
): string | undefined {
  if (!capabilities) return undefined;
  return capabilities.privilegeReasons?.[privilege] ?? capabilities.reason;
}

/**
 * Creates the default unconstrained application capabilities (Administrator role).
 */
export function createDefaultAppCapabilities(): AppCapabilities {
  return {
    role: "administrator",
    privileges: [...ALL_APP_PRIVILEGES],
  };
}

/**
 * Normalizes an untrusted array of privilege strings.
 */
export function normalizeAppPrivileges(raw: unknown): AppPrivilege[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const validSet = new Set<string>(ALL_APP_PRIVILEGES);
  const result: AppPrivilege[] = [];
  for (const item of raw) {
    if (typeof item === "string" && validSet.has(item)) {
      result.push(item as AppPrivilege);
    }
  }
  return result.length > 0 ? [...new Set(result)] : [];
}
