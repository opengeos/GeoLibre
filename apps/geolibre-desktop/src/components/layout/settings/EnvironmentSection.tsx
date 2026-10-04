import { isSecretEnvironmentVariable, type RuntimeEnvironmentVariable } from "@geolibre/core";
import { Button, Input, cn } from "@geolibre/ui";
import { Eye, EyeOff, Lock, Plus, Trash2, TriangleAlert, Unlock } from "lucide-react";
import { useMemo, type ComponentType, type ReactElement, type RefObject } from "react";
import { Trans, useTranslation } from "react-i18next";
import { credentialStorageLocation } from "../../../lib/credential-store";
import { projectCredentialsInKeychain } from "../../../lib/project-credentials";
import { supportsShareOAuth, useShareOAuthStore } from "../../../lib/share-oauth";
import { resolveShareHost, shareHostLabel } from "../../../lib/share-geolibre";
import { CredentialStorageNotice } from "../CredentialStorageNotice";
import { ShareAccountSection } from "../ShareAccountSection";
import { createDraftId } from "./settings-draft";
import { useSettingsDraft } from "./SettingsDraftContext";

type TransComponents = Record<string, ReactElement>;

type SettingsTransProps = {
  i18nKey:
    | "settings.env.tokenDescription"
    | "settings.env.cesiumTokenDescription"
    | "settings.env.mapboxTokenDescription"
    | "settings.env.arcgisKeyDescription";
  values?: { shareHost: string };
  components?: TransComponents;
};

// TS 7 exhausts its instantiation depth when it expands Trans's catalog-wide
// generics from this large generated locale type. Keep the key union explicit.
const SettingsTrans = Trans as ComponentType<SettingsTransProps>;

const mapboxTokenComponents: TransComponents = {
  tokenLink: (
    <a
      className="underline"
      href="https://account.mapbox.com/access-tokens/"
      target="_blank"
      rel="noreferrer noopener"
    />
  ),
};

const arcgisKeyComponents: TransComponents = {
  keyLink: (
    <a
      className="underline"
      href="https://developers.arcgis.com/documentation/security-and-authentication/api-key-authentication/"
      target="_blank"
      rel="noreferrer noopener"
    />
  ),
};

const cesiumTokenComponents: TransComponents = {
  tokenLink: (
    <a
      className="underline"
      href="https://ion.cesium.com/tokens"
      target="_blank"
      rel="noreferrer noopener"
    />
  ),
};

interface EnvironmentSectionProps {
  /**
   * The token inputs a deep-link can focus (see `SettingsFocusTarget`). Owned
   * by the dialog shell, which runs the focus once this section renders.
   */
  shareTokenInputRef: RefObject<HTMLInputElement | null>;
  cesiumTokenInputRef: RefObject<HTMLInputElement | null>;
  mapboxTokenInputRef: RefObject<HTMLInputElement | null>;
  arcgisKeyInputRef: RefObject<HTMLInputElement | null>;
}

/**
 * The Environment section: the share account and token, map-service tokens,
 * and the project's environment variables.
 *
 * Args:
 *   props: The section props.
 *
 * Returns:
 *   The section content.
 */
