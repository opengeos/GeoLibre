import * as maplibregl from "maplibre-gl";
import type { CesiumWidget } from "@cesium/engine";
import { useAppStore } from "@geolibre/core";

class CesiumMapFacade extends maplibregl.Evented {
  private sources = new Map<string, any>();
  private layers = new Map<string, any>();

  constructor(
    private host: CesiumControlHost,
    private viewer: CesiumWidget,
  ) {
    super();
  }

  getContainer() {
    return this.host.getContainer();
  }

  getCanvas() {
    return this.viewer.canvas;
  }

  isStyleLoaded() {
    return true;
  }

  setStyle(style: any, options?: any) {
    if (typeof style === "string") {
      useAppStore.getState().setBasemapStyleUrl(style);
      // Best-effort `style.load`, not a real readiness signal. The store update
      // reaches the globe through CesiumCanvas's own effect, whose imagery
      // providers and tile requests are asynchronous and not bounded by one
      // macrotask — so a control that reacts to this by reading style state may
      // still run before the imagery has actually switched. It exists because
      // controls wait for it before finishing a basemap swap (they would hang
      // otherwise); it does not promise the pixels have changed.
      setTimeout(() => {
        this.fire(new maplibregl.Event("style.load"));
      }, 0);
    } else {
      throw new Error("CesiumControlHost: setStyle with an object is not supported.");
    }
    return this;
  }

  jumpTo(options: maplibregl.JumpToOptions) {
    const currentView = useAppStore.getState().mapView;
    const update: any = {};
    if (options.center) {
      const center = maplibregl.LngLat.convert(options.center);
      update.center = [center.lng, center.lat];
    }
    if (options.zoom !== undefined) update.zoom = options.zoom;
    if (options.bearing !== undefined) update.bearing = options.bearing;
    if (options.pitch !== undefined) update.pitch = options.pitch;

    if (Object.keys(update).length > 0) {
      useAppStore.getState().setMapView({ ...currentView, ...update });
    }
    return this;
  }

  flyTo(options: maplibregl.FlyToOptions) {
    return this.jumpTo(options as any);
  }

  easeTo(options: maplibregl.EaseToOptions) {
    return this.jumpTo(options as any);
  }

  addSource(id: string, source: any) {
    this.sources.set(id, source);
    return this;
  }

  getSource(id: string) {
    return this.sources.get(id);
  }

  removeSource(id: string) {
    this.sources.delete(id);
    return this;
  }

  addLayer(layer: any, beforeId?: string) {
    throw new Error("CesiumControlHost: addLayer is not supported on the globe.");
  }

  removeLayer(id: string) {
    this.layers.delete(id);
    return this;
  }

  // Not implemented but required by IControl type definition/plugins in fallback
  project(lnglat: maplibregl.LngLatLike) {
    throw new Error("CesiumControlHost: project not implemented");
  }
  unproject(point: maplibregl.PointLike) {
    throw new Error("CesiumControlHost: unproject not implemented");
  }
  getCenter() {
    const view = useAppStore.getState().mapView;
    return new maplibregl.LngLat(view.center[0], view.center[1]);
  }
  getZoom() {
    return useAppStore.getState().mapView.zoom;
  }
  getBearing() {
    return useAppStore.getState().mapView.bearing;
  }
  getPitch() {
    return useAppStore.getState().mapView.pitch;
  }
  getBounds() {
    throw new Error("CesiumControlHost: getBounds not implemented");
  }

  // Throw explicitly for style-spec mutations
  setPaintProperty() {
    throw new Error("CesiumControlHost: setPaintProperty is not supported on the globe.");
  }
  setLayoutProperty() {
    throw new Error("CesiumControlHost: setLayoutProperty is not supported on the globe.");
  }
  getStyle() {
    throw new Error("CesiumControlHost: getStyle is not supported on the globe.");
  }
}

export class CesiumControlHost {
  private container: HTMLDivElement;
  private corners: Record<string, HTMLDivElement>;
  private controls = new Map<maplibregl.IControl, HTMLElement>();
  private facade: CesiumMapFacade;

