/**
 * Splits the credential fields out of {@link DesktopSettings} so the desktop
 * build can keep them in the OS credential store (issue #1667) while the rest
 * of the settings blob stays in localStorage.
 *
 * The account names below are stored in users' keychains: renaming one orphans
 * every credential saved under the old name.
 */
import type { DesktopSettings } from "../hooks/useDesktopSettings";
import type { AssistantProviderId } from "./assistant/provider";
import { PROVIDER_FIELDS, type ProviderField } from "./assistant/provider-fields";
import { S3_CONNECTION_SECRET_FIELDS } from "./s3-connections";

const SETTINGS_SECRET_ACCOUNTS = {
  shareToken: "settings.shareToken",
  cesiumIonToken: "settings.cesiumIonToken",
  mapboxAccessToken: "settings.mapboxAccessToken",
  arcgisApiKey: "settings.arcgisApiKey",
} as const satisfies Partial<Record<keyof DesktopSettings, string>>;

type SettingsSecretField = keyof typeof SETTINGS_SECRET_ACCOUNTS;

const SETTINGS_SECRET_FIELDS = Object.keys(SETTINGS_SECRET_ACCOUNTS) as SettingsSecretField[];

export function aiProfileSecretAccount(profileId: string, fieldKey: string): string {
  return `ai.${profileId}.${fieldKey}`;
}

export function s3ConnectionSecretAccount(connectionId: string, field: string): string {
  return `s3.${connectionId}.${field}`;
}

/** Every env key (canonical names and aliases) a provider treats as secret. */
function secretFieldKeys(provider: AssistantProviderId): string[] {
  const fields: readonly ProviderField[] = PROVIDER_FIELDS[provider] ?? [];
  return fields
    .filter((field) => field.secret)
    .flatMap((field) => [field.envKey, ...(field.aliases ?? [])]);
}

export function isSecretAssistantField(provider: AssistantProviderId, key: string): boolean {
  return secretFieldKeys(provider).includes(key);
}

export function splitDesktopSettingsSecrets(settings: DesktopSettings): {
  publicSettings: DesktopSettings;
  secrets: Record<string, string>;
} {
  const secrets: Record<string, string> = {};
  const publicSettings: DesktopSettings = { ...settings };
  for (const field of SETTINGS_SECRET_FIELDS) {
    if (settings[field]) secrets[SETTINGS_SECRET_ACCOUNTS[field]] = settings[field];
    publicSettings[field] = "";
  }
  publicSettings.aiProfiles = settings.aiProfiles.map((profile) => {
    const fieldValues: Record<string, string> = {};
    for (const [key, value] of Object.entries(profile.fieldValues)) {
      if (!isSecretAssistantField(profile.provider, key)) {
        fieldValues[key] = value;
      } else if (value) {
        secrets[aiProfileSecretAccount(profile.id, key)] = value;
      }
    }
    return { ...profile, fieldValues };
  });
  publicSettings.s3Connections = settings.s3Connections.map((connection) => {
    const stripped = { ...connection };
    for (const field of S3_CONNECTION_SECRET_FIELDS) {
      if (connection[field])
        secrets[s3ConnectionSecretAccount(connection.id, field)] = connection[field];
      stripped[field] = "";
    }
    return stripped;
  });
  return { publicSettings, secrets };
}

/** Restores `secrets` into `settings`; secrets for unknown profiles are ignored. */
export function mergeDesktopSettingsSecrets(
  settings: DesktopSettings,
  secrets: Readonly<Record<string, string>>,
): DesktopSettings {
  const merged: DesktopSettings = { ...settings };
  for (const field of SETTINGS_SECRET_FIELDS) {
    const value = secrets[SETTINGS_SECRET_ACCOUNTS[field]];
    if (value !== undefined) merged[field] = value;
  }
  merged.aiProfiles = settings.aiProfiles.map((profile) => {
    const fieldValues = { ...profile.fieldValues };
    for (const key of secretFieldKeys(profile.provider)) {
      const value = secrets[aiProfileSecretAccount(profile.id, key)];
      if (value !== undefined) fieldValues[key] = value;
    }
    return { ...profile, fieldValues };
  });
  merged.s3Connections = settings.s3Connections.map((connection) => {
    const restored = { ...connection };
    for (const field of S3_CONNECTION_SECRET_FIELDS) {
      const value = secrets[s3ConnectionSecretAccount(connection.id, field)];
      if (value !== undefined) restored[field] = value;
    }
    return restored;
  });
  return merged;
}

/** Every account that may hold a secret for `settings` (the read set at startup). */
export function desktopSettingsSecretAccounts(settings: DesktopSettings): string[] {
  return [
    ...Object.values(SETTINGS_SECRET_ACCOUNTS),
    ...settings.aiProfiles.flatMap((profile) =>
      secretFieldKeys(profile.provider).map((key) => aiProfileSecretAccount(profile.id, key)),
    ),
    ...settings.s3Connections.flatMap((connection) =>
      S3_CONNECTION_SECRET_FIELDS.map((field) => s3ConnectionSecretAccount(connection.id, field)),
    ),
  ];
}
