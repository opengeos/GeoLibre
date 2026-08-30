import type { IControl, Map as MapLibreMap } from "maplibre-gl";
import type { GeoLibreAppAPI } from "../types";

/**
 * Mount a MapLibre control's existing DOM inside a host-owned dockable panel.
 *
 * Calling the control lifecycle directly preserves the third-party control's
 * map integration while leaving layout, resizing, and close/collapse chrome to
 * GeoLibre's panel host instead of MapLibre's floating control corners.
 */
export function mountMapControlInPanel(
  app: GeoLibreAppAPI,
  control: IControl,
  container: HTMLElement,
): (() => void) | null {
  const map = app.getMap?.();
  if (!map) return null;

  const element = control.onAdd(map as MapLibreMap);
  container.classList.add("geolibre-docked-map-control");
  container.replaceChildren(element);

  return () => {
    control.onRemove(map as MapLibreMap);
    container.replaceChildren();
    container.classList.remove("geolibre-docked-map-control");
  };
}
