import type { IControl, Map as MapLibreMap } from "maplibre-gl";
import type { GeoLibreAppAPI } from "../types";

const mountedControlCleanup = new WeakMap<IControl, () => void>();

/** Synchronously unmount a bridged control if its docked panel is mounted. */
export function unmountMapControlFromPanel(control: IControl): void {
  mountedControlCleanup.get(control)?.();
}

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
  onMountFailure?: () => void,
): (() => void) | null {
  const map = app.getMap?.();
  if (!map) {
    console.warn("Could not mount docked map control: the map is not ready.");
    onMountFailure?.();
    return null;
  }

  // Most MapLibre controls return their toolbar button from onAdd(), but the
  // Web Services controls append the actual floating panel as a sibling under
  // the map container. Capture those new siblings so the dock receives the
  // real UI instead of only the (hidden) toolbar toggle.
  const mapContainer = map.getContainer();
  const existingMapChildren = new Set(mapContainer.children);
  const element = control.onAdd(map as MapLibreMap);
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
    console.warn("Could not mount docked map control: no panel content was created.");
    control.onRemove(map as MapLibreMap);
    onMountFailure?.();
    return null;
  }
  container.classList.add("geolibre-docked-map-control");
  container.replaceChildren(...contentElements);

  let removed = false;
  const cleanup = () => {
    if (removed) return;
    removed = true;
    if (mountedControlCleanup.get(control) === cleanup) mountedControlCleanup.delete(control);
    map.off("remove", cleanup);
    control.onRemove(map as MapLibreMap);
    container.replaceChildren();
    container.classList.remove("geolibre-docked-map-control");
  };
  // Unlike a floating control this bridge is not in MapLibre's internal
  // control list, so explicitly participate in map teardown as well as panel
  // teardown. The idempotent cleanup handles either ordering.
  map.on("remove", cleanup);
  mountedControlCleanup.set(control, cleanup);
  return cleanup;
}
