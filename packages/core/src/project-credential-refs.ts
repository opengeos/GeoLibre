/**
 * Credentials a project refers to by name rather than carrying inline.
 *
 * On the desktop app the geocoding API keys and secret environment variables
 * of a project live in the OS keychain, keyed device-wide by provider id /
 * variable name. The project file keeps the names with empty values. Request
 * headers never go there: they reference variables as `${NAME}` instead (see
 * `resolveProjectHeaderReferences`). This module is the pure half of that
 * scheme: the account names, the overlay that fills empty values from the
 * stored ones, and the split that moves values out of a project before it is
 * written. The app installs the lookup; without one (web, Jupyter) every
 * function here is the identity, so values stay in the project file.
 *
 * A non-empty value in the project always wins over the stored one: a file
 * that still carries plaintext (older files, the web build) is used as-is for
 * the session.
 */

import { GEOCODING_PROVIDERS } from "./geocoding";
import { resolveHeaderReferences } from "./header-references";
import { useAppStore } from "./store";
import type {
  GeocodingPreferences,
  GeoLibreProject,
  ProjectPreferences,
  RuntimeEnvironmentVariable,
} from "./types";

// Account names are stable keychain data: renaming one orphans every value a
// user already stored under it.
export function geocodingApiKeyAccount(providerId: string): string {
  return `project.geocoding.apiKey.${providerId}`;
}

export function environmentVariableAccount(key: string): string {
  return `project.env.${key}`;
}

/** Rows are secret unless explicitly marked `secret: false`. */
export function isSecretEnvironmentVariable(variable: RuntimeEnvironmentVariable): boolean {
  return variable.secret !== false;
}

export type ProjectCredentialLookup = (account: string) => string | undefined;

let projectCredentialLookup: ProjectCredentialLookup | null = null;

/** Install (or clear, with `null`) the source of stored project credentials. */
export function setProjectCredentialLookup(lookup: ProjectCredentialLookup | null): void {
  projectCredentialLookup = lookup;
}

/** The stored value for `account`, or `undefined` when none (or no lookup). */
export function lookupProjectCredential(account: string): string | undefined {
  const value = projectCredentialLookup?.(account);
  return value ? value : undefined;
}

/** Fill empty geocoding API keys from the stored ones. */
export function overlayStoredGeocodingApiKeys(
  geocoding: GeocodingPreferences,
): GeocodingPreferences {
  let apiKeys: Record<string, string> | null = null;
  for (const { id } of GEOCODING_PROVIDERS) {
    if (geocoding.apiKeys[id]?.trim()) continue;
    const stored = lookupProjectCredential(geocodingApiKeyAccount(id));
    if (!stored) continue;
    apiKeys ??= { ...geocoding.apiKeys };
    apiKeys[id] = stored;
  }
  return apiKeys ? { ...geocoding, apiKeys } : geocoding;
}

/** Fill empty secret environment variable values from the stored ones. */
export function overlayStoredEnvironmentVariables(
  variables: RuntimeEnvironmentVariable[],
): RuntimeEnvironmentVariable[] {
  let changed = false;
  const overlaid = variables.map((variable) => {
    if (!isSecretEnvironmentVariable(variable) || variable.value !== "") return variable;
    const key = variable.key.trim();
    const stored = key ? lookupProjectCredential(environmentVariableAccount(key)) : undefined;
    if (!stored) return variable;
    changed = true;
    return { ...variable, value: stored };
  });
  return changed ? overlaid : variables;
}

/** Preferences with every empty stored credential filled in. */
export function overlayStoredPreferenceCredentials(
  preferences: ProjectPreferences,
): ProjectPreferences {
  const geocoding = overlayStoredGeocodingApiKeys(preferences.geocoding);
  const environmentVariables = overlayStoredEnvironmentVariables(preferences.environmentVariables);
  if (
    geocoding === preferences.geocoding &&
    environmentVariables === preferences.environmentVariables
  ) {
    return preferences;
  }
  return { ...preferences, geocoding, environmentVariables };
}

