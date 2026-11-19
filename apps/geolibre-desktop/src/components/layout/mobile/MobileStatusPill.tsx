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
  /** Hidden while a bottom sheet covers the lower map edge. */
  hidden?: boolean;
  diagnosticsErrorCount: number;
  diagnosticsWarningCount: number;
  onOpenDiagnostics: () => void;
}

/**
 * Compact floating status pill replacing the 28px desktop StatusBar on phone
 * touch screens (GeoLibre#3537).
 *
 * Shows either the live GPS fix (when tracking) or the map center coordinate
 * (since touchscreens have no hovering pointer). Tapping the coordinate pill
 * cycles DD → DMS → DDM → UTM → MGRS → USNG → EPSG just like desktop StatusBar.
 */
export function MobileStatusPill({
  hidden = false,
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

  if (hidden) return null;

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
      className="pointer-events-none absolute top-2.5 start-2.5 end-16 z-10 flex items-center gap-1.5"
    >
      <button
        type="button"
        onClick={cycleCoordinateFormat}
        title={t("statusBar.coordinateFormatHint", {
          format: t(`statusBar.coordinateFormat.${coordinateFormat}`, {
            code: coordinateEpsgCode,
          }),
        })}
        className="pointer-events-auto inline-flex min-h-9 max-w-[75%] items-center gap-1.5 rounded-full border map-glass px-3 py-1 font-mono text-[11px] text-foreground shadow-sm active:bg-accent"
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
      {diagnosticsCount > 0 ? (
        <button
          type="button"
          onClick={onOpenDiagnostics}
          aria-label={t("mobileShell.status.diagnosticsLabel", { count: diagnosticsCount })}
          className={cn(
            "pointer-events-auto inline-flex min-h-9 shrink-0 items-center gap-1 rounded-full border map-glass px-2.5 py-1 font-mono text-[11px] font-medium shadow-sm active:bg-accent",
            diagnosticsErrorCount > 0
              ? "text-red-700 dark:text-red-300"
              : "text-amber-700 dark:text-amber-300",
          )}
        >
          <Bug className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{diagnosticsCount}</span>
        </button>
      ) : null}
    </div>
  );
}
