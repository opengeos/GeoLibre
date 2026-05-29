import { useAppStore } from "@geolibre/core";

export function StatusBar() {
  const pointerCoords = useAppStore((s) => s.pointerCoords);
  const mapView = useAppStore((s) => s.mapView);

  const coordText = pointerCoords
    ? `${pointerCoords[0].toFixed(5)}, ${pointerCoords[1].toFixed(5)}`
    : "—";

  const bboxText = mapView.bbox
    ? mapView.bbox.map((n) => n.toFixed(4)).join(", ")
    : "—";

  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 overflow-x-auto border-t bg-muted/40 px-3 font-mono text-xs text-muted-foreground">
      <span>Coords: {coordText}</span>
      <span className="whitespace-nowrap">Zoom: {mapView.zoom.toFixed(2)}</span>
      <span className="whitespace-nowrap">
        Bearing: {mapView.bearing.toFixed(1)}°
      </span>
      <span className="whitespace-nowrap">
        Pitch: {mapView.pitch.toFixed(1)}°
      </span>
      <span className="truncate">BBox: {bboxText}</span>
    </footer>
  );
}
