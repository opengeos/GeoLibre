/**
 * Hosts a React-rendered panel inside the MapLibre control container.
 *
 * Mounting as a real `IControl` (instead of an absolutely-positioned sibling)
 * buys corner stacking with the built-in controls, automatic RTL mirroring of
 * the control corners, and inclusion in Record Video's on-map panel capture,
 * which rasterizes elements inside the map container.
 */
import type { MapController } from "@geolibre/map";
import type { ControlPosition, IControl } from "maplibre-gl";
import { useEffect, useState, type RefObject } from "react";

/**
 * Create (while `visible`) a control element at `position` on the map, for use
 * as a `createPortal` target.
 *
 * @param mapControllerRef - Live map controller.
 * @param visible - Whether the control should currently exist.
 * @param position - Map corner for the control.
 * @param className - Class list for the host element (include `maplibregl-ctrl`
 *   for standard control margins).
 * @param mapReadyGeneration - Bumped by the shell whenever the map instance is
 *   (re)created, so the control re-attaches to the new map.
 * @returns The mounted host element, or null while hidden / map not ready.
 */
export function useMapPanelControl(
  mapControllerRef: RefObject<MapController | null>,
  visible: boolean,
  position: ControlPosition,
  className: string,
  mapReadyGeneration: number,
): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!visible) {
      setHost(null);
      return;
    }
    const map = mapControllerRef.current?.getMap();
    if (!map) return;
    const element = document.createElement("div");
    element.className = className;
    const control: IControl = {
      onAdd: () => element,
      onRemove: () => {
        element.remove();
      },
    };
    map.addControl(control, position);
    setHost(element);
    return () => {
      setHost(null);
      // The map may already be destroyed during teardown; removal is best-effort.
      try {
        map.removeControl(control);
      } catch {
        element.remove();
      }
    };
  }, [mapControllerRef, visible, position, className, mapReadyGeneration]);

  return host;
}
