import type { GeoLibreProject } from "./types";

/**
 * Project fields whose values are credentials. Keep this registry as the
 * schema-level decision point when a new credential-bearing field is added.
 */
export const PROJECT_CREDENTIAL_FIELDS = {
  preferences: ["environmentVariables", "geocoding.apiKeys"],
  layerConfiguration: [
    "requestHeaders",
    "headers",
    "authorization",
    "apiKey",
    "apiKeys",
    "accessToken",
    "token",
    "password",
    "clientSecret",
    "connectionString",
  ],
  pluginState: ["plugins.settings"],
} as const;

export interface CredentialRedactionResult {
  project: GeoLibreProject;
  /** Stable project paths removed or rewritten by the redaction pass. */
  redactedPaths: string[];
}

const SENSITIVE_KEYS = new Set(
  PROJECT_CREDENTIAL_FIELDS.layerConfiguration.map((key) => key.toLowerCase()),
);
const URL_CREDENTIAL_PARAMS = new Set([
  "access_token",
  "accesstoken",
  "api_key",
  "apikey",
  "key",
  "token",
  "subscription-key",
  "subscriptionkey",
  "password",
  "pwd",
  "client_secret",
  "clientsecret",
  "signature",
  "sig",
  "se",
  "sp",
  "sv",
  "sr",
  "st",
  "skoid",
]);
const MAX_REDACT_DEPTH = 12;

function isCredentialParam(name: string): boolean {
  const normalized = name.toLowerCase();
  return URL_CREDENTIAL_PARAMS.has(normalized) || normalized.startsWith("x-amz-");
}

function redactParameterString(value: string): string {
  return value
    .split("&")
    .filter((pair) => pair !== "" && !isCredentialParam(pair.split("=", 1)[0]))
    .join("&");
}

/**
 * Remove credentials from URL-shaped values without encoding tile-template
 * placeholders such as `{z}/{x}/{y}`.
 */
export function redactUrlCredentials(value: string): string {
  const hashIndex = value.indexOf("#");
  const beforeHash = hashIndex === -1 ? value : value.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? undefined : value.slice(hashIndex + 1);
  const queryIndex = beforeHash.indexOf("?");
  let base = queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex);
  const query = queryIndex === -1 ? undefined : beforeHash.slice(queryIndex + 1);

  const schemeIndex = base.indexOf("://");
  if (schemeIndex !== -1) {
    const authorityStart = schemeIndex + 3;
    const authorityEnd = base.indexOf("/", authorityStart);
    const authority = base.slice(
      authorityStart,
      authorityEnd === -1 ? undefined : authorityEnd,
    );
    const at = authority.lastIndexOf("@");
    if (at !== -1) {
      base =
        base.slice(0, authorityStart) +
        authority.slice(at + 1) +
        (authorityEnd === -1 ? "" : base.slice(authorityEnd));
    }
  }

  const keptQuery = query === undefined ? undefined : redactParameterString(query);
  const keptFragment =
    fragment === undefined || !fragment.includes("=")
      ? fragment
      : redactParameterString(fragment);
  return (
    base +
    (keptQuery ? `?${keptQuery}` : "") +
    (keptFragment ? `#${keptFragment}` : "")
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isGeoJsonPayload(value: Record<string, unknown>): boolean {
  return (
    value.type === "FeatureCollection" ||
    value.type === "Feature" ||
    value.type === "GeometryCollection"
  );
}

function redactConfigurationValue(
  value: unknown,
  path: string,
  redactedPaths: string[],
  depth = 0,
): unknown {
  if (typeof value === "string") {
    const redacted = redactUrlCredentials(value);
    if (redacted !== value) redactedPaths.push(path);
    return redacted;
  }
  if (depth >= MAX_REDACT_DEPTH) return value;
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      redactConfigurationValue(item, `${path}[${index}]`, redactedPaths, depth + 1),
    );
  }
  if (!isPlainObject(value) || isGeoJsonPayload(value)) return value;

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    const nestedPath = path ? `${path}.${key}` : key;
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      redactedPaths.push(nestedPath);
      continue;
    }
    result[key] = redactConfigurationValue(nested, nestedPath, redactedPaths, depth + 1);
  }
  return result;
}

/**
 * Return a detached project safe for any external egress.
 *
 * Environment variables and geocoder keys are always removed. Layer
 * configuration is recursively scrubbed for credential fields and credential
 * URL parameters. Plugin settings are omitted wholesale because external
 * plugins can persist arbitrary shapes; retaining unknown state cannot provide
 * a no-secret guarantee. Manifest URLs, activation, and control positions stay
 * intact so recipients can still load and configure the plugin themselves.
 */
export function redactProjectCredentials(
  project: GeoLibreProject,
): CredentialRedactionResult {
  const redactedPaths: string[] = [];
  const preferences = project.preferences
    ? {
        ...project.preferences,
        environmentVariables: [],
        geocoding: project.preferences.geocoding
          ? { ...project.preferences.geocoding, apiKeys: {} }
          : project.preferences.geocoding,
      }
    : project.preferences;
  if (project.preferences?.environmentVariables?.length > 0) {
    redactedPaths.push("preferences.environmentVariables");
  }
  if (Object.keys(project.preferences?.geocoding?.apiKeys ?? {}).length > 0) {
    redactedPaths.push("preferences.geocoding.apiKeys");
  }

  const layers = (project.layers ?? []).map((layer, index) => ({
    ...layer,
    source: redactConfigurationValue(
      layer.source,
      `layers[${index}].source`,
      redactedPaths,
    ) as Record<string, unknown>,
    metadata: redactConfigurationValue(
      layer.metadata,
      `layers[${index}].metadata`,
      redactedPaths,
    ) as Record<string, unknown>,
    ...(typeof layer.sourcePath === "string"
      ? {
          sourcePath: redactConfigurationValue(
            layer.sourcePath,
            `layers[${index}].sourcePath`,
            redactedPaths,
          ) as string,
        }
      : {}),
  }));

  let plugins = project.plugins;
  if (plugins && Object.keys(plugins.settings ?? {}).length > 0) {
    redactedPaths.push("plugins.settings");
    plugins = { ...plugins, settings: {} };
  }

  return {
    project: {
      ...project,
      ...(preferences ? { preferences } : {}),
      layers,
      ...(plugins ? { plugins } : {}),
      ...(project.metadata
        ? {
            metadata: redactConfigurationValue(
              project.metadata,
              "metadata",
              redactedPaths,
            ) as Record<string, unknown>,
          }
        : {}),
    },
    redactedPaths: [...new Set(redactedPaths)],
  };
}

/** Convenience wrapper for callers that only need the safe project. */
export function redactCredentials(project: GeoLibreProject): GeoLibreProject {
  return redactProjectCredentials(project).project;
}
