import { useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";

export function UrlLoadErrorBanner({ message }: { message: string }) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  return (
    <div
      role="alert"
      className="pointer-events-auto flex items-start gap-2 rounded-md border bg-background px-3 py-2 text-sm text-destructive shadow-lg"
    >
      <span className="min-w-0 flex-1 break-words">{message}</span>
      <button
        type="button"
        aria-label={t("common.close")}
        title={t("common.close")}
        onClick={() => setDismissed(true)}
        className="shrink-0 rounded-sm p-1 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
