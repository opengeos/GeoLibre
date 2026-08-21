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

/**
 * Plugin settings that survive redaction: plugin id to the sub-keys kept from
 * its blob, or `null` to keep the whole blob.
 *
 * A plugin's settings are free-form and an external plugin can persist a
 * credential there, so the default is to drop all of it. What is listed here is
 * map-control *composition* — the swipe split, legend entries and colors, the
 * colorbar's range and ramp — which is what a shared or exported project needs
 * in order to render the map it was built as, and is structured rather than
 * free text. Dropping it silently stripped every legend, colorbar, and swipe
 * from an export.
 *
 * The components plugin's `html` sub-key is deliberately absent: it holds a
 * custom HTML panel the user authored by hand (`ComponentHtmlGuiEntryState`),
 * so it can carry anything, including a URL with a token in it. It is dropped
 * like any unknown blob. Mirrored by `PUBLISHABLE_PLUGIN_SETTINGS` in
 * `python/src/geolibre/project.py`; the two must agree.
 */
export const PUBLISHABLE_PLUGIN_SETTINGS: Readonly<Record<string, readonly string[] | null>> = {
  "maplibre-gl-swipe": null,
  "maplibre-gl-components": ["legend", "colorbar"],
};

export interface CredentialRedactionResult {
  project: GeoLibreProject;
  /** Stable project paths removed or rewritten by the redaction pass. */
  redactedPaths: string[];
  /**
   * Opaque `path=hash` fingerprints identifying *which* secret sat at each
   * redacted path. A caller that remembers an explicit "keep credentials"
   * decision compares these between saves, so a different credential, such as
   * a swapped layer or rotated token, is confirmed again instead of being
   * written to disk under the earlier answer. Paths alone cannot carry that:
   * they are positional, so a replacement layer inherits the path of the one it
   * replaced.
   */
  redactedFingerprints: string[];
  /**
   * Whether any redacted value could not be serialized, and so has no entry in
   * {@link redactedFingerprints}. Such a value cannot be compared with what the
   * user accepted, so a caller reusing a remembered decision must ask again
   * rather than assume the unfingerprintable credential is unchanged.
   */
  hasUnfingerprintableCredential: boolean;
  /** Number of individual credential-bearing fields removed or rewritten. */
  redactedCount: number;
}

/** Collector threaded through the redaction pass. */
interface RedactionAccumulator {
  paths: string[];
  fingerprints: string[];
  count: number;
  /** Whether some redacted value could not be serialized, and so not fingerprinted. */
  unfingerprintable: boolean;
}

/**
 * Hash a credential value to a short, stable 64-bit token: two independent
 * FNV-1a-style lanes, the first with the canonical FNV prime and the second
 * with a MurmurHash3 mixing constant so the lanes do not move together.
 *
 * The digest never leaves memory and is only ever compared for equality, so it
 * needs to be stable and cheap rather than cryptographic. Hashing rather than
 * retaining the value keeps the secret itself out of the remembered choices.
 *
 * A collision costs a *missed* confirmation, not a spurious one: a caller
 * comparing fingerprints would treat a different secret as one the user already
 * accepted. That is why this is 64 bits rather than 32, and why a value that
 * cannot be serialized returns null rather than hashing a lossy `String(value)`
 * that would collapse every such value onto `[object Object]`.
 *
 * @returns The digest, or null when the value cannot be serialized.
 */
function fingerprintValue(value: unknown): string | null {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? String(value);
  } catch {
    return null;
  }
  let low = 0x811c9dc5;
  let high = 0x27220a95;
  for (let index = 0; index < serialized.length; index += 1) {
    const code = serialized.charCodeAt(index);
    low = Math.imul(low ^ code, 0x01000193);
    high = Math.imul(high ^ code, 0x85ebca6b);
  }
  return `${(low >>> 0).toString(36)}.${(high >>> 0).toString(36)}`;
}

/** Record one redaction, with the fingerprint of the value being removed. */
function recordRedaction(
  accumulator: RedactionAccumulator,
  path: string,
  value: unknown,
  count = 1,
): void {
  const digest = fingerprintValue(value);
  accumulator.paths.push(path);
  // A value that cannot be serialized fails closed: it is reported through
  // `hasUnfingerprintableCredential` rather than fingerprinted, so a caller
  // asks again instead of reusing an answer it cannot verify still applies.
  if (digest === null) accumulator.unfingerprintable = true;
  else accumulator.fingerprints.push(`${path}=${digest}`);
  accumulator.count += count;
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
/**
 * Depth at which the redaction pass stops descending and fails closed.
 * Exported so a caller that predicts what redaction will remove (the Share
 * dialog's readiness check) scans exactly as deep as this pass does, instead of
 * keeping a second, shallower cap that would silently disagree.
 */
export const MAX_REDACT_DEPTH = 12;

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
  accumulator: RedactionAccumulator,
  depth = 0,
): unknown {
  if (depth >= MAX_REDACT_DEPTH) {
    // Fail closed. A deeply nested configuration shape is not needed to render
    // any built-in layer, and returning it unchanged would let a credential
    // bypass the invariant merely by exceeding the traversal cap.
    recordRedaction(accumulator, path, value);
    return undefined;
  }
  if (typeof value === "string") {
    const redacted = redactUrlCredentials(value);
    if (redacted !== value) {
      recordRedaction(accumulator, path, value);
    }
    return redacted;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      redactConfigurationValue(item, `${path}[${index}]`, accumulator, depth + 1),
    );
  }
  if (!isPlainObject(value)) return value;
  if (isGeoJsonPayload(value)) return structuredClone(value);

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    const nestedPath = path ? `${path}.${key}` : key;
    if (isCredentialFieldName(key)) {
      recordRedaction(accumulator, nestedPath, nested);
      continue;
    }
    result[key] = redactConfigurationValue(nested, nestedPath, accumulator, depth + 1);
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
 * a no-secret guarantee. The first-party map controls in
 * {@link PUBLISHABLE_PLUGIN_SETTINGS} are the exception: their state is known
 * and carries no credentials, and dropping it stripped the legend, colorbar,
 * and swipe from the exported map. Manifest URLs, activation, and control
 * positions stay intact so recipients can still load and configure the plugin
 * themselves.
 */
