import {
  ASSISTANT_PROVIDER_IDS,
  PROVIDER_LABELS,
  PROVIDER_MODELS,
  defaultModelFor,
  type AssistantProfile,
  type AssistantProviderId,
} from "../../lib/assistant/provider";
import {
  PROVIDER_DOCS_URL,
  PROVIDER_FIELDS,
  type ProviderField,
} from "../../lib/assistant/provider-fields";
import { Button, Input, Label, Select, cn } from "@geolibre/ui";
import {
  Bot,
  Check,
  ExternalLink,
  Eye,
  EyeOff,
  Plus,
  Star,
  Terminal,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

// ── Locally-defined types to avoid circular import with SettingsDialog ──

export interface DraftDesktopSettings {
  layout: unknown;
  shareToken: string;
  cesiumIonToken: string;
  aiProfiles: AssistantProfile[];
  defaultAiProfileId: string | null;
  uiProfile: unknown;
  updates: unknown;
}

interface AiSectionContentProps {
  draftDesktopSettings: DraftDesktopSettings;
  setDraftDesktopSettings: React.Dispatch<React.SetStateAction<any>>;
  editingProfileId: string | null;
  setEditingProfileId: (id: string | null) => void;
  isCreatingProfile: boolean;
  setIsCreatingProfile: (v: boolean) => void;
  editingProfile: AssistantProfile | null;
  editingProvider: AssistantProviderId;
  defaultAiProfileId: string | null;
  scopedOsEnv: Record<string, string>;
  effectiveEnv: Record<string, string>;
  revealedValueIds: Set<string>;
  toggleValueVisibility: (id: string) => void;
  getProviderField: (field: ProviderField) => string;
  setProviderField: (field: ProviderField, value: string) => void;
  osFieldEnvName: (field: ProviderField) => string | null;
}

/**
 * The "AI Providers" section content inside Settings. Shows a profile list when
 * no profile is being edited, and a profile editor when one is selected.
 */
export function AiSectionContent({
  draftDesktopSettings,
  setDraftDesktopSettings,
  editingProfileId,
  setEditingProfileId,
  isCreatingProfile,
  setIsCreatingProfile,
  editingProfile,
  editingProvider,
  defaultAiProfileId,
  scopedOsEnv,
  effectiveEnv,
  revealedValueIds,
  toggleValueVisibility,
  getProviderField,
  setProviderField,
  osFieldEnvName,
}: AiSectionContentProps) {
  const { t } = useTranslation();

  // ── New profile form state (includes credential fields) ──
  const [newProfileName, setNewProfileName] = useState("");
  const [newProfileProvider, setNewProfileProvider] = useState<AssistantProviderId>("google");
  const [newProfileModel, setNewProfileModel] = useState(() => defaultModelFor("google"));
  /** Draft field values keyed by env var name for the new profile. */
  const [newProfileFieldValues, setNewProfileFieldValues] = useState<Record<string, string>>({});

  // Resolve which providers are configured from the effective env (from parent).
  // Re-derived here for internal status use.
  const configuredProviders = useMemo(() => {
    const order = ASSISTANT_PROVIDER_IDS;
    const result = new Set<AssistantProviderId>();
    for (const provider of order) {
      const config = providerConfigFromEnv(provider, effectiveEnv);
      if (config) result.add(provider);
    }
    return result;
  }, [effectiveEnv]);

  /** Update a single credential field value in the new-profile draft. */
  const updateNewFieldValue = (envKey: string, value: string) => {
    setNewProfileFieldValues((prev) => {
      const next = { ...prev };
      if (value) {
        next[envKey] = value;
      } else {
        delete next[envKey];
      }
      return next;
    });
  };

  /** Start editing an existing profile. */
  const editProfile = (id: string) => {
    setEditingProfileId(id);
    setIsCreatingProfile(false);
  };

  /** Start creating a new profile (shows full editor with credential fields). */
  const startCreating = () => {
    setNewProfileName("");
    setNewProfileProvider("google");
    setNewProfileModel(defaultModelFor("google"));
    setNewProfileFieldValues({});
    setIsCreatingProfile(true);
    setEditingProfileId(null);
  };

  /** Cancel editing/creating and return to the profile list. */
  const cancelEditing = () => {
    setEditingProfileId(null);
    setIsCreatingProfile(false);
  };

  /** Delete a profile by id. */
  const deleteProfile = (id: string) => {
    setDraftDesktopSettings((current: any) => ({
      ...current,
      aiProfiles: current.aiProfiles.filter((p: any) => p.id !== id),
      // Clear default if the deleted profile was the default.
      defaultAiProfileId:
        current.defaultAiProfileId === id ? null : current.defaultAiProfileId,
    }));
    if (editingProfileId === id) {
      setEditingProfileId(null);
    }
  };

  /** Set a profile as the default. */
  const setAsDefault = (id: string) => {
    setDraftDesktopSettings((current: any) => ({
      ...current,
      defaultAiProfileId: id,
    }));
  };

  /** Commit a newly-created profile. */
  const commitNewProfile = () => {
    const name = newProfileName.trim() || PROVIDER_LABELS[newProfileProvider];
    const id = `prof_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const profile: AssistantProfile = {
      id,
      name,
      provider: newProfileProvider,
      modelId: newProfileModel || defaultModelFor(newProfileProvider),
      fieldValues: { ...newProfileFieldValues },
    };
    setDraftDesktopSettings((current: any) => ({
      ...current,
      aiProfiles: [...current.aiProfiles, profile],
    }));
    setIsCreatingProfile(false);
    setEditingProfileId(null);
  };

  const isDefault = (profileId: string) => defaultAiProfileId === profileId;

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{t("settings.ai.title")}</h3>
        <p className="text-xs text-muted-foreground">{t("settings.ai.description")}</p>
      </div>

      {editingProfileId && editingProfile ? (
        // ── Profile editor ──
        <ProfileEditor
          profile={editingProfile}
          setDraftDesktopSettings={setDraftDesktopSettings}
          onBack={cancelEditing}
          onDelete={() => deleteProfile(editingProfile.id)}
          scopedOsEnv={scopedOsEnv}
          revealedValueIds={revealedValueIds}
          toggleValueVisibility={toggleValueVisibility}
          getProviderField={getProviderField}
          setProviderField={setProviderField}
          osFieldEnvName={osFieldEnvName}
        />
      ) : isCreatingProfile ? (
        // ── New profile form (includes credential fields) ──
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-sm font-medium">{t("settings.ai.newProfile")}</h4>
            <Button size="sm" variant="ghost" onClick={cancelEditing}>
              {t("settings.ai.cancel")}
            </Button>
          </div>

          {/* Profile name */}
          <div className="space-y-1.5">
            <Label className="text-xs">{t("settings.ai.profileName")}</Label>
            <Input
              value={newProfileName}
              onChange={(e) => setNewProfileName(e.target.value)}
              placeholder={t("settings.ai.profileNamePlaceholder")}
            />
          </div>

          {/* Provider selector */}
          <div className="space-y-1.5">
            <Label className="text-xs">{t("settings.ai.providerLabel")}</Label>
            <Select
              value={newProfileProvider}
              onChange={(e) => {
                const provider = e.target.value as AssistantProviderId;
                setNewProfileProvider(provider);
                setNewProfileModel(defaultModelFor(provider));
                setNewProfileFieldValues({});
              }}
            >
              {ASSISTANT_PROVIDER_IDS.map((id) => (
                <option key={id} value={id}>
                  {PROVIDER_LABELS[id]}
                </option>
              ))}
            </Select>
          </div>

          {/* Model selector (only for providers with preset models) */}
          {PROVIDER_MODELS[newProfileProvider].length > 0 ? (
            <div className="space-y-1.5">
              <Label className="text-xs">{t("assistant.model")}</Label>
              <Select
                value={newProfileModel}
                onChange={(e) => setNewProfileModel(e.target.value)}
              >
                {PROVIDER_MODELS[newProfileProvider].map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}

          {/* Secrets note */}
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{t("settings.ai.secretsNote")}</span>
          </div>

          {/* Credential fields for the selected provider */}
          <div className="space-y-4">
            {PROVIDER_FIELDS[newProfileProvider].map((field) => (
              <div key={field.envKey} className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-xs" htmlFor={`new-profile-${field.envKey}`}>
                    {t(field.labelKey)}
                    {field.required ? null : (
                      <span className="ms-1 font-normal text-muted-foreground">
                        {t("settings.ai.optionalMark")}
                      </span>
                    )}
                  </Label>
                  <code className="font-mono text-[11px] text-muted-foreground">
                    {field.envKey}
                  </code>
                </div>
                <Input
                  id={`new-profile-${field.envKey}`}
                  type={field.secret ? "password" : "text"}
                  autoComplete="off"
                  spellCheck={false}
                  value={newProfileFieldValues[field.envKey] ?? ""}
                  onChange={(e) => updateNewFieldValue(field.envKey, e.target.value)}
                  placeholder={t(field.placeholderKey)}
                />
              </div>
            ))}
          </div>

          {/* Help link */}
          {PROVIDER_DOCS_URL[newProfileProvider] ? (
            <a
              className="inline-flex items-center gap-1 text-xs text-primary underline"
              href={PROVIDER_DOCS_URL[newProfileProvider]}
              target="_blank"
              rel="noreferrer noopener"
            >
              <ExternalLink className="h-3 w-3" />
              {t("settings.ai.getCredentials", {
                provider: PROVIDER_LABELS[newProfileProvider],
              })}
            </a>
          ) : null}

          <Button size="sm" onClick={commitNewProfile}>
            {t("settings.ai.saveProfile")}
          </Button>
        </div>
      ) : (
        // ── Profile list ──
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {t("settings.ai.profileCount", { count: draftDesktopSettings.aiProfiles.length })}
            </p>
            <Button size="sm" variant="outline" onClick={startCreating}>
              <Plus className="me-1 h-3.5 w-3.5" />
              {t("settings.ai.addProfile")}
            </Button>
          </div>

          {draftDesktopSettings.aiProfiles.length === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
              {t("settings.ai.noProfiles")}
            </div>
          ) : (
            <div className="space-y-2">
              {draftDesktopSettings.aiProfiles.map((profile) => {
                const isDefaultProfile = isDefault(profile.id);
                return (
                  <div
                    key={profile.id}
                    className={cn(
                      "flex items-center gap-3 rounded-md border p-2.5",
                      isDefaultProfile && "border-primary/40 bg-primary/5",
                    )}
                  >
                    <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-sm font-medium">
                        <span className="truncate">{profile.name}</span>
                        {isDefaultProfile ? (
                          <span className="inline-flex items-center gap-0.5 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                            <Star className="h-3 w-3" />
                            {t("settings.ai.defaultProfile")}
                          </span>
                        ) : null}
                        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {PROVIDER_LABELS[profile.provider]}
                        </span>
                      </div>
                      <p className="truncate text-xs text-muted-foreground">{profile.modelId}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {!isDefaultProfile ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs"
                          onClick={() => setAsDefault(profile.id)}
                        >
                          {t("settings.ai.setDefault")}
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs"
                        onClick={() => editProfile(profile.id)}
                      >
                        {t("settings.ai.edit")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0 text-destructive"
                        onClick={() => deleteProfile(profile.id)}
                        title={t("settings.ai.deleteProfile")}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Profile editor sub-component ──

interface ProfileEditorProps {
  profile: AssistantProfile;
  setDraftDesktopSettings: React.Dispatch<React.SetStateAction<any>>;
  onBack: () => void;
  onDelete: () => void;
  scopedOsEnv: Record<string, string>;
  revealedValueIds: Set<string>;
  toggleValueVisibility: (id: string) => void;
  getProviderField: (field: ProviderField) => string;
  setProviderField: (field: ProviderField, value: string) => void;
  osFieldEnvName: (field: ProviderField) => string | null;
}

function ProfileEditor({
  profile,
  setDraftDesktopSettings,
  onBack,
  onDelete,
  scopedOsEnv,
  revealedValueIds,
  toggleValueVisibility,
  getProviderField,
  setProviderField,
  osFieldEnvName,
}: ProfileEditorProps) {
  const { t } = useTranslation();

  const updateName = (name: string) => {
    setDraftDesktopSettings((current: any) => ({
      ...current,
      aiProfiles: current.aiProfiles.map((p: any) =>
        p.id === profile.id ? { ...p, name } : p,
      ),
    }));
  };

  const updateProvider = (provider: AssistantProviderId) => {
    setDraftDesktopSettings((current: any) => ({
      ...current,
      aiProfiles: current.aiProfiles.map((p: any) =>
        p.id === profile.id
          ? { ...p, provider, modelId: defaultModelFor(provider), fieldValues: {} }
          : p,
      ),
    }));
  };

  const updateModel = (modelId: string) => {
    setDraftDesktopSettings((current: any) => ({
      ...current,
      aiProfiles: current.aiProfiles.map((p: any) =>
        p.id === profile.id ? { ...p, modelId } : p,
      ),
    }));
  };

  const providerFields = PROVIDER_FIELDS[profile.provider];
  const hasOsEnvNote = providerFields.some((field) => osFieldEnvName(field) !== null);
  const models = PROVIDER_MODELS[profile.provider];
  const docsUrl = PROVIDER_DOCS_URL[profile.provider];

  return (
    <div className="space-y-4">
      {/* Header with back/delete */}
      {/* Header — just navigation */}
      <div className="flex items-center justify-between gap-2">
        <Button size="sm" variant="ghost" onClick={onBack} className="gap-1 text-xs">
          {t("settings.ai.backToProfiles")}
        </Button>
      </div>

      {/* Profile name */}
      <div className="space-y-1.5">
        <Label className="text-xs" htmlFor="settings-ai-profile-name">
          {t("settings.ai.profileName")}
        </Label>
        <Input
          id="settings-ai-profile-name"
          value={profile.name}
          onChange={(e) => updateName(e.target.value)}
        />
      </div>

      {/* Provider selector */}
      <div className="space-y-1.5">
        <Label className="text-xs">{t("settings.ai.providerLabel")}</Label>
        <Select
          value={profile.provider}
          onChange={(e) => updateProvider(e.target.value as AssistantProviderId)}
        >
          {ASSISTANT_PROVIDER_IDS.map((id) => (
            <option key={id} value={id}>
              {PROVIDER_LABELS[id]}
            </option>
          ))}
        </Select>
      </div>

      {/* Model selector */}
      {models.length > 0 ? (
        <div className="space-y-1.5">
          <Label className="text-xs">{t("assistant.model")}</Label>
          <Select
            value={profile.modelId || defaultModelFor(profile.provider)}
            onChange={(e) => updateModel(e.target.value)}
          >
            {models.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </Select>
        </div>
      ) : null}

      {/* Secrets note */}
      <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{t("settings.ai.secretsNote")}</span>
      </div>

      {/* OS env note */}
      {hasOsEnvNote ? (
        <div className="flex items-start gap-2 rounded-md border border-sky-500/40 bg-sky-500/10 p-3 text-xs text-sky-700 dark:text-sky-300">
          <Terminal className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t("settings.ai.osEnvNote")}</span>
        </div>
      ) : null}

      {/* Credential fields */}
      <div className="space-y-4">
        {providerFields.map((field) => {
          const revealed = revealedValueIds.has(field.envKey);
          const osEnvName = osFieldEnvName(field);
          const fromOsEnv = getProviderField(field) === "" && osEnvName !== null;
          return (
            <div key={field.envKey} className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label className="text-xs" htmlFor={`settings-ai-${field.envKey}`}>
                  {t(field.labelKey)}
                  {field.required ? null : (
                    <span className="ms-1 font-normal text-muted-foreground">
                      {t("settings.ai.optionalMark")}
                    </span>
                  )}
                </Label>
                <code className="font-mono text-[11px] text-muted-foreground">
                  {field.envKey}
                </code>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  id={`settings-ai-${field.envKey}`}
                  type={field.secret && !revealed ? "password" : "text"}
                  autoComplete="off"
                  spellCheck={false}
                  value={getProviderField(field)}
                  onChange={(event) => setProviderField(field, event.target.value)}
                  placeholder={
                    fromOsEnv
                      ? t("settings.ai.osEnvPlaceholder")
                      : t(field.placeholderKey)
                  }
                />
                {field.secret ? (
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    onClick={() => toggleValueVisibility(field.envKey)}
                    aria-label={
                      revealed
                        ? t("settings.ai.hideValue", { name: t(field.labelKey) })
                        : t("settings.ai.showValue", { name: t(field.labelKey) })
                    }
                  >
                    {revealed ? (
                      <EyeOff className="h-3.5 w-3.5" />
                    ) : (
                      <Eye className="h-3.5 w-3.5" />
                    )}
                  </Button>
                ) : null}
              </div>
              {fromOsEnv ? (
                <p className="flex items-center gap-1.5 text-[11px] text-sky-700 dark:text-sky-300">
                  <Terminal className="h-3 w-3 shrink-0" />
                  <span>
                    {t("settings.ai.osEnvField", { name: osEnvName })}
                  </span>
                </p>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* Help link */}
      {docsUrl ? (
        <a
          className="inline-flex items-center gap-1 text-xs text-primary underline"
          href={docsUrl}
          target="_blank"
          rel="noreferrer noopener"
        >
          <ExternalLink className="h-3 w-3" />
          {t("settings.ai.getCredentials", { provider: PROVIDER_LABELS[profile.provider] })}
        </a>
      ) : null}

      {/* Footer — save and delete */}
      <div className="flex items-center justify-between gap-2 border-t pt-4">
        <Button
          size="sm"
          variant="ghost"
          className="text-xs text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="me-1 h-3.5 w-3.5" />
          {t("settings.ai.deleteProfile")}
        </Button>
        <Button size="sm" onClick={onBack}>
          {t("settings.ai.saveProfile")}
        </Button>
      </div>
    </div>
  );
}

/**
 * Minimal standalone provider config check — mirrors `configForProvider` from
 * provider.ts without importing it (avoids a heavy dependency chain in this
 * component). Returns a truthy value when the provider has its required env
 * fields set.
 */
function providerConfigFromEnv(
  provider: AssistantProviderId,
  env: Record<string, string>,
): unknown {
  switch (provider) {
    case "google":
    case "anthropic":
    case "openai": {
      const names =
        provider === "google"
          ? ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY"]
          : provider === "anthropic"
            ? ["ANTHROPIC_API_KEY"]
            : ["OPENAI_API_KEY"];
      return names.some((n) => env[n]?.trim()) ? { provider } : null;
    }
    case "ollama":
      return env.OLLAMA_BASE_URL?.trim() || env.OLLAMA_HOST?.trim()
        ? { provider }
        : null;
    case "custom":
      return env.OPENAI_COMPATIBLE_BASE_URL?.trim() && env.OPENAI_COMPATIBLE_MODEL?.trim()
        ? { provider }
        : null;
    case "bedrock":
      return env.AWS_ACCESS_KEY_ID?.trim() && env.AWS_SECRET_ACCESS_KEY?.trim()
        ? { provider }
        : null;
    default:
      return null;
  }
}
