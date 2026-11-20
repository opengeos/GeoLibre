import { useAppStore } from "@geolibre/core";
import { cn } from "@geolibre/ui";
import { Navigation, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatAccuracy, formatSpeedKmh } from "../../../lib/gps-tracking";

export interface MobileGpsHudProps {
  keepAwake: boolean;
  wakeLockSupported: boolean;
  onToggleKeepAwake: () => void;
}

/**
 * Compact live GPS HUD pill displayed near the top-center of the map while GPS
 * tracking is active in Touch UI mode (GeoLibre#3537 Phase 4). Shows live
 * accuracy, optional speed, and a 1-tap Screen Wake Lock toggle.
 */
export function MobileGpsHud({
  keepAwake,
  wakeLockSupported,
  onToggleKeepAwake,
}: MobileGpsHudProps) {
  const { t } = useTranslation();
  const gpsStatus = useAppStore((s) => s.gpsStatus);

  if (!gpsStatus) return null;

  const accuracy = formatAccuracy(gpsStatus.accuracy, t("gps.notAvailable"));
  const speed =
    gpsStatus.speed != null && gpsStatus.speed > 0.3 ? formatSpeedKmh(gpsStatus.speed) : null;

  return (
    <div
      data-testid="mobile-gps-hud"
      className="pointer-events-auto absolute top-2.5 start-1/2 z-10 flex max-w-[calc(100%-7.5rem)] -translate-x-1/2 items-center gap-1.5 rounded-full border map-glass px-3 py-1 font-mono text-xs text-foreground shadow-md rtl:translate-x-1/2"
    >
      <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden="true">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
      </span>
      <Navigation className="h-3.5 w-3.5 shrink-0 text-emerald-500" aria-hidden="true" />
      <span className="truncate">
        ±{accuracy}
        {speed ? ` · ${speed}` : ""}
      </span>
      {wakeLockSupported ? (
        <button
          type="button"
          aria-pressed={keepAwake}
          title={t("mobileShell.field.keepScreenAwake")}
          aria-label={t("mobileShell.field.keepScreenAwake")}
          onClick={onToggleKeepAwake}
          className={cn(
            "ms-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors",
            keepAwake
              ? "bg-primary/15 text-primary"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          <Sun className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
