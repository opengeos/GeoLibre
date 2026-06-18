import { useAppStore } from "@geolibre/core";
import { Lock } from "lucide-react";
import { useTranslation } from "react-i18next";

/**
 * Subtle corner badge that appears on the map only while the project's
 * "Restrict map bounds" preference is enabled. It gives users a visible cue
 * that panning/zooming is intentionally constrained (rather than the app being
 * frozen), with a tooltip pointing them back to Settings to change it.
 */
export function BoundsRestrictionIndicator() {
  const { t } = useTranslation();
  const restrictBounds = useAppStore((s) => s.preferences.map.restrictBounds);

  if (!restrictBounds) {
    return null;
  }

  const tooltip = t("map.boundsRestrictedTooltip");

  return (
    <div
      className="pointer-events-auto absolute left-2 top-2 z-10 flex items-center gap-1 rounded-md border bg-background/90 px-2 py-1 text-xs font-medium text-foreground shadow-sm backdrop-blur-sm"
      role="status"
      aria-label={tooltip}
      title={tooltip}
      data-testid="bounds-restriction-indicator"
    >
      <Lock
        className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400"
        aria-hidden="true"
      />
      <span>{t("map.boundsRestricted")}</span>
    </div>
  );
}