  constructor(
    public viewer: CesiumWidget,
    containerParent: HTMLElement,
  ) {
    this.container = document.createElement("div");
    this.container.className = "maplibregl-control-container";

    this.corners = {
      "top-left": document.createElement("div"),
      "top-right": document.createElement("div"),
      "bottom-left": document.createElement("div"),
      "bottom-right": document.createElement("div"),
    };

    for (const [pos, el] of Object.entries(this.corners)) {
      el.className = `maplibregl-ctrl-${pos}`;
      el.style.position = "absolute";
      el.style.pointerEvents = "none";
      el.style.zIndex = "2";
      this.container.appendChild(el);
    }

    containerParent.appendChild(this.container);
    this.facade = new CesiumMapFacade(this, viewer);
  }

  destroy() {
    for (const control of Array.from(this.controls.keys())) {
      this.removeControl(control);
    }
    if (this.container.parentElement) {
      this.container.parentElement.removeChild(this.container);
    }
  }

  getContainer() {
    return this.container;
  }

  /** Move the existing DOM without destroying a widget or its event bindings. */
  setControlPosition(control: maplibregl.IControl, position: maplibregl.ControlPosition): boolean {
    if (!Object.hasOwn(this.corners, position)) return false;
    const element = this.controls.get(control);
    if (element) this.corners[position].appendChild(element);
    return true;
  }

  /**
   * Mounts a MapLibre control onto the Cesium viewer container in the requested corner.
   *
   * @param control - The MapLibre control instance to add.
   * @param position - The target corner position ('top-left', 'top-right', 'bottom-left', 'bottom-right').
   * @returns `true` if the control was successfully added, or `false` if addition failed or element was invalid.
   */
  addControl(control: maplibregl.IControl, position: maplibregl.ControlPosition = "top-right") {
    if (this.controls.has(control)) return false;

    // The facade throws for the style-spec methods it cannot honour, which is
    // deliberate — but `addMapControl` is a boolean-returning API that plugins
    // are written against (`if (!app.addMapControl(...))`), and at least one
    // caller activates plugins without a try/catch (PluginManager's
    // project-restore loop). Letting the throw escape would abort restoring the
    // remaining plugins instead of degrading like any other failed control, so
    // a control whose onAdd trips the facade reports "not added" rather than
    // taking the caller down with it.
    let el: HTMLElement;
    try {
      el = control.onAdd(this.facade as unknown as maplibregl.Map);
      if (!(el instanceof HTMLElement)) {
        console.warn("[GeoLibre] control onAdd did not return a valid DOM element");
        return false;
      }
    } catch (error) {
      console.warn("[GeoLibre] control could not mount on the globe", error);
      return false;
    }
    el.style.pointerEvents = "auto";

    const VALID_POSITIONS: readonly maplibregl.ControlPosition[] = [
      "top-left",
      "top-right",
      "bottom-left",
      "bottom-right",
    ];
    const target = VALID_POSITIONS.includes(position) ? position : "top-right";
    const corner = this.corners[target];
    corner.appendChild(el);

    this.controls.set(control, el);
    return true;
  }

  /**
   * Removes a MapLibre control from the Cesium viewer container and cleans up its DOM element.
   *
   * @param control - The MapLibre control instance to remove.
   */
  removeControl(control: maplibregl.IControl) {
    if (!this.controls.has(control)) return;

    const el = this.controls.get(control)!;

    // Guarded for the same reason `addControl` guards `onAdd`, and it matters
    // more here: `destroy()` calls this in a loop, and `CesiumCanvas`'s unmount
    // effect calls `destroy()` with no try/catch of its own. A control whose
    // `onRemove` trips one of the facade's deliberate throws would otherwise
    // escape the cleanup — leaving the remaining controls mounted, the
    // container attached, the primary-host registration stale, and the Cesium
    // viewer never destroyed.
    //
    // The control's DOM element is intentionally kept in its container until
    // after `onRemove` returns: many `IControl` implementations invoke
    // `this._container.parentNode.removeChild(this._container)` directly, and
    // detaching beforehand causes them to throw on null parentNode. The finally
    // block guarantees DOM cleanup and registry removal regardless of outcome.
    try {
      control.onRemove(this.facade as unknown as maplibregl.Map);
    } catch (error) {
      console.warn("[GeoLibre] control failed to unmount cleanly from the globe", error);
    } finally {
      if (el.parentElement) {
        el.parentElement.removeChild(el);
      }
      this.controls.delete(control);
    }
  }
}

let primaryCesiumControlHost: CesiumControlHost | null = null;
export function getPrimaryCesiumControlHost() {
  return primaryCesiumControlHost;
}
export function setPrimaryCesiumControlHost(host: CesiumControlHost | null) {
  primaryCesiumControlHost = host;
}
