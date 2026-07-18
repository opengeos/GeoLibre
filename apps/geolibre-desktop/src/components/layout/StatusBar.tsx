import { useEffect, useState } from "react";
import { useAppStore } from "@geolibre/core";
import { cn } from "@geolibre/ui";
import { Bug } from "lucide-react";
import { formatSpeedKmh } from "../../lib/gps-tracking";

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
  const pointerCoords = useAppStore((s) => s.pointerCoords);
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
      : `${gpsCoords} ±${Math.round(gpsStatus.accuracy)} m` +
        (gpsStatus.speed != null ? ` ${formatSpeedKmh(gpsStatus.speed)} km/h` : "") +
        (gpsAgeS >= 10 ? ` (${gpsAgeS}s)` : "")
    : null;

  const coordText = pointerCoords
    ? `${pointerCoords[0].toFixed(5)}, ${pointerCoords[1].toFixed(5)}`
    : "—";

  const bboxText = mapView.bbox ? mapView.bbox.map((n) => n.toFixed(4)).join(", ") : "—";

  return (
    <footer
      className={cn(
        "flex h-7 shrink-0 items-center gap-4 overflow-y-hidden whitespace-nowrap border-t bg-muted/40 px-3 font-mono text-xs text-muted-foreground",
        compact ? "overflow-hidden" : "overflow-x-auto",
      )}
    >
      <span className="shrink-0">
        {compact ? "XY" : "Coords"}: {coordText}
      </span>
      {gpsText && <span className="shrink-0">GPS: {gpsText}</span>}
      <span className="shrink-0">Zoom: {mapView.zoom.toFixed(2)}</span>
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
