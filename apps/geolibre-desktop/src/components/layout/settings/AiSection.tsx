import { useMemo } from "react";
import {
  scopeOsEnvToProject,
  type AssistantProfile,
  type RuntimeEnv,
} from "../../../lib/assistant/provider";
import type { ProviderField } from "../../../lib/assistant/provider-fields";
import { AiSectionContent } from "../AiSectionContent";
import { CredentialStorageNotice } from "../CredentialStorageNotice";
import { useSettingsDraft } from "./SettingsDraftContext";

interface AiSectionProps {
  /** OS environment values, read by the dialog shell when it mounts. */
  osEnv: RuntimeEnv;
  /**
   * The AI profile being edited. Null when no profile is selected (the user
   * sees the profile list). Owned by the shell, whose footer swaps to a hint
   * while a profile is being edited.
   */
  editingProfileId: string | null;
  setEditingProfileId: (id: string | null) => void;
  /** Whether the user is creating a new profile (transient — no id yet). */
  isCreatingProfile: boolean;
  setIsCreatingProfile: (creating: boolean) => void;
}

/**
 * The AI Providers section: assistant profiles and their credentials.
 *
 * Args:
 *   props: The section props.
 *
 * Returns:
 *   The section content.
 */
export function AiSection({
  osEnv,
  editingProfileId,
  setEditingProfileId,
  isCreatingProfile,
  setIsCreatingProfile,
}: AiSectionProps) {
  const {
    draftPreferences,
    setDraftPreferences,
    draftDesktopSettings,
    setDraftDesktopSettings,
    setError,
    revealedValueIds,
    toggleValueVisibility,
  } = useSettingsDraft();

  // Enabled, named project environment values shadow OS values when the settings
  // fields resolve which credential to surface.
  const draftEnv = useMemo(() => {
    const env: Record<string, string> = {};
    for (const variable of draftPreferences.environmentVariables) {
      const key = variable.key.trim();
      if (variable.enabled && key) env[key] = variable.value;
    }
    return env;
  }, [draftPreferences.environmentVariables]);

  /** The editing profile (the one whose fields are shown), or null. */
  const editingProfile: AssistantProfile | null = useMemo(() => {
    if (isCreatingProfile) return null;
    if (!editingProfileId) return null;
    return draftDesktopSettings.aiProfiles.find((p) => p.id === editingProfileId) ?? null;
  }, [editingProfileId, isCreatingProfile, draftDesktopSettings.aiProfiles]);

  /**
   * Flat env map from saved profile fieldValues. Its names prevent matching OS
   * credentials from shadowing the values shown in the profile editor.
   */
  const draftProfilesEnv = useMemo(() => {
    const env: Record<string, string> = {};
    for (const profile of draftDesktopSettings.aiProfiles) {
      for (const [key, value] of Object.entries(profile.fieldValues)) {
        const name = key.trim();
        if (name && value) env[name] = value;
      }
    }
    return env;
  }, [draftDesktopSettings.aiProfiles]);
  // Scope OS values against draft credentials so fields surface the same value
  // as runtime resolution, including credential aliases.
  const scopedOsEnv = useMemo(
    () =>
      scopeOsEnvToProject(
        osEnv,
        new Set([...Object.keys(draftEnv), ...Object.keys(draftProfilesEnv)]),
      ),
    [osEnv, draftEnv, draftProfilesEnv],
  );
  const modelEnv = useMemo(
    () => ({
      OPENROUTER_MODEL: draftEnv.OPENROUTER_MODEL ?? scopedOsEnv.OPENROUTER_MODEL ?? "",
      AI_GATEWAY_MODEL: draftEnv.AI_GATEWAY_MODEL ?? scopedOsEnv.AI_GATEWAY_MODEL ?? "",
    }),
    [
      scopedOsEnv.OPENROUTER_MODEL,
      scopedOsEnv.AI_GATEWAY_MODEL,
      draftEnv.OPENROUTER_MODEL,
      draftEnv.AI_GATEWAY_MODEL,
    ],
  );

  // Every env var name a field is backed by: its canonical key plus any aliases
  // provider.ts also accepts (e.g. GOOGLE_API_KEY for the Gemini field).
  const fieldEnvKeys = (field: ProviderField): readonly string[] => [
    field.envKey,
    ...(field.aliases ?? []),
  ];

  // The value of an env-var-backed AI provider field, or "" when unset. Reads
  // the editing profile's field values first (where the AI section saves keys),
  // then falls back to a matching value still held in the project's Environment
  // variables so an existing credential stays visible and editable here.
  const getProviderField = (field: ProviderField): string => {
    if (editingProfile) {
      for (const key of fieldEnvKeys(field)) {
        const value = editingProfile.fieldValues[key];
        if (value) return value;
      }
    }
    for (const key of fieldEnvKeys(field)) {
      const row = draftPreferences.environmentVariables.find(
        (variable) => variable.key === key && variable.enabled,
      );
      if (row) return row.value;
    }
    return "";
  };

  // The OS-environment variable name backing a field, when the system provides
  // a value the project doesn't. Drives the "read from your environment" badge
  // so a user sees a key is already covered without typing (or saving) it here.
  const osFieldEnvName = (field: ProviderField): string | null => {
    for (const key of fieldEnvKeys(field)) {
      if (scopedOsEnv[key]?.trim()) return key;
    }
    return null;
  };

  // Write an AI provider field to the editing profile's field values. Any alias
  // entry is dropped so re-entering a credential never leaves a stale duplicate
  // under an alias, and clearing removes the entry so the store never accrues
  // empty values. The matching rows are also removed from the project's
  // Environment variables: these keys now live in the profile, so a leftover
  // project row must not shadow the profile value at runtime (project env has
  // higher precedence) nor get serialized into a shared project file.
  const setProviderField = (field: ProviderField, value: string) => {
    if (!editingProfile) return;
    const keys = fieldEnvKeys(field);
    setDraftDesktopSettings((current) => {
      const next = current.aiProfiles.map((p) => {
        if (p.id !== editingProfile.id) return p;
        const nextFieldValues = { ...p.fieldValues };
        for (const key of keys) delete nextFieldValues[key];
        if (value !== "") nextFieldValues[field.envKey] = value;
        return { ...p, fieldValues: nextFieldValues };
      });
      return { ...current, aiProfiles: next };
    });
    setDraftPreferences((current) => {
      if (!current.environmentVariables.some((v) => keys.includes(v.key))) {
        return current;
      }
      return {
        ...current,
        environmentVariables: current.environmentVariables.filter((v) => !keys.includes(v.key)),
      };
    });
    setError(null);
  };

  return (
    <div className="space-y-5">
      <CredentialStorageNotice />
      <AiSectionContent
        draftDesktopSettings={draftDesktopSettings}
        draftEnv={draftEnv}
        setDraftDesktopSettings={setDraftDesktopSettings}
        editingProfileId={editingProfileId}
        setEditingProfileId={setEditingProfileId}
        isCreatingProfile={isCreatingProfile}
        setIsCreatingProfile={setIsCreatingProfile}
        editingProfile={editingProfile}
        defaultAiProfileId={draftDesktopSettings.defaultAiProfileId}
        scopedOsEnv={scopedOsEnv}
        modelEnv={modelEnv}
        revealedValueIds={revealedValueIds}
        toggleValueVisibility={toggleValueVisibility}
        getProviderField={getProviderField}
        setProviderField={setProviderField}
        osFieldEnvName={osFieldEnvName}
      />
    </div>
  );
}
