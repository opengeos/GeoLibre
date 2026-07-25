import type { AssistantProfile } from "./provider";
import {
  ASSISTANT_PROVIDER_IDS,
  configForProvider,
  defaultModelFor,
  PROVIDER_LABELS,
  readRuntimeEnv,
  type AssistantProviderConfig,
  type RuntimeEnv,
} from "./provider";
import { PROVIDER_FIELDS } from "./provider-fields";

/** Generate a unique profile id (no UUID dependency). */
function generateProfileId(): string {
  return `prof_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Migrate a legacy flat `aiProviderEnv` map to an array of {@link AssistantProfile}.
 * The legacy format stored every env var key/value in one flat map; we split it
 * per provider, creating one profile for each configured provider.
 *
 * @param aiProviderEnv The legacy env-var map (may be empty).
 * @param existingProfiles Any profiles already migrated (dedup by env-var content).
 * @returns An array of profiles migrated from the legacy map.
 */
export function migrateLegacyAiEnv(
  aiProviderEnv: Record<string, string>,
  existingProfiles: AssistantProfile[],
): AssistantProfile[] {
  const entries = Object.entries(aiProviderEnv).filter(
    ([, value]) => typeof value === "string" && value.trim(),
  );
  if (entries.length === 0) return [];

  const result: AssistantProfile[] = [];

  for (const provider of ASSISTANT_PROVIDER_IDS) {
    const fields = PROVIDER_FIELDS[provider] as readonly { envKey: string }[];
    const fieldKeys = new Set<string>(fields.map((f) => f.envKey));
    const fieldValues: Record<string, string> = {};

    for (const [key, value] of entries) {
      if (fieldKeys.has(key)) {
        fieldValues[key] = value.trim();
      }
    }

    // Only create a profile if at least one field has a value.
    if (Object.keys(fieldValues).length === 0) continue;

    // Skip if a profile with the exact same field values already exists.
    const isDuplicate = existingProfiles.some(
      (p) =>
        p.provider === provider &&
        Object.entries(fieldValues).every(([k, v]) => p.fieldValues[k] === v) &&
        Object.keys(p.fieldValues).length === Object.keys(fieldValues).length,
    );
    if (isDuplicate) continue;

    result.push({
      id: generateProfileId(),
      name: PROVIDER_LABELS[provider],
      provider,
      modelId: defaultModelFor(provider),
      fieldValues,
    });
  }

  return result;
}

/** Return the config for a profile, merging its field values into the runtime env. */
export function configForProfile(
  profile: AssistantProfile,
  env: RuntimeEnv = readRuntimeEnv(),
): AssistantProviderConfig | null {
  // Merge the profile's field values into the runtime env so configForProvider
  // can resolve them alongside any broader env vars (fallback keys, OS env).
  const augmented: RuntimeEnv = { ...env, ...profile.fieldValues };
  return configForProvider(profile.provider, profile.modelId, augmented);
}