/**
 * The credential changes an edited Settings draft makes, keyed by account
 * (`""` deletes).
 *
 * - `seeded`: the overlaid preferences the dialog opened with.
 * - `next`: the normalized draft being saved.
 *
 * Only values the user changed are returned, so an untouched session override
 * (plaintext from the opened file) stays out of the keychain and opening a
 * file never writes it. Removing, renaming, or un-secreting a variable never
 * deletes its stored value: names are shared by every project on the device.
 * Clearing a field deletes the stored value only when the field showed that
 * stored value; clearing a file override that differed from it just drops the
 * override, so the shared value applies again and other projects keep it.
 */
export function changedPreferenceCredentials(
  seeded: ProjectPreferences,
  next: ProjectPreferences,
): Record<string, string> {
  const changes: Record<string, string> = {};
  const record = (account: string, seededValue: string, nextValue: string) => {
    if (nextValue === seededValue) return;
    if (nextValue === "" && seededValue !== lookupProjectCredential(account)) return;
    changes[account] = nextValue;
  };

  const providerIds = new Set([
    ...Object.keys(seeded.geocoding.apiKeys),
    ...Object.keys(next.geocoding.apiKeys),
  ]);
  for (const providerId of providerIds) {
    record(
      geocodingApiKeyAccount(providerId),
      seeded.geocoding.apiKeys[providerId]?.trim() ?? "",
      next.geocoding.apiKeys[providerId]?.trim() ?? "",
    );
  }

  const seededSecrets = new Map<string, string>();
  for (const variable of seeded.environmentVariables) {
    if (!isSecretEnvironmentVariable(variable) || seededSecrets.has(variable.key)) continue;
    seededSecrets.set(variable.key, variable.value);
  }
  for (const variable of next.environmentVariables) {
    if (!isSecretEnvironmentVariable(variable)) continue;
    const seededValue = seededSecrets.get(variable.key);
    // A new blank row falls back to any value stored under the name; it
    // never deletes it.
    if (seededValue === undefined && variable.value === "") continue;
    record(environmentVariableAccount(variable.key), seededValue ?? "", variable.value);
  }

  return changes;
}

/**
 * Move unambiguous geocoding API keys and secret environment variable values
 * out of `project` (a copy; the input is untouched) into `secrets`, keyed by
 * account. Secret environment rows that have no unique name remain in the
 * project for an explicit keep/strip choice. Layers pass through: their
 * request headers reference variables as `${NAME}` rather than holding
 * secrets that need moving.
 */
export function splitProjectCredentials(project: GeoLibreProject): {
  project: GeoLibreProject;
  secrets: Record<string, string>;
} {
  const secrets: Record<string, string> = {};

  for (const [providerId, apiKey] of Object.entries(project.preferences.geocoding.apiKeys)) {
    const trimmed = apiKey.trim();
    if (trimmed) secrets[geocodingApiKeyAccount(providerId)] = trimmed;
  }
  // A hand-edited file can contain duplicate names even though Settings
  // rejects them. One keychain account cannot preserve two different values.
  const nameCounts = new Map<string, number>();
  for (const variable of project.preferences.environmentVariables) {
    const key = variable.key.trim();
    if (key) nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }
  const environmentVariables = project.preferences.environmentVariables.map((variable) => {
    if (!isSecretEnvironmentVariable(variable) || variable.value === "") return variable;
    const key = variable.key.trim();
    // Keep ambiguous or nameless rows intact for the local keep/strip prompt.
    if (!key || (nameCounts.get(key) ?? 0) > 1) return variable;
    secrets[environmentVariableAccount(key)] = variable.value;
    return { ...variable, value: "" };
  });

  return {
    project: {
      ...project,
      preferences: {
        ...project.preferences,
        geocoding: { ...project.preferences.geocoding, apiKeys: {} },
        environmentVariables,
      },
    },
    secrets,
  };
}

/**
 * `headers` with every `${NAME}` resolved from the project's enabled
 * Environment Variables (stored secret values filled in). Only those rows
 * count, not the OS environment or build-time values that share the runtime
 * env. A header referencing an unset variable is dropped.
 */
export function resolveProjectHeaderReferences(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return headers;
  const values: Record<string, string> = {};
  const variables = overlayStoredEnvironmentVariables(
    useAppStore.getState().preferences.environmentVariables,
  );
  for (const variable of variables) {
    const key = variable.key.trim();
    if (variable.enabled && key) values[key] = variable.value;
  }
  return resolveHeaderReferences(headers, values);
}