export function redactProjectCredentials(project: GeoLibreProject): CredentialRedactionResult {
  const accumulator: RedactionAccumulator = {
    paths: [],
    fingerprints: [],
    count: 0,
    unfingerprintable: false,
  };
  const basemapStyleUrl =
    typeof project.basemapStyleUrl === "string"
      ? redactUrlCredentials(project.basemapStyleUrl)
      : project.basemapStyleUrl;
  if (basemapStyleUrl !== project.basemapStyleUrl) {
    recordRedaction(accumulator, "basemapStyleUrl", project.basemapStyleUrl);
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
        recordRedaction(accumulator, `preferences.geocoding.${field}`, endpoint);
      }
    }
  }
  const preferences = project.preferences
    ? { ...project.preferences, environmentVariables: [], geocoding }
    : project.preferences;
  const populatedEnvironmentVariables =
    project.preferences?.environmentVariables?.filter((variable) => variable.key.trim()) ?? [];
  if (populatedEnvironmentVariables.length > 0) {
    recordRedaction(
      accumulator,
      "preferences.environmentVariables",
      populatedEnvironmentVariables,
      populatedEnvironmentVariables.length,
    );
  }
  const geocodingApiKeys = project.preferences?.geocoding?.apiKeys ?? {};
  if (Object.keys(geocodingApiKeys).length > 0) {
    recordRedaction(
      accumulator,
      "preferences.geocoding.apiKeys",
      geocodingApiKeys,
      Object.keys(geocodingApiKeys).length,
    );
  }

  const layers = (project.layers ?? []).map((layer, index) => ({
    ...layer,
    source: redactConfigurationValue(
      layer.source,
      `layers[${index}].source`,
      accumulator,
    ) as Record<string, unknown>,
    metadata: redactConfigurationValue(
      layer.metadata,
      `layers[${index}].metadata`,
      accumulator,
    ) as Record<string, unknown>,
    ...(typeof layer.sourcePath === "string"
      ? {
          sourcePath: redactConfigurationValue(
            layer.sourcePath,
            `layers[${index}].sourcePath`,
            accumulator,
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
            accumulator,
          ) as LayerConnection,
        }
      : {}),
  }));

  let plugins = project.plugins;
  if (plugins) {
    const manifestUrls = plugins.manifestUrls.map((url, index) => {
      const redacted = redactUrlCredentials(url);
      if (redacted !== url) {
        recordRedaction(accumulator, `plugins.manifestUrls[${index}]`, url);
      }
      return redacted;
    });
    const settings = plugins.settings ?? {};
    const kept: Record<string, unknown> = {};
    const dropped: Record<string, unknown> = {};
    for (const [id, value] of Object.entries(settings)) {
      const allowed = Object.prototype.hasOwnProperty.call(PUBLISHABLE_PLUGIN_SETTINGS, id)
        ? PUBLISHABLE_PLUGIN_SETTINGS[id]
        : undefined;
      if (allowed === undefined) {
        dropped[id] = value;
        continue;
      }
      if (allowed === null) {
        kept[id] = value;
        continue;
      }
      // An unexpected shape is dropped rather than passed through.
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        dropped[id] = value;
        continue;
      }
      const subset: Record<string, unknown> = {};
      const rest: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (allowed.includes(key)) subset[key] = item;
        else rest[key] = item;
      }
      if (Object.keys(subset).length > 0) kept[id] = subset;
      if (Object.keys(rest).length > 0) dropped[id] = rest;
    }
    if (Object.keys(dropped).length > 0) {
      recordRedaction(accumulator, "plugins.settings", dropped, countLeafValues(dropped));
    }
    // What survives is still swept by the same pass layer configuration gets,
    // so a credentialed URL inside a kept blob is scrubbed rather than trusted.
    plugins = {
      ...plugins,
      manifestUrls,
      settings: redactConfigurationValue(kept, "plugins.settings", accumulator) as Record<
        string,
        unknown
      >,
    };
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
            metadata: redactConfigurationValue(project.metadata, "metadata", accumulator) as Record<
              string,
              unknown
            >,
          }
        : {}),
    },
    redactedPaths: [...new Set(accumulator.paths)],
    redactedFingerprints: [...new Set(accumulator.fingerprints)],
    hasUnfingerprintableCredential: accumulator.unfingerprintable,
    redactedCount: accumulator.count,
  };
}

/** Convenience wrapper for callers that only need the safe project. */
export function redactCredentials(project: GeoLibreProject): GeoLibreProject {
  return redactProjectCredentials(project).project;
}
