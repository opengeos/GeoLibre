import type { AssistantProfile } from "./provider";
import {
  ASSISTANT_PROVIDER_IDS,
  configForProvider,
  PROVIDER_LABELS,
  readRuntimeEnv,
  type AssistantProviderConfig,
  type RuntimeEnv,
} from "./provider";
import { PROVIDER_FIELDS } from "./provider-fields";

/**
 * Default model per provider (empty for `custom`, which requires its own).
 * Mirrors the private `DEFAULT_MODEL` in provider.ts so we avoid re-exporting it.
 */
const DEFAULT_MODEL: Record<string, string> = {
  google: "gemini-3.5-flash",
  anthropic: "claude-opus-4-8",
  openai: "gpt-5.5",
  ollama: "llama3.2",
  bedrock: "global.anthropic.claude-sonnet-4-6",
  custom: "",
};

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
      modelId: DEFAULT_MODEL[provider] ?? "",
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

/** The default profile id, or null if none is set. Read from localStorage. */
export function readDefaultProfileId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem("geolibre.assistant.defaultProfile");
  } catch {
    return null;
  }
}

/** Persist the default profile id to localStorage. */
export function saveDefaultProfileId(id: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (id) {
      window.localStorage.setItem("geolibre.assistant.defaultProfile", id);
    } else {
      window.localStorage.removeItem("geolibre.assistant.defaultProfile");
    }
  } catch {
    // Best-effort persistence.
  }
}
