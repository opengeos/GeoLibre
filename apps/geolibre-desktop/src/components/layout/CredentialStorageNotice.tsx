import { useTranslation } from "react-i18next";
import { credentialStorageLocation, useCredentialStorageStatus } from "../../lib/credential-store";
import { projectCredentialsInKeychain } from "../../lib/project-credentials";

/** Says where saved tokens and API keys live, and whether that store failed this session. */
export function CredentialStorageNotice() {
  const { t } = useTranslation();
  const error = useCredentialStorageStatus((s) => s.error);
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">
        {t(
          credentialStorageLocation() !== "keychain"
            ? "settings.credentials.browser"
            : projectCredentialsInKeychain()
              ? "settings.credentials.keychain"
              : "settings.credentials.projectKeychainUnavailable",
        )}
      </p>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {t("settings.credentials.unavailable", { error })}
        </p>
      ) : null}
    </div>
  );
}
