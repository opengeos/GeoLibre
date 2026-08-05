import type { GeoLibreProject, LayerConnection } from "./types";

/**
 * Project fields whose values are credentials. Keep this registry as the
 * schema-level inventory. Keep the explicit preference/plugin handling in
 * redactProjectCredentials in sync when adding entries outside layer config.
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
    "secret",
    "bearer",
    "auth",
    "authKey",
    "sasToken",
    "subscriptionKey",
    "signature",
    "pwd",
  ],
  pluginState: ["plugins.settings"],
} as const;

export interface CredentialRedactionResult {
  project: GeoLibreProject;
  /** Stable project paths removed or rewritten by the redaction pass. */
  redactedPaths: string[];
  /** Number of individual credential-bearing fields removed or rewritten. */
  redactedCount: number;
}

/**
 * Fold the spellings of one credential name together, so `apiKey`, `api_key`,
 * `api-key`, and `APIKEY` are a single registry entry on both the object-key
 * and the URL-parameter side.
 */
function normalizeCredentialName(name: string): string {
  return name.toLowerCase().replace(/[-_]/g, "");
}

const SENSITIVE_KEYS = new Set(
  PROJECT_CREDENTIAL_FIELDS.layerConfiguration.map(normalizeCredentialName),
);
/**
 * Credential names in query strings. This is the wider of the two registries by
 * design: everything here is also an object-key credential *except* `key` and
 * the Azure SAS positional parameters (`sv`/`sr`/`st`/`se`/`sp`/`sig`/`skoid`),
 * which are only credentials because of where they appear. As configuration
 * field names they collide with ordinary state — `sr` is a spatial reference on
 * an ArcGIS source, `key` is a generic identifier — so matching them on object
 * keys would silently drop layer configuration rather than a secret.
 */
const URL_CREDENTIAL_PARAMS = new Set(
  [
    ...PROJECT_CREDENTIAL_FIELDS.layerConfiguration,
    "key",
    "sig",
    "se",
    "sp",
    "sv",
    "sr",
    "st",
    "skoid",
  ].map(normalizeCredentialName),
);
const MAX_REDACT_DEPTH = 12;

/** Whether an object key in layer/plugin configuration holds a credential. */
export function isCredentialFieldName(name: string): boolean {
  return SENSITIVE_KEYS.has(normalizeCredentialName(name));
}

function isCredentialParam(name: string): boolean {
  let decoded = name.replace(/\+/g, " ");
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Malformed names cannot match the registry, but must not break export.
  }
  const lowered = decoded.toLowerCase();
  return (
    URL_CREDENTIAL_PARAMS.has(normalizeCredentialName(lowered)) || lowered.startsWith("x-amz-")
  );
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
    const authority = base.slice(authorityStart, authorityEnd === -1 ? undefined : authorityEnd);
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
    fragment === undefined || !fragment.includes("=") ? fragment : redactParameterString(fragment);
  return base + (keptQuery ? `?${keptQuery}` : "") + (keptFragment ? `#${keptFragment}` : "");
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
  redactedCount: { value: number },
  depth = 0,
): unknown {
  if (depth >= MAX_REDACT_DEPTH) {
    // Fail closed. A deeply nested configuration shape is not needed to render
    // any built-in layer, and returning it unchanged would let a credential
    // bypass the invariant merely by exceeding the traversal cap.
    redactedPaths.push(path);
    redactedCount.value += 1;
    return undefined;
  }
  if (typeof value === "string") {
    const redacted = redactUrlCredentials(value);
    if (redacted !== value) {
      redactedPaths.push(path);
      redactedCount.value += 1;
    }
    return redacted;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      redactConfigurationValue(item, `${path}[${index}]`, redactedPaths, redactedCount, depth + 1),
    );
  }
  if (!isPlainObject(value)) return value;
  if (isGeoJsonPayload(value)) return structuredClone(value);

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    const nestedPath = path ? `${path}.${key}` : key;
    if (isCredentialFieldName(key)) {
      redactedPaths.push(nestedPath);
      redactedCount.value += 1;
      continue;
    }
    result[key] = redactConfigurationValue(
      nested,
      nestedPath,
      redactedPaths,
      redactedCount,
      depth + 1,
    );
  }
  return result;
}

