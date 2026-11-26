import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useCredentialStorageStatus } from "../../lib/credential-store";

/**
 * An on-map alert shown when saved credentials could not be stored securely.
 *
 * Closing it hides the current failure only: a new failure bumps the store's
 * revision, which shows the warning again.
 */
export function CredentialStorageWarning() {
  const { t } = useTranslation();
  const error = useCredentialStorageStatus((s) => s.error);
  const revision = useCredentialStorageStatus((s) => s.revision);
  const [dismissedRevision, setDismissedRevision] = useState(0);
  if (!error || revision === dismissedRevision) return null;
  return (
    <div
      data-testid="credential-storage-warning"
      role="alert"
      className="absolute bottom-36 start-1/2 z-50 max-w-[min(90vw,36rem)] -translate-x-1/2 rounded-md border border-destructive/40 bg-background px-3 py-2 text-center text-sm text-destructive shadow-lg"
    >
      {t("settings.credentials.unavailable", { error })}
      <button
        type="button"
        onClick={() => setDismissedRevision(revision)}
        className="ms-2 underline underline-offset-2"
      >
        {t("common.close")}
      </button>
    </div>
  );
}
