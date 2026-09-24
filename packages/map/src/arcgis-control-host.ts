import { adaptArcgisControl } from "./arcgis-control-adapters";
import {
  Evented,
  LngLat,
  LngLatBounds,
  Point,
  type IControl,
  type ControlPosition,
  type Map as MapLibreMap,
} from "maplibre-gl";
import type { MapEngine } from "./map-engine";
import type { ArcgisSdk, ArcgisView, ArcgisViewEvent } from "./arcgis-sdk";

/** DOM controls receive view/navigation methods; rendering needs an explicit bridge. */
export class ArcgisControlHost {
  private controls = new Map<IControl, HTMLElement>();
  private adapted = new Map<IControl, () => void>();
  private cleanup: (() => void)[] = [];
  private facade: Evented & Record<string, unknown>;
  constructor(
    private engine: MapEngine,
    private view: ArcgisView,
    sdk: ArcgisSdk,
  ) {
    class ControlEvents extends Evented {}
    const facade = new ControlEvents() as Evented & Record<string, unknown>;
    this.facade = facade;
    const surface = () => engine.getRenderSurface()!;
    const unsupported = () => {
      throw new Error("This control requires a MapLibre rendering bridge");
    };
    const move = (
      options: {
        center?: [number, number] | { lng: number; lat: number };
        zoom?: number;
        bearing?: number;
        pitch?: number;
      },
      animate = true,
    ) => {
      const center = options.center ? LngLat.convert(options.center) : null;
      const next = {
        ...engine.readView(),
        ...options,
        ...(center
          ? { center: [center.lng, center.lat] as [number, number] }
          : { center: engine.readView().center }),
      };
      if (animate) engine.easeToView(next);
      else engine.applyView(next);
      return facade;
    };
    Object.assign(facade, {
      getContainer: () => view.container,
      getCanvasContainer: () => view.container,
      getCanvas: () => surface().getCanvas(),
      getCenter: () => LngLat.convert(engine.readView().center),
      getZoom: () => engine.readView().zoom,
      getBearing: () => engine.readView().bearing,
      getPitch: () => engine.readView().pitch,
      getBounds: () => {
        const b = engine.getViewBounds();
        return b
          ? new LngLatBounds([b[0], b[1]], [b[2], b[3]])
          : new LngLatBounds([-180, -85], [180, 85]);
      },
      getProjection: () => ({ type: engine.readProjection() }),
      isStyleLoaded: () => true,
      loaded: () => true,
      project: (p: Parameters<typeof LngLat.convert>[0]) => {
        const c = LngLat.convert(p),
          out = surface().project([c.lng, c.lat]);
        return new Point(out.x, out.y);
      },
      unproject: (p: [number, number] | { x: number; y: number }) => {
        const point = Point.convert(p);
        const out = surface().unproject([point.x, point.y]);
        // A plugin control expects MapLibre's total `unproject` operation:
        // missing the ArcGIS globe must not take down its pointer handler.
        return out ? new LngLat(out.lng, out.lat) : LngLat.convert(engine.readView().center);
      },
      fitBounds: (b: Parameters<typeof LngLatBounds.convert>[0]) => {
        const bounds = LngLatBounds.convert(b);
        engine.fitBounds([
          bounds.getWest(),
          bounds.getSouth(),
          bounds.getEast(),
          bounds.getNorth(),
        ]);
        return facade;
      },
      flyTo: move,
      easeTo: move,
      jumpTo: (options: Parameters<typeof move>[0]) => move(options, false),
      triggerRepaint: () => surface().redraw(),
      addControl: (control: IControl, position?: ControlPosition) =>
        this.addControl(control, position),
      removeControl: (control: IControl) => this.removeControl(control),
      hasControl: (control: IControl) => this.controls.has(control) || this.adapted.has(control),
      addSource: unsupported,
      removeSource: unsupported,
      addLayer: unsupported,
      removeLayer: unsupported,
      setPaintProperty: unsupported,
      setLayoutProperty: unsupported,
      setStyle: unsupported,
      getSource: () => undefined,
      getLayer: () => undefined,
      getStyle: unsupported,
    });
    const watch = sdk.reactiveUtils.watch(
      () => view.stationary,
      () => {
        facade.fire(view.stationary ? "moveend" : "movestart");
        if (view.stationary) facade.fire("idle");
      },
    );
    this.cleanup.push(() => watch.remove());
    // MapLibre fires `move` on every camera frame, plus `zoom` and `rotate`
    // while those change; readouts such as View State and the minimap follow
    // the camera through them, not just `moveend`.
    let lastZoom = engine.readView().zoom;
    let lastBearing = engine.readView().bearing;
    const frame = sdk.reactiveUtils.watch(
      () => [view.extent, view.type === "3d" ? view.camera?.heading : view.rotation],
      () => {
        const { zoom, bearing } = engine.readView();
        facade.fire("move");
        if (zoom !== lastZoom) facade.fire("zoom");
        if (bearing !== lastBearing) facade.fire("rotate");
        lastZoom = zoom;
        lastBearing = bearing;
      },
    );
    this.cleanup.push(() => frame.remove());
    // Pointer events carry MapLibre's `lngLat` and `point`, for click-driven
    // controls and pointer readouts.
    const pointer = (type: "click" | "mousemove") => (event: ArcgisViewEvent) => {
      const point = new Point(event.x, event.y);
      const lngLat = surface().unproject([event.x, event.y]);
      if (!lngLat) return;
      facade.fire(type, {
        point,
        lngLat: new LngLat(lngLat.lng, lngLat.lat),
        originalEvent: event.native,
      });
    };
    for (const handle of [
      view.on("click", pointer("click")),
      view.on("pointer-move", pointer("mousemove")),
    ])
      this.cleanup.push(() => handle.remove());
    if (view.container && typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => facade.fire("resize"));
      observer.observe(view.container);
      this.cleanup.push(() => observer.disconnect());
    }
  }
  addControl(control: IControl, position: ControlPosition = "top-left"): boolean {
    if (this.controls.has(control) || this.adapted.has(control)) return true;
    const dispose = adaptArcgisControl(this.view, control, this.facade as unknown as MapLibreMap);
    if (dispose) {
      this.adapted.set(control, dispose);
      return true;
    }
    try {
      const element = control.onAdd(this.facade as unknown as MapLibreMap);
      if (!(element instanceof HTMLElement)) throw new Error("Control returned no DOM element");
      element.style.pointerEvents = "auto";
      // These controls discover their expansion direction from the immediate
      // MapLibre corner wrapper. Keep that marker, but let the SDK position it.
      const wrapper = document.createElement("div");
      wrapper.className = `maplibregl-ctrl-${position}`;
      Object.assign(wrapper.style, { position: "static", inset: "auto", pointerEvents: "auto" });
      wrapper.appendChild(element);
      this.view.ui.add(wrapper, position);
      this.controls.set(control, wrapper);
      return true;
    } catch (error) {
      try {
        control.onRemove(this.facade as unknown as MapLibreMap);
      } catch {
        /* Partial initialization. */
      }
      console.warn("[ArcGIS] Could not mount control", error);
      return false;
    }
  }
  removeControl(control: IControl): void {
    const dispose = this.adapted.get(control);
    if (dispose) {
      this.adapted.delete(control);
      try {
        dispose();
      } catch (error) {
        console.warn("[ArcGIS] Could not remove adapted control", error);
      }
      return;
    }
    const element = this.controls.get(control);
    if (!element) return;
    try {
      control.onRemove(this.facade as unknown as MapLibreMap);
    } catch (error) {
      console.warn("[ArcGIS] Could not remove control", error);
    } finally {
      this.view.ui.remove(element);
      element.remove();
      this.controls.delete(control);
    }
  }
  destroy(): void {
    this.facade.fire("remove");
    for (const control of [...this.controls.keys(), ...this.adapted.keys()])
      this.removeControl(control);
    for (const dispose of this.cleanup) dispose();
    this.cleanup = [];
  }
}
