import type { IControl, Map as MapLibreMap } from "maplibre-gl";
import type { GeoLibreAppAPI } from "../types";

/**
 * Mount only a MapLibre control's content inside a host-owned dockable panel.
 *
 * The control lifecycle remains an implementation bridge for its map and
 * service logic, but its toolbar button and floating shell are not mounted.
 * Layout, resizing, and close/collapse chrome belong exclusively to GeoLibre.
 */
export function mountMapControlInPanel(
  app: GeoLibreAppAPI,
  control: IControl,
  container: HTMLElement,
): (() => void) | null {
  const map = app.getMap?.();
  if (!map) return null;

  // Most MapLibre controls return their toolbar button from onAdd(), but the
  // Web Services controls append the actual floating panel as a sibling under
  // the map container. Capture those new siblings so the dock receives the
  // real UI instead of only the (hidden) toolbar toggle.
  const mapContainer = map.getContainer();
  const existingMapChildren = new Set(mapContainer.children);
  // Floating controls install a document-level click/pointerdown listener in
  // onAdd() solely to collapse themselves when the map is clicked. A native
  // dock must not inherit that behavior: map clicks and host resize presses do
  // not close dock content. Suppress only those synchronous registrations and
  // immediately restore the platform method after the control mounts.
  const nativeAddEventListener = document.addEventListener;
  document.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (type === "click" || type === "pointerdown") return;
    Reflect.apply(nativeAddEventListener, document, [type, listener, options]);
  }) as typeof document.addEventListener;
  let element: HTMLElement;
  try {
    element = control.onAdd(map as MapLibreMap);
  } finally {
    document.addEventListener = nativeAddEventListener;
  }
  const appendedElements = [...mapContainer.children].filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && !existingMapChildren.has(child) && child !== element,
  );
  const contentElements =
    appendedElements.length > 0
      ? appendedElements
      : [
          element.matches(".vantor-panel")
            ? element
            : element.querySelector<HTMLElement>(".vantor-panel"),
        ].filter((candidate): candidate is HTMLElement => candidate !== null);
  if (contentElements.length === 0) {
    control.onRemove(map as MapLibreMap);
    return null;
  }
  container.classList.add("geolibre-docked-map-control");
  container.replaceChildren(...contentElements);

  return () => {
    control.onRemove(map as MapLibreMap);
    container.replaceChildren();
    container.classList.remove("geolibre-docked-map-control");
  };
}
