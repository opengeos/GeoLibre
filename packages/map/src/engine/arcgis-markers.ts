import type {
  LngLat,
  MapMarkerEventMap,
  MapMarkerHandle,
  MapMarkerOptions,
  ScreenPoint,
  Unsubscribe,
} from "./types";

export interface ArcGISMarkerView {
  readonly container: HTMLElement | null;
  toScreen(point: { readonly longitude: number; readonly latitude: number }): ScreenPoint | null;
  toMap(point: ScreenPoint): { readonly longitude?: number; readonly latitude?: number } | null;
}

function anchorTransform(anchor: NonNullable<MapMarkerOptions["anchor"]>): string {
  switch (anchor) {
    case "top": return "translate(-50%, 0)";
    case "bottom": return "translate(-50%, -100%)";
    case "left": return "translate(0, -50%)";
    case "right": return "translate(-100%, -50%)";
    case "top-left": return "translate(0, 0)";
    case "top-right": return "translate(-100%, 0)";
    case "bottom-left": return "translate(0, -100%)";
    case "bottom-right": return "translate(-100%, -100%)";
    default: return "translate(-50%, -50%)";
  }
}

function defaultElement(color: string): HTMLElement {
  const element = document.createElement("div");
  element.setAttribute("aria-hidden", "true");
  element.style.width = "18px";
  element.style.height = "18px";
  element.style.borderRadius = "50%";
  element.style.background = color;
  element.style.border = "2px solid white";
  element.style.boxShadow = "0 1px 4px rgb(0 0 0 / 45%)";
  return element;
}

/** A public-projection DOM marker that keeps SDK objects private to the adapter. */
export class ArcGISDomMarker implements MapMarkerHandle {
  private lngLat: LngLat;
  private draggable: boolean;
  private rotation = 0;
  private removed = false;
  private readonly listeners = new Map<keyof MapMarkerEventMap, Set<(payload: never) => void>>();
  private readonly element: HTMLElement;
  private readonly offset: ScreenPoint;
  private readonly anchor: NonNullable<MapMarkerOptions["anchor"]>;

  constructor(
    private readonly view: ArcGISMarkerView,
    options: MapMarkerOptions,
  ) {
    const container = view.container;
    if (!container) throw new Error("ArcGIS marker requires a mounted view container.");
    this.lngLat = options.lngLat;
    this.draggable = options.draggable === true;
    this.offset = options.offset ?? { x: 0, y: 0 };
    this.anchor = options.anchor ?? "center";
    this.element = options.element ?? defaultElement(options.color ?? "#3b82f6");
    this.element.style.position = "absolute";
    this.element.style.zIndex = "1";
    this.element.style.touchAction = "none";
    this.element.style.cursor = this.draggable ? "grab" : "default";
    container.append(this.element);
    this.element.addEventListener("pointerdown", this.onPointerDown);
    this.render();
  }

  setLngLat(lngLat: LngLat): void {
    this.lngLat = lngLat;
    this.render();
  }

  getLngLat(): LngLat {
    return this.lngLat;
  }

  setDraggable(draggable: boolean): void {
    this.draggable = draggable;
    this.element.style.cursor = draggable ? "grab" : "default";
  }

  setRotation(rotation: number): void {
    this.rotation = rotation;
    this.render();
  }

  on<K extends keyof MapMarkerEventMap>(
    event: K,
    handler: (payload: MapMarkerEventMap[K]) => void,
  ): Unsubscribe {
    const handlers = this.listeners.get(event) ?? new Set<(payload: never) => void>();
    handlers.add(handler as (payload: never) => void);
    this.listeners.set(event, handlers);
    return () => handlers.delete(handler as (payload: never) => void);
  }

  remove(): void {
    if (this.removed) return;
    this.removed = true;
    this.element.removeEventListener("pointerdown", this.onPointerDown);
    this.element.remove();
    this.listeners.clear();
  }

  refresh(): void {
    this.render();
  }

  private render(): void {
    if (this.removed) return;
    const point = this.view.toScreen({ longitude: this.lngLat[0], latitude: this.lngLat[1] });
    if (!point) {
      this.element.style.display = "none";
      return;
    }
    this.element.style.display = "";
    this.element.style.left = `${point.x + this.offset.x}px`;
    this.element.style.top = `${point.y + this.offset.y}px`;
    this.element.style.transform = `${anchorTransform(this.anchor)} rotate(${this.rotation}deg)`;
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.draggable || this.removed) return;
    event.preventDefault();
    this.element.setPointerCapture?.(event.pointerId);
    this.element.style.cursor = "grabbing";
    this.emit("dragstart", { lngLat: this.lngLat });
    const move = (next: PointerEvent): void => {
      const rect = this.view.container?.getBoundingClientRect();
      if (!rect) return;
      const point = this.view.toMap({ x: next.clientX - rect.left, y: next.clientY - rect.top });
      if (typeof point?.longitude !== "number" || typeof point.latitude !== "number") return;
      this.lngLat = [point.longitude, point.latitude];
      this.render();
      this.emit("drag", { lngLat: this.lngLat });
    };
    const end = (): void => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", end);
      this.element.style.cursor = this.draggable ? "grab" : "default";
      this.emit("dragend", { lngLat: this.lngLat });
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", end, { once: true });
  };

  private emit<K extends keyof MapMarkerEventMap>(event: K, payload: MapMarkerEventMap[K]): void {
    for (const handler of this.listeners.get(event) ?? []) handler(payload as never);
  }
}
