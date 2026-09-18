import { useEffect, useState } from "react";
import {
  FEET_PER_METER,
  formatCameraAltitude,
  useAppStore,
  type MapScaleUnit,
} from "@geolibre/core";
import {
  formatCoordinate,
  nextCoordinateFormat,
  normalizeCoordinateFormat,
} from "../../lib/coordinate-format";
import { cn } from "@geolibre/ui";
import { Bug } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatAccuracy, formatSpeedKmh } from "../../lib/gps-tracking";

/**
 * Ground elevation for the readout, in the scale bar's unit family: feet for
 * imperial, metres otherwise (nautical miles are a horizontal unit only, so
 * nautical falls through to metres). Rounded to the metre/foot because neither
 * source — terrain tiles or Open-Meteo — is meaningfully precise beyond that.
 * Matches the Measure tool's terrain rows so the two never disagree.
 */
export function formatPointerElevation(meters: number, unit: MapScaleUnit): string {
  return unit === "imperial"
    ? `${Math.round(meters * FEET_PER_METER).toLocaleString()} ft`
    : `${Math.round(meters).toLocaleString()} m`;
}

interface StatusBarProps {
  compact?: boolean;
  diagnosticsErrorCount: number;
  diagnosticsWarningCount: number;
  onOpenDiagnostics: () => void;
}

export function StatusBar({
  compact = false,
  diagnosticsErrorCount,
  diagnosticsWarningCount,
  onOpenDiagnostics,
}: StatusBarProps) {
  const { t } = useTranslation();
  const pointerCoords = useAppStore((s) => s.pointerCoords);
  const pointerElevation = useAppStore((s) => s.pointerElevation);
  const cameraAltitude = useAppStore((s) => s.cameraAltitude);
  const scaleUnit = useAppStore((s) => s.preferences.map.scaleUnit);
  const coordinateFormat = normalizeCoordinateFormat(
    useAppStore((s) => s.preferences.map.coordinateFormat),
  );
  const setPreferences = useAppStore((s) => s.setPreferences);
  const gpsStatus = useAppStore((s) => s.gpsStatus);
  const mapView = useAppStore((s) => s.mapView);
  const diagnosticsCount = diagnosticsErrorCount + diagnosticsWarningCount;

  // Re-render every few seconds while a GPS fix is shown so its age stays live.
  const [, setGpsTick] = useState(0);
  const gpsActive = gpsStatus != null;
  useEffect(() => {
    if (!gpsActive) return;
    const id = setInterval(() => setGpsTick((n) => n + 1), 5000);
    return () => clearInterval(id);
  }, [gpsActive]);

  const gpsAgeS = gpsStatus
    ? Math.max(0, Math.round((Date.now() - gpsStatus.timestamp) / 1000))
    : 0;
  const gpsCoords = gpsStatus ? `${gpsStatus.lng.toFixed(5)}, ${gpsStatus.lat.toFixed(5)}` : null;
  // Compact status bars get coordinates only; the full form matches the GPS
  // dialog's readout formatting (space before the units).
  const gpsText = gpsStatus
    ? compact
      ? gpsCoords
      : `${gpsCoords} ±${formatAccuracy(gpsStatus.accuracy, t("gps.notAvailable"))}` +
        ` ${t("gps.satellitesShortValue", {
          value: gpsStatus.satellites ?? t("gps.notAvailable"),
        })}` +
        (gpsStatus.speed != null ? ` ${formatSpeedKmh(gpsStatus.speed)} km/h` : "") +
        (gpsAgeS >= 10 ? ` (${gpsAgeS}s)` : "")
    : null;

  const coordText = pointerCoords
    ? formatCoordinate(pointerCoords[0], pointerCoords[1], coordinateFormat)
    : "—";

  // Only shown once a value resolves: an "Elev: —" that is empty most of the
  // time (terrain off, mid-lookup, off-Earth) would read as broken rather than
  // as "not applicable here".
  const elevationText =
    pointerElevation !== null ? formatPointerElevation(pointerElevation, scaleUnit) : null;
  // Clicking the readout cycles DD -> DMS -> DDM -> UTM. The same choice lives
  // in Settings; this is the shortcut for someone switching notations while
  // reading a map, which is when it actually comes up. Read live state at click
  // time so a concurrent preference change is not clobbered.
  const cycleCoordinateFormat = () => {
    const current = useAppStore.getState().preferences;
    const next = nextCoordinateFormat(normalizeCoordinateFormat(current.map.coordinateFormat));
    setPreferences({ ...current, map: { ...current.map, coordinateFormat: next } });
  };

  // Google Earth Pro's "Eye alt": how high the camera is, as opposed to how
  // high the ground under the cursor is. Sits beside Zoom because it answers
  // the same question in a unit a person can actually reason about.
  const altitudeText =
    cameraAltitude !== null ? formatCameraAltitude(cameraAltitude, scaleUnit) : null;

  const bboxText = mapView.bbox ? mapView.bbox.map((n) => n.toFixed(4)).join(", ") : "—";

  return (
    <footer
      className={cn(
        "flex h-7 shrink-0 items-center gap-4 overflow-y-hidden whitespace-nowrap border-t bg-muted/40 px-3 font-mono text-xs text-muted-foreground",
        compact ? "overflow-hidden" : "overflow-x-auto",
      )}
    >
      <button
        type="button"
        className="shrink-0 rounded px-1 hover:bg-accent hover:text-accent-foreground"
        onClick={cycleCoordinateFormat}
        title={t("statusBar.coordinateFormatHint", {
          format: t(`statusBar.coordinateFormat.${coordinateFormat}`),
        })}
      >
        {compact ? "XY" : "Coords"}: {coordText}
      </button>
      {elevationText && (
        <span className="shrink-0" title={t("statusBar.elevationLong")}>
          {t("statusBar.elevation")}: {elevationText}
        </span>
      )}
      {gpsText && <span className="shrink-0">GPS: {gpsText}</span>}
      <span className="shrink-0">Zoom: {mapView.zoom.toFixed(2)}</span>
      {altitudeText && (
        <span className="shrink-0" title={t("statusBar.cameraAltitudeLong")}>
          {t("statusBar.cameraAltitude")}: {altitudeText}
        </span>
      )}
      <span className="shrink-0">Bearing: {mapView.bearing.toFixed(1)}°</span>
      <span className="shrink-0">Pitch: {mapView.pitch.toFixed(1)}°</span>
      {compact ? null : <span className="min-w-0 flex-1 truncate">BBox: {bboxText}</span>}
      <button
        type="button"
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent hover:text-accent-foreground",
          "ms-auto",
          diagnosticsErrorCount > 0 && "text-red-700 dark:text-red-300",
          diagnosticsErrorCount === 0 &&
            diagnosticsWarningCount > 0 &&
            "text-amber-700 dark:text-amber-300",
        )}
        onClick={onOpenDiagnostics}
      >
        <Bug className="h-3 w-3" />
        {compact ? "Diag" : "Diagnostics"}: {diagnosticsCount}
      </button>
    </footer>
  );
}