function countLeafValues(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((count, item) => count + countLeafValues(item), 0);
  if (isPlainObject(value)) {
    return Object.values(value).reduce(
      (count: number, nested) => count + countLeafValues(nested),
      0,
    );
  }
  return 1;
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
export function redactProjectCredentials(project: GeoLibreProject): CredentialRedactionResult {
  const redactedPaths: string[] = [];
  const redactedCount = { value: 0 };
  const basemapStyleUrl =
    typeof project.basemapStyleUrl === "string"
      ? redactUrlCredentials(project.basemapStyleUrl)
      : project.basemapStyleUrl;
  if (basemapStyleUrl !== project.basemapStyleUrl) {
    redactedPaths.push("basemapStyleUrl");
    redactedCount.value += 1;
  }
  const geocoding = project.preferences?.geocoding
    ? { ...project.preferences.geocoding, apiKeys: {} }
    : project.preferences?.geocoding;
  if (geocoding) {
    for (const field of ["forwardEndpoint", "reverseEndpoint"] as const) {
      const endpoint = geocoding[field];
      if (typeof endpoint !== "string") continue;
      const redacted = redactUrlCredentials(endpoint);
      if (redacted !== endpoint) {
        geocoding[field] = redacted;
        redactedPaths.push(`preferences.geocoding.${field}`);
        redactedCount.value += 1;
      }
    }
  }
  const preferences = project.preferences
    ? { ...project.preferences, environmentVariables: [], geocoding }
    : project.preferences;
  const populatedEnvironmentVariables =
    project.preferences?.environmentVariables?.filter((variable) => variable.key.trim()).length ??
    0;
  if (populatedEnvironmentVariables > 0) {
    redactedPaths.push("preferences.environmentVariables");
    redactedCount.value += populatedEnvironmentVariables;
  }
  if (Object.keys(project.preferences?.geocoding?.apiKeys ?? {}).length > 0) {
    redactedPaths.push("preferences.geocoding.apiKeys");
    redactedCount.value += Object.keys(project.preferences?.geocoding?.apiKeys ?? {}).length;
  }

  const layers = (project.layers ?? []).map((layer, index) => ({
    ...layer,
    source: redactConfigurationValue(
      layer.source,
      `layers[${index}].source`,
      redactedPaths,
      redactedCount,
    ) as Record<string, unknown>,
    metadata: redactConfigurationValue(
      layer.metadata,
      `layers[${index}].metadata`,
      redactedPaths,
      redactedCount,
    ) as Record<string, unknown>,
    ...(typeof layer.sourcePath === "string"
      ? {
          sourcePath: redactConfigurationValue(
            layer.sourcePath,
            `layers[${index}].sourcePath`,
            redactedPaths,
            redactedCount,
          ) as string,
        }
      : {}),
    // `connection.lastError` is free-form text taken from a caught error, and a
    // refresh path that words it as `Failed to fetch ${url}` would carry the
    // request's credential parameters. Sweeping it costs nothing and keeps the
    // no-secret guarantee from depending on how an error message is phrased.
    ...(layer.connection
      ? {
          connection: redactConfigurationValue(
            layer.connection,
            `layers[${index}].connection`,
            redactedPaths,
            redactedCount,
          ) as LayerConnection,
        }
      : {}),
  }));

  let plugins = project.plugins;
  if (plugins) {
    const manifestUrls = plugins.manifestUrls.map((url, index) => {
      const redacted = redactUrlCredentials(url);
      if (redacted !== url) {
        redactedPaths.push(`plugins.manifestUrls[${index}]`);
        redactedCount.value += 1;
      }
      return redacted;
    });
    if (Object.keys(plugins.settings ?? {}).length > 0) {
      redactedPaths.push("plugins.settings");
      redactedCount.value += countLeafValues(plugins.settings);
    }
    plugins = { ...plugins, manifestUrls, settings: {} };
  }

  return {
    project: {
      // Remaining project-level fields are structural/user content with no
      // current credential-bearing schema. Add explicit handling above when a
      // future field (for example a processing parameter) accepts credentials.
      ...project,
      basemapStyleUrl,
      ...(preferences ? { preferences } : {}),
      layers,
      ...(plugins ? { plugins } : {}),
      ...(project.metadata
        ? {
            metadata: redactConfigurationValue(
              project.metadata,
              "metadata",
              redactedPaths,
              redactedCount,
            ) as Record<string, unknown>,
          }
        : {}),
    },
    redactedPaths: [...new Set(redactedPaths)],
    redactedCount: redactedCount.value,
  };
}

/** Convenience wrapper for callers that only need the safe project. */
export function redactCredentials(project: GeoLibreProject): GeoLibreProject {
  return redactProjectCredentials(project).project;
}
