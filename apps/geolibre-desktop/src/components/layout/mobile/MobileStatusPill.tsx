import { useAppStore } from "@geolibre/core";
import { cn } from "@geolibre/ui";
import { Bug, Navigation } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  createProjectedReadout,
  formatCoordinate,
  nextCoordinateFormat,
  normalizeCoordinateEpsgCode,
  normalizeCoordinateFormat,
  type ProjectedReadout,
} from "../../../lib/coordinate-format";
import { formatAccuracy } from "../../../lib/gps-tracking";

export interface MobileStatusPillProps {
  diagnosticsErrorCount: number;
  diagnosticsWarningCount: number;
  onOpenDiagnostics: () => void;
}

/**
 * Compact bottom status strip replacing the full desktop StatusBar on phone
 * touch screens (GeoLibre#3537).
 *
 * Rendered in flow directly beneath the map canvas (above {@link MobileBottomNav})
 * so it never overlaps top-left map widgets, scale bars, or toasts. Shows either
 * the live GPS fix (when tracking) or the map center coordinate (since touch
 * screens have no hovering pointer). Tapping the coordinate cycles
 * DD → DMS → DDM → UTM → MGRS → USNG → EPSG just like desktop StatusBar.
 */
export function MobileStatusPill({
  diagnosticsErrorCount,
  diagnosticsWarningCount,
  onOpenDiagnostics,
}: MobileStatusPillProps) {
  const { t } = useTranslation();
  const mapView = useAppStore((s) => s.mapView);
  const gpsStatus = useAppStore((s) => s.gpsStatus);
  const coordinateFormat = normalizeCoordinateFormat(
    useAppStore((s) => s.preferences.map.coordinateFormat),
  );
  const coordinateEpsgCode = normalizeCoordinateEpsgCode(
    useAppStore((s) => s.preferences.map.coordinateEpsgCode),
  );
  const setPreferences = useAppStore((s) => s.setPreferences);

  const [projected, setProjected] = useState<ProjectedReadout | null>(null);
  useEffect(() => {
    if (coordinateFormat !== "epsg") return;
    let cancelled = false;
    void createProjectedReadout(coordinateEpsgCode).then((readout) => {
      if (!cancelled) setProjected(readout);
    });
    return () => {
      cancelled = true;
    };
  }, [coordinateFormat, coordinateEpsgCode]);

  const cycleCoordinateFormat = () => {
    const current = useAppStore.getState().preferences;
    const next = nextCoordinateFormat(normalizeCoordinateFormat(current.map.coordinateFormat));
    setPreferences({ ...current, map: { ...current.map, coordinateFormat: next } });
  };

  const displayLng = gpsStatus ? gpsStatus.lng : mapView.center[0];
  const displayLat = gpsStatus ? gpsStatus.lat : mapView.center[1];
  const coordText = formatCoordinate(displayLng, displayLat, coordinateFormat, {
    projected: projected?.code === coordinateEpsgCode ? projected : null,
  });

  const diagnosticsCount = diagnosticsErrorCount + diagnosticsWarningCount;

  return (
    <div
      data-testid="mobile-status-pill"
      className="flex h-7 shrink-0 items-center justify-between gap-2 border-t bg-muted/40 px-3 font-mono text-[11px] text-muted-foreground"
    >
      <button
        type="button"
        onClick={cycleCoordinateFormat}
        title={t("statusBar.coordinateFormatHint", {
          format: t(`statusBar.coordinateFormat.${coordinateFormat}`, {
            code: coordinateEpsgCode,
          }),
        })}
        className="inline-flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-foreground hover:bg-accent active:bg-accent"
      >
        {gpsStatus ? (
          <Navigation className="h-3 w-3 shrink-0 text-emerald-500" aria-hidden="true" />
        ) : null}
        <span className="truncate">
          {gpsStatus
            ? `${t("mobileShell.status.gpsLabel")}: ${coordText} ±${formatAccuracy(gpsStatus.accuracy, t("gps.notAvailable"))}`
            : coordText}
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-2">
        <span>
          {t("statusBar.zoom")}: {mapView.zoom.toFixed(1)}
        </span>
        {diagnosticsCount > 0 ? (
          <button
            type="button"
            onClick={onOpenDiagnostics}
            aria-label={t("mobileShell.status.diagnosticsLabel", { count: diagnosticsCount })}
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium hover:bg-accent active:bg-accent",
              diagnosticsErrorCount > 0
                ? "text-red-700 dark:text-red-300"
                : "text-amber-700 dark:text-amber-300",
            )}
          >
            <Bug className="h-3 w-3" aria-hidden="true" />
            <span>{diagnosticsCount}</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
