import { useAppStore } from "@geolibre/core";
import { Lock } from "lucide-react";
import { useTranslation } from "react-i18next";

/**
 * Subtle corner badge that appears on the map only while the project's
 * "Restrict map bounds" preference is enabled. It gives users a visible cue
 * that panning/zooming is intentionally constrained (rather than the app being
 * frozen), with a tooltip pointing them back to Settings to change it.
 *
 * Anchored to the bottom-left corner: the top-left corner is where most map
 * control plugins (GeoEditor, Basemaps, NASA Earthdata, ...) cluster, so a
 * top-left badge overlapped and hid the first plugin button. The small
 * bottom offset keeps it clear of the bottom-left scale control when that is
 * enabled. The other bottom-left occupant, the collaboration status badge
 * (CollaborationStatusBadge), already accounts for this badge: it lifts itself
 * to `bottom-20` (above this `bottom-12`) when a session is active and bounds
 * are restricted. If yet another bottom-left control is added, revisit both.
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
      className="pointer-events-auto absolute bottom-12 left-2 z-10 flex items-center gap-1 rounded-md border bg-background/90 px-2 py-1 text-xs font-medium text-foreground shadow-sm backdrop-blur-sm"
      role="status"
      title={tooltip}
      data-testid="bounds-restriction-indicator"
    >
      <Lock
        className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400"
        aria-hidden="true"
      />
      <span>{t("map.boundsRestricted")}</span>
      {/* Full description for assistive tech; the live region announces this
          along with the visible label, while sighted users get it via title. */}
      <span className="sr-only">{tooltip}</span>
    </div>
  );
}
