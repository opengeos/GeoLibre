import { GEOCODING_PROVIDERS, getGeocodingProvider, type ProjectPreferences } from "@geolibre/core";
import { Button, Input, Label, Select } from "@geolibre/ui";
import { Eye, EyeOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { credentialStorageLocation } from "../../../lib/credential-store";
import { projectCredentialsInKeychain } from "../../../lib/project-credentials";
import { CredentialStorageNotice } from "../CredentialStorageNotice";
import { useSettingsDraft } from "./SettingsDraftContext";

/**
 * The Geocoding section: provider, API key and endpoint overrides.
 *
 * Returns:
 *   The section content.
 */
export function GeocodingSection() {
  const { t } = useTranslation();
  const {
    draftPreferences,
    setDraftPreferences,
    setError,
    revealedValueIds,
    toggleValueVisibility,
  } = useSettingsDraft();
  const keychainStorage = credentialStorageLocation() === "keychain";
  const projectKeychainWritable = projectCredentialsInKeychain();

  const updateGeocoding = (patch: Partial<ProjectPreferences["geocoding"]>) => {
    setDraftPreferences((current) => ({
      ...current,
      geocoding: { ...current.geocoding, ...patch },
    }));
    setError(null);
  };

  const updateGeocodingApiKey = (providerId: string, value: string) => {
    setDraftPreferences((current) => ({
      ...current,
      geocoding: {
        ...current.geocoding,
        apiKeys: { ...current.geocoding.apiKeys, [providerId]: value },
      },
    }));
    setError(null);
  };

  return (
    <div className="space-y-5">
      <CredentialStorageNotice />
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{t("settings.geocoding.title")}</h3>
        <p className="text-xs text-muted-foreground">{t("settings.geocoding.description")}</p>
      </div>
      {(() => {
        const provider = getGeocodingProvider(draftPreferences.geocoding.providerId);
        const apiKeyId = `geocoding-api-key-${provider.id}`;
        const apiKeyRevealed = revealedValueIds.has(apiKeyId);
        return (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="geocoding-provider">
                {t("settings.geocoding.provider")}
              </Label>
              <Select
                id="geocoding-provider"
                value={provider.id}
                onChange={(event) =>
                  updateGeocoding({
                    providerId: event.target.value,
                  })
                }
              >
                {GEOCODING_PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">
                {provider.requiresApiKey
                  ? t("settings.geocoding.requiresKey")
                  : provider.acceptsApiKey
                    ? t("settings.geocoding.optionalKey")
                    : t("settings.geocoding.noKey")}
              </p>
              {provider.browserCorsRestricted ? (
                <p className="text-xs text-amber-600 dark:text-amber-500">
                  {t("settings.geocoding.corsNote")}
                </p>
              ) : null}
            </div>

            {provider.acceptsApiKey ? (
              <div className="space-y-1.5">
                <Label className="text-xs" htmlFor="geocoding-key">
                  {t("settings.geocoding.apiKey")}
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="geocoding-key"
                    type={apiKeyRevealed ? "text" : "password"}
                    autoComplete="off"
                    spellCheck={false}
                    value={draftPreferences.geocoding.apiKeys[provider.id] ?? ""}
                    onChange={(event) => updateGeocodingApiKey(provider.id, event.target.value)}
                    placeholder={t("settings.geocoding.apiKeyPlaceholder")}
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    onClick={() => toggleValueVisibility(apiKeyId)}
                    aria-label={t("settings.geocoding.toggleApiKey")}
                  >
                    {apiKeyRevealed ? (
                      <EyeOff className="h-3.5 w-3.5" />
                    ) : (
                      <Eye className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
                <p className="text-xs text-amber-600 dark:text-amber-500">
                  {projectKeychainWritable
                    ? t("settings.geocoding.secretsWarningKeychain")
                    : keychainStorage
                      ? t("settings.geocoding.secretsWarningUnavailable")
                      : t("settings.geocoding.secretsWarning")}
                </p>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="geocoding-forward">
                {t("settings.geocoding.forwardEndpoint")}
              </Label>
              <Input
                id="geocoding-forward"
                value={draftPreferences.geocoding.forwardEndpoint ?? ""}
                onChange={(event) =>
                  updateGeocoding({
                    forwardEndpoint: event.target.value,
                  })
                }
                placeholder={provider.defaultForwardEndpoint}
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="geocoding-reverse">
                {t("settings.geocoding.reverseEndpoint")}
              </Label>
              <Input
                id="geocoding-reverse"
                value={draftPreferences.geocoding.reverseEndpoint ?? ""}
                onChange={(event) =>
                  updateGeocoding({
                    reverseEndpoint: event.target.value,
                  })
                }
                placeholder={provider.defaultReverseEndpoint}
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="geocoding-email">
                {t("settings.geocoding.email")}
              </Label>
              <Input
                id="geocoding-email"
                type="email"
                value={draftPreferences.geocoding.email ?? ""}
                onChange={(event) => updateGeocoding({ email: event.target.value })}
                placeholder={t("settings.geocoding.emailPlaceholder")}
              />
              <p className="text-xs text-muted-foreground">{t("settings.geocoding.emailHint")}</p>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
