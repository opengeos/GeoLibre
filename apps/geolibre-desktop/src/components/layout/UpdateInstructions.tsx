import { useTranslation } from "react-i18next";

const STEP_KEYS = [
  "updates.steps.download",
  "updates.steps.install",
  "updates.steps.reopen",
] as const;

/**
 * Step-by-step guidance for installing a GeoLibre update without losing local
 * projects, settings, or API keys. Shared by the About dialog and the startup
 * update prompt so both surfaces stay in sync.
 */
export function UpdateInstructions() {
  const { t } = useTranslation();
  return (
    <ol className="space-y-1.5 text-xs text-muted-foreground">
      {STEP_KEYS.map((key, index) => (
        <li key={key} className="flex gap-2">
          <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-foreground">
            {index + 1}
          </span>
          <span className="text-foreground/80">{t(key)}</span>
        </li>
      ))}
    </ol>
  );
}
