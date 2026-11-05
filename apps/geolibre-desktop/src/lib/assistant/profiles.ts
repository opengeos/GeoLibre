import type { AssistantProfile } from "./provider";
import {
  ASSISTANT_PROVIDER_IDS,
  configForProvider,
  defaultModelFor,
  PROVIDER_LABELS,
  readRuntimeEnv,
  type AssistantProviderConfig,
  type AssistantProviderId,
  type RuntimeEnv,
} from "./provider";
import { PROVIDER_FIELDS } from "./provider-fields";

/**
 * The env var a provider's profile used to carry its model id in, beside the
 * model selector. A profile now keeps its model only in `modelId`, so a value
 * saved under this key is folded into `modelId` when settings load.
 */
const LEGACY_PROFILE_MODEL_FIELD: Partial<Record<AssistantProviderId, string>> = {
  ollama: "OLLAMA_MODEL",
};

/**
 * Move a model id saved in a profile's credential fields into its `modelId`.
 *
 * Ollama profiles once showed an optional `OLLAMA_MODEL` text field next to the
 * model selector, but the selector's `modelId` always won when the assistant
 * resolved its config, so a model typed into the field was silently ignored. A
 * non-blank value there is what the user meant to run, so it replaces `modelId`;
 * the field is dropped either way so the profile holds a single model id.
 *
 * @param profile A normalized profile.
 * @returns The same profile when there is nothing to fold, else an updated copy.
 */
export function foldLegacyProfileModelField(profile: AssistantProfile): AssistantProfile {
  const own = LEGACY_PROFILE_MODEL_FIELD[profile.provider];
  // A profile switched away from Ollama by an older build kept its
  // OLLAMA_MODEL. Drop it too, or switching back would resurrect it on the
  // next load over the model the user typed.
  const legacyKeys = Object.values(LEGACY_PROFILE_MODEL_FIELD).filter(
    (key) => key in profile.fieldValues,
  );
  if (legacyKeys.length === 0) return profile;
  const fieldValues = { ...profile.fieldValues };
  for (const key of legacyKeys) delete fieldValues[key];
  const legacyModel = own ? profile.fieldValues[own]?.trim() : "";
  return { ...profile, modelId: legacyModel || profile.modelId, fieldValues };
}

/** Generate a unique profile id (no UUID dependency). */
function generateProfileId(): string {
  return `prof_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export interface ActiveAssistantProfileOptions {
  profiles: AssistantProfile[];
  defaultProfileId: string | null;
  selectedProfileId: string | null;
  userExplicitlyChoseProfile: boolean;
  deploymentProxyConfigured: boolean;
}

/**
 * Choose the assistant profile that should pin the current session.
 *
 * @param options Profile state and deployment-proxy availability.
 * @returns The active profile, or null to let provider auto-resolution choose.
 */
export function selectActiveAssistantProfile({
  profiles,
  defaultProfileId,
  selectedProfileId,
  userExplicitlyChoseProfile,
  deploymentProxyConfigured,
}: ActiveAssistantProfileOptions): AssistantProfile | null {
  if (userExplicitlyChoseProfile) {
    if (!selectedProfileId) return null;
    const selected = profiles.find((profile) => profile.id === selectedProfileId);
    if (selected) return selected;
  }
  if (defaultProfileId) {
    const found = profiles.find((profile) => profile.id === defaultProfileId);
    if (found) return found;
  }
  if (deploymentProxyConfigured) return null;
  return profiles[0] ?? null;
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
    // Carry a legacy model override along so the fold below can apply it.
    const legacyModelKey = LEGACY_PROFILE_MODEL_FIELD[provider];
    if (legacyModelKey) fieldKeys.add(legacyModelKey);
    const fieldValues: Record<string, string> = {};

    for (const [key, value] of entries) {
      if (fieldKeys.has(key)) {
        fieldValues[key] = value.trim();
      }
    }

    // Only create a profile if at least one field has a value.
    if (Object.keys(fieldValues).length === 0) continue;

    // Fold first: profiles already loaded were folded, so compare like with
    // like. A folded legacy model counts too, since before the fold it was one
    // of the compared field values.
    const candidate = foldLegacyProfileModelField({
      id: generateProfileId(),
      name: PROVIDER_LABELS[provider],
      provider,
      modelId: defaultModelFor(provider),
      fieldValues,
    });
    const foldedModel = legacyModelKey !== undefined && legacyModelKey in fieldValues;
    const candidateKeys = Object.keys(candidate.fieldValues);

    // Skip if a profile with the exact same field values already exists.
    const isDuplicate = existingProfiles.some(
      (p) =>
        p.provider === provider &&
        candidateKeys.every((k) => p.fieldValues[k] === candidate.fieldValues[k]) &&
        Object.keys(p.fieldValues).length === candidateKeys.length &&
        (!foldedModel || p.modelId === candidate.modelId),
    );
    if (isDuplicate) continue;

    result.push(candidate);
  }

  return result;
}

/** An explicit provider/model pin from the legacy UI picker. */
export type AssistantProviderSelection = { provider: AssistantProviderId; model?: string };

/** Field separator for selection keys; never appears in a provider id or a credential. */
const KEY_SEPARATOR = "\u0000";

/**
 * Build a stable, value-based identity for an assistant selection. Two
 * selections sharing a key resolve to the same provider, model, and
 * credentials, so a session already built from one can keep serving the other
 * — conversation history included.
 *
 * Only the fields that feed {@link configForProfile} and `configForProvider`
 * are included. A profile's `name` is deliberately left out: renaming a profile
 * in Settings does not change how its agent is built, so it must not count as a
 * different selection.
 *
 * @param selection A saved profile, a legacy provider/model pin, or null for
 *   auto-resolution from the runtime env.
 * @returns An opaque string to compare with `===`.
 */
export function assistantSelectionKey(
  selection: AssistantProviderSelection | AssistantProfile | null,
): string {
  if (!selection) return "auto";
  if ("fieldValues" in selection) {
    // Sort the credential keys so an equivalent profile that happens to have
    // been built in a different insertion order still compares equal.
    const fields = Object.keys(selection.fieldValues)
      .sort()
      .map((key) => `${key}=${selection.fieldValues[key]}`);
    return ["profile", selection.id, selection.provider, selection.modelId, ...fields].join(
      KEY_SEPARATOR,
    );
  }
  return ["provider", selection.provider, selection.model ?? ""].join(KEY_SEPARATOR);
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
