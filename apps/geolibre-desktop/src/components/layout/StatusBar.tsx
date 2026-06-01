import { useAppStore } from "@geolibre/core";
import { cn } from "@geolibre/ui";

interface StatusBarProps {
  compact?: boolean;
}

export function StatusBar({ compact = false }: StatusBarProps) {
  const pointerCoords = useAppStore((s) => s.pointerCoords);
  const mapView = useAppStore((s) => s.mapView);

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
      {compact ? null : <span className="min-w-0 truncate">BBox: {bboxText}</span>}
    </footer>
  );
}
