import { useAppStore } from "@geolibre/core";
import { cn } from "@geolibre/ui";
import { Bug } from "lucide-react";

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
  const mapView = useAppStore((s) => s.mapView);
  const diagnosticsCount = diagnosticsErrorCount + diagnosticsWarningCount;

  const coordText = pointerCoords
    ? `${pointerCoords[0].toFixed(5)}, ${pointerCoords[1].toFixed(5)}`
    : "—";

  const bboxText = mapView.bbox
    ? mapView.bbox.map((n) => n.toFixed(4)).join(", ")
    : "—";

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
      <span className="shrink-0">Zoom: {mapView.zoom.toFixed(2)}</span>
      <span className="shrink-0">
        Bearing: {mapView.bearing.toFixed(1)}°
      </span>
      <span className="shrink-0">Pitch: {mapView.pitch.toFixed(1)}°</span>
      {compact ? null : (
        <span className="min-w-0 flex-1 truncate">BBox: {bboxText}</span>
      )}
      <button
        type="button"
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent hover:text-accent-foreground",
          "ml-auto",
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
