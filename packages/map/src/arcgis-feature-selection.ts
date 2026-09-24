import { CAMERA_HANDLERS, type CameraHandlerName } from "./feature-selection";
import type { FeatureSelectionMap } from "./map-feature-selection";
import type { ArcgisView, ArcgisViewEvent } from "./arcgis-sdk";
import type { MapEngine } from "./map-engine";

type SelectionListener = Parameters<FeatureSelectionMap["on"]>[1];

/** The DOM pointer event each MapLibre press/drag event is read from. */
const DOM_EVENTS: Record<string, "pointerdown" | "pointermove" | "pointerup"> = {
  mousedown: "pointerdown",
  mousemove: "pointermove",
  mouseup: "pointerup",
};

/**
 * The slice of a MapLibre map the shared selection gestures drive
 * ({@link attachFeatureSelection}), over an ArcGIS view.
 *
 * Clicks come from the view's own `click` / `double-click` events, which the
 * SDK suppresses after a drag, so panning between picks does not select.
 * Presses and drags are read from the container's pointer events, in the
 * container's pixels. Every camera handler a gesture suspends shares one
 * {@link MapEngine.suspendNavigation} call; the view has no box zoom to
 * suspend.
 *
 * @param engine - The ArcGIS engine, for its render surface and navigation.
 * @param view - The view whose container the gestures run in.
 * @returns A map-like object for `attachFeatureSelection`.
 */
export function arcgisFeatureSelectionMap(
  engine: MapEngine,
  view: ArcgisView,
): FeatureSelectionMap {
  const container = view.container as HTMLElement;
  let disabled = 0;
  let resume: (() => void) | null = null;
  const handler = () => {
    let enabled = true;
    return {
      isEnabled: () => enabled,
      disable() {
        if (!enabled) return;
        enabled = false;
        if (disabled++ === 0) resume = engine.suspendNavigation();
      },
      enable() {
        if (enabled) return;
        enabled = true;
        if (--disabled === 0) {
          resume?.();
          resume = null;
        }
      },
    };
  };
  const inert = { isEnabled: () => false, disable() {}, enable() {} };
  const handlers = Object.fromEntries(
    CAMERA_HANDLERS.map((name) => [name, name === "boxZoom" ? inert : handler()]),
  ) as Record<CameraHandlerName, ReturnType<typeof handler>>;

  const removers = new Map<string, Map<SelectionListener, () => void>>();
  const containerPoint = (event: MouseEvent) => {
    const rect = container.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  return {
    ...handlers,
    getCanvas: () => engine.getRenderSurface()?.getCanvas() ?? (container as HTMLCanvasElement),
    getContainer: () => container,
    unproject: ([x, y]) => {
      const point = view.toMap({ x, y });
      return point ? { lng: point.longitude, lat: point.latitude } : { lng: NaN, lat: NaN };
    },
    on(type, listener) {
      let remove: () => void;
      const domType = DOM_EVENTS[type];
      if (domType) {
        const onPointer = (event: PointerEvent) =>
          listener({
            point: containerPoint(event),
            originalEvent: event,
            preventDefault: () => event.preventDefault(),
          });
        container.addEventListener(domType, onPointer);
        remove = () => container.removeEventListener(domType, onPointer);
      } else if (type === "click" || type === "dblclick") {
        const handle = view.on(type === "click" ? "click" : "double-click", (event) => {
          const viewEvent = event as ArcgisViewEvent;
          listener({
            point: { x: viewEvent.x, y: viewEvent.y },
            // The gestures read only the modifier keys from it.
            originalEvent:
              (viewEvent.native as MouseEvent | undefined) ??
              ({ shiftKey: false, altKey: false } as MouseEvent),
            // A handled double click must not also zoom the view.
            preventDefault: () => viewEvent.stopPropagation(),
          });
        });
        remove = () => handle.remove();
      } else return;
      const byListener = removers.get(type) ?? new Map<SelectionListener, () => void>();
      byListener.set(listener, remove);
      removers.set(type, byListener);
    },
    off(type, listener) {
      removers.get(type)?.get(listener)?.();
      removers.get(type)?.delete(listener);
    },
  };
}