export function EnvironmentSection({
  shareTokenInputRef,
  cesiumTokenInputRef,
  mapboxTokenInputRef,
  arcgisKeyInputRef,
}: EnvironmentSectionProps) {
  const { t } = useTranslation();
  const {
    draftPreferences,
    setDraftPreferences,
    draftDesktopSettings,
    setDraftDesktopSettings,
    setError,
    revealedValueIds,
    toggleValueVisibility,
  } = useSettingsDraft();
  // The share host's settings page, where the API token below is created.
  // Derived from the resolved host so a self-hosted deployment links to its own
  // page; null when the deployment configured no share host, in which case the
  // description renders without a link rather than pointing at a stranger's site.
  const shareHostState = resolveShareHost();
  const shareBaseUrl = shareHostState.baseUrl;
  const shareHost = shareHostLabel();
  const shareSettingsUrl = shareBaseUrl ? `${shareBaseUrl}/settings` : null;
  const keychainStorage = credentialStorageLocation() === "keychain";
  const projectKeychainWritable = projectCredentialsInKeychain();
  const shareTokenComponents: TransComponents = {
    tokenLink: (
      <a
        className="underline"
        href={shareSettingsUrl ?? undefined}
        target="_blank"
        rel="noreferrer noopener"
      />
    ),
  };
  // No usable host (sharing turned off, or a configured address that was
  // rejected) means the token field is dead: it would authenticate against a
  // server this deployment never talks to. Say so instead of rendering guidance
  // that names the public hosted service — the whole point of the opt-out. The
  // two unusable states get different copy: "not configured" would send an
  // operator who typo'd the variable looking for one they never set.
  const shareTokenUsable = shareBaseUrl != null;
  const shareTokenUnavailableMessage =
    shareHostState.status === "invalid"
      ? t("settings.env.tokenHostInvalid")
      : t("settings.env.tokenUnavailable");
  const oauthSetupError = useShareOAuthStore((state) => state.setupError);
  const oauthSupported = supportsShareOAuth();
  const enabledVariableCount = useMemo(
    () =>
      draftPreferences.environmentVariables.filter(
        (variable) => variable.enabled && variable.key.trim(),
      ).length,
    [draftPreferences.environmentVariables],
  );

  const updateShareToken = (value: string) => {
    // Kept in the draft and only committed on Save, so editing the token and
    // then closing the dialog without saving discards the change (a secret
    // field should not persist on every keystroke).
    setDraftDesktopSettings((current) => ({ ...current, shareToken: value }));
  };

  const updateCesiumIonToken = (value: string) => {
    // Draft-only until Save, like the share token above (a secret field should
    // not persist on every keystroke).
    setDraftDesktopSettings((current) => ({ ...current, cesiumIonToken: value }));
  };

  const updateEnvironmentVariable = (index: number, patch: Partial<RuntimeEnvironmentVariable>) => {
    setDraftPreferences((current) => ({
      ...current,
      environmentVariables: current.environmentVariables.map((variable, i) =>
        i === index ? { ...variable, ...patch } : variable,
      ),
    }));
    setError(null);
  };

  const addEnvironmentVariable = () => {
    setDraftPreferences((current) => ({
      ...current,
      environmentVariables: [
        ...current.environmentVariables,
        { id: createDraftId(), key: "", value: "", enabled: true },
      ],
    }));
    setError(null);
  };

  const removeEnvironmentVariable = (index: number) => {
    setDraftPreferences((current) => ({
      ...current,
      environmentVariables: current.environmentVariables.filter((_, i) => i !== index),
    }));
    setError(null);
  };

  return (
    <div className="space-y-5">
      <CredentialStorageNotice />
      {shareTokenUsable && (oauthSupported || oauthSetupError) ? (
        <ShareAccountSection
          shareHost={shareHost}
          hasPersonalToken={draftDesktopSettings.shareToken.trim().length > 0}
        />
      ) : null}
      <div
        className={cn(
          "space-y-2",
          (oauthSupported || oauthSetupError) && shareTokenUsable && "border-t pt-5",
        )}
      >
        <h3 className="text-sm font-semibold">{t("settings.env.tokenTitle")}</h3>
        {shareTokenUsable ? (
          <>
            <p className="text-xs text-muted-foreground">
              <SettingsTrans
                i18nKey="settings.env.tokenDescription"
                values={{ shareHost }}
                // Non-null here: this branch requires shareBaseUrl,
                // which is what shareSettingsUrl is derived from.
                components={shareTokenComponents}
              />
            </p>
            <Input
              ref={shareTokenInputRef}
              aria-label={t("settings.env.tokenTitle")}
              type="password"
              autoComplete="new-password"
              placeholder={t("settings.env.tokenPlaceholder")}
              value={draftDesktopSettings.shareToken}
              onChange={(event) => updateShareToken(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t(
                keychainStorage
                  ? "settings.env.tokenStorageNoteKeychain"
                  : "settings.env.tokenStorageNote",
                { shareHost },
              )}
            </p>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">{shareTokenUnavailableMessage}</p>
        )}
      </div>
      <div className="space-y-2 border-t pt-5">
        <h3 className="text-sm font-semibold">{t("settings.env.cesiumTokenTitle")}</h3>
        <p className="text-xs text-muted-foreground">
          <SettingsTrans
            i18nKey="settings.env.cesiumTokenDescription"
            components={cesiumTokenComponents}
          />
        </p>
        <Input
          ref={cesiumTokenInputRef}
          aria-label={t("settings.env.cesiumTokenTitle")}
          type="password"
          autoComplete="new-password"
          placeholder={t("settings.env.cesiumTokenPlaceholder")}
          value={draftDesktopSettings.cesiumIonToken}
          onChange={(event) => updateCesiumIonToken(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          {t(
            keychainStorage
              ? "settings.env.cesiumTokenStorageNoteKeychain"
              : "settings.env.cesiumTokenStorageNote",
          )}
        </p>
      </div>
      <div className="space-y-2 border-t pt-5">
        <h3 className="text-sm font-semibold">{t("settings.env.mapboxTokenTitle")}</h3>
        <p className="text-xs text-muted-foreground">
          <SettingsTrans
            i18nKey="settings.env.mapboxTokenDescription"
            components={mapboxTokenComponents}
          />
        </p>
        <Input
          ref={mapboxTokenInputRef}
          aria-label={t("settings.env.mapboxTokenTitle")}
          type="password"
          autoComplete="new-password"
          placeholder={t("settings.env.mapboxTokenPlaceholder")}
          value={draftDesktopSettings.mapboxAccessToken}
          onChange={(event) =>
            setDraftDesktopSettings((current) => ({
              ...current,
              mapboxAccessToken: event.target.value,
            }))
          }
        />
        <p className="text-xs text-muted-foreground">
          {t(
            keychainStorage
              ? "settings.env.mapboxTokenStorageNoteKeychain"
              : "settings.env.mapboxTokenStorageNote",
          )}
        </p>
      </div>
      <div className="space-y-2 border-t pt-5">
        <h3 className="text-sm font-semibold">{t("settings.env.arcgisKeyTitle")}</h3>
        <p className="text-xs text-muted-foreground">
          <SettingsTrans
            i18nKey="settings.env.arcgisKeyDescription"
            components={arcgisKeyComponents}
          />
        </p>
        <Input
          ref={arcgisKeyInputRef}
          aria-label={t("settings.env.arcgisKeyTitle")}
          type="password"
          autoComplete="new-password"
          placeholder={t("settings.env.arcgisKeyPlaceholder")}
          value={draftDesktopSettings.arcgisApiKey}
          onChange={(event) =>
            setDraftDesktopSettings((current) => ({
              ...current,
              arcgisApiKey: event.target.value,
            }))
          }
        />
        <p className="text-xs text-muted-foreground">
          {t(
            keychainStorage
              ? "settings.env.arcgisKeyStorageNoteKeychain"
              : "settings.env.arcgisKeyStorageNote",
          )}
        </p>
      </div>
      <div className="flex items-center justify-between gap-3 border-t pt-5">
        <div>
          <h3 className="text-sm font-semibold">{t("settings.env.variablesTitle")}</h3>
          <p className="text-xs text-muted-foreground">
            {t("settings.env.variablesCount", {
              count: enabledVariableCount,
            })}
          </p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={addEnvironmentVariable}>
          <Plus className="h-3.5 w-3.5" />
          {t("common.add")}
        </Button>
      </div>
      <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          {projectKeychainWritable
            ? t("settings.env.secretsWarningKeychain")
            : keychainStorage
              ? t("settings.env.secretsWarningUnavailable")
              : t("settings.env.secretsWarning")}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{t("settings.env.headerReferenceHint")}</p>
      {draftPreferences.environmentVariables.length === 0 ? (
        <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          {t("settings.env.empty")}
        </div>
      ) : (
        <div className="space-y-2">
          {draftPreferences.environmentVariables.map((variable, index) => {
            const variableName = variable.key || t("settings.env.variableFallback");
            const secret = isSecretEnvironmentVariable(variable);
            const secretLabel = secret
              ? t("settings.env.secretOnAria", { name: variableName })
              : t("settings.env.secretOffAria", { name: variableName });
            return (
              <div
                key={variable.id}
                className="grid grid-cols-[1.25rem_minmax(7rem,1fr)_minmax(7rem,1fr)_2rem_2rem_2rem] items-center gap-2"
              >
                <input
                  aria-label={t("settings.env.enableAria", {
                    name: variableName,
                  })}
                  className="h-4 w-4"
                  type="checkbox"
                  checked={variable.enabled}
                  onChange={(event) =>
                    updateEnvironmentVariable(index, {
                      enabled: event.target.checked,
                    })
                  }
                />
                <Input
                  aria-label={t("settings.env.nameAria")}
                  placeholder={t("settings.env.namePlaceholder")}
                  value={variable.key}
                  onChange={(event) =>
                    updateEnvironmentVariable(index, {
                      key: event.target.value,
                    })
                  }
                />
                <Input
                  aria-label={t("settings.env.valueAria")}
                  placeholder={t("settings.env.valuePlaceholder")}
                  type={revealedValueIds.has(variable.id) ? "text" : "password"}
                  autoComplete="off"
                  value={variable.value}
                  onChange={(event) =>
                    updateEnvironmentVariable(index, {
                      value: event.target.value,
                    })
                  }
                />
                <Button
                  aria-label={secretLabel}
                  title={secretLabel}
                  className="h-8 w-8"
                  type="button"
                  size="icon"
                  variant="ghost"
                  onClick={() => updateEnvironmentVariable(index, { secret: !secret })}
                >
                  {secret ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
                </Button>
                <Button
                  aria-label={
                    revealedValueIds.has(variable.id)
                      ? t("settings.env.hideValueAria", {
                          name: variableName,
                        })
                      : t("settings.env.showValueAria", {
                          name: variableName,
                        })
                  }
                  className="h-8 w-8"
                  type="button"
                  size="icon"
                  variant="ghost"
                  onClick={() => toggleValueVisibility(variable.id)}
                >
                  {revealedValueIds.has(variable.id) ? (
                    <EyeOff className="h-3.5 w-3.5" />
                  ) : (
                    <Eye className="h-3.5 w-3.5" />
                  )}
                </Button>
                <Button
                  aria-label={t("settings.env.removeAria", {
                    name: variableName,
                  })}
                  className="h-8 w-8"
                  type="button"
                  size="icon"
                  variant="ghost"
                  onClick={() => removeEnvironmentVariable(index)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
