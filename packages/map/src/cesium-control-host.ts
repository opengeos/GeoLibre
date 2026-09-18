import * as maplibregl from "maplibre-gl";
import type { CesiumWidget } from "@cesium/engine";
import { useAppStore } from "@geolibre/core";
import { groundHeightAt, pickGlobeHit } from "./cesium-camera";

/** The Cesium module namespace, injected so this file never imports the engine. */
type CesiumNs = typeof import("@cesium/engine");

/**
 * Where {@link CesiumMapFacade.project} puts a coordinate the scene cannot
 * place: behind the camera, or on the far side of the globe. MapLibre's own
 * globe projection answers such a point with window coordinates far outside
 * the canvas rather than with an error, and the controls that call `project`
 * read the result as "off screen" — so answer the same way instead of
 * throwing at them mid-render.
 */
const OFF_SCREEN_PX = -1e6;

class CesiumMapFacade extends maplibregl.Evented {
  private cleanups: Array<() => void> = [];
  private disposed = false;

  constructor(
    private host: CesiumControlHost,
    private viewer: CesiumWidget,
    private Cesium: CesiumNs | null,
  ) {
    super();
    for (const [event, name] of [
      [viewer.camera.moveStart, "movestart"],
      [viewer.camera.changed, "move"],
      [viewer.camera.moveEnd, "moveend"],
    ] as const) {
      if (event) this.cleanups.push(event.addEventListener(() => this.fire(name)));
    }
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => this.fire("resize"));
      observer.observe(viewer.canvas);
      this.cleanups.push(() => observer.disconnect());
    }
    for (const name of [
      "click",
      "dblclick",
      "mousemove",
      "mousedown",
      "mouseup",
      "contextmenu",
    ] as const) {
      const listener = (originalEvent: MouseEvent) => {
        const C = this.Cesium;
        const scene = this.scene();
        if (!C || !scene) return;
        // `pickGlobeHit` costs a terrain ray intersection, and `mousemove` fires
        // on every pointer frame. The engine's own cursor readout already picks
        // on move, so skip the work entirely when no control is listening here.
        if (!this.listens(name)) return;
        const rect = viewer.canvas.getBoundingClientRect();
        const point = new maplibregl.Point(
          originalEvent.clientX - rect.left,
          originalEvent.clientY - rect.top,
        );
        const hit = pickGlobeHit(C, viewer, point);
        // A click on space has no geographic location. Do not fabricate the
        // view centre for a control that may place a marker or start a query.
        if (!hit) return;
        // `pickGlobeHit` falls back to a WGS84 ellipsoid pick when the scene has
        // no globe, so the conversion cannot assume one is configured either.
        const position = (scene.globe?.ellipsoid ?? C.Ellipsoid.WGS84).cartesianToCartographic(
          hit.position,
        );
        const lngLat = new maplibregl.LngLat(
          C.Math.toDegrees(position.longitude),
          C.Math.toDegrees(position.latitude),
        );
        this.fire(
          new maplibregl.Event(name, {
            point,
            lngLat,
            originalEvent,
            preventDefault: () => originalEvent.preventDefault(),
          }),
        );
      };
      viewer.canvas.addEventListener(name, listener);
      this.cleanups.push(() => viewer.canvas.removeEventListener(name, listener));
    }
  }

  getContainer() {
    return this.viewer.canvas.parentElement ?? this.host.getContainer();
  }

  dispose() {
    this.disposed = true;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
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
        if (!this.disposed) this.fire(new maplibregl.Event("style.load"));
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
    throw new Error("CesiumControlHost: addSource is not supported on the globe.");
  }

  getSource(id: string) {
    return undefined;
  }

  removeSource(id: string) {
    throw new Error("CesiumControlHost: removeSource is not supported on the globe.");
  }

  addLayer(layer: any, beforeId?: string) {
    throw new Error("CesiumControlHost: addLayer is not supported on the globe.");
  }

  removeLayer(id: string) {
    throw new Error("CesiumControlHost: removeLayer is not supported on the globe.");
  }

  /**
   * Window coordinates for a geographic position, the globe's answer to
   * MapLibre's `project` (issue #2262).
   *
   * The position is placed on the terrain surface first — `SceneTransforms`
   * projects a point in the scene, and a coordinate held at ellipsoid zero
   * would land visibly uphill or downhill of its own ground once terrain is
   * on. A point the scene cannot place answers {@link OFF_SCREEN_PX} rather
   * than throwing; see that constant.
   */
  project(lnglat: maplibregl.LngLatLike) {
    const C = this.Cesium;
    const scene = this.scene();
    const { lng, lat } = maplibregl.LngLat.convert(lnglat);
    if (!C || !scene) return new maplibregl.Point(OFF_SCREEN_PX, OFF_SCREEN_PX);
    const height = groundHeightAt(C, this.viewer, lng, lat);
    const world = C.Cartesian3.fromDegrees(lng, lat, height);
    const point = C.SceneTransforms.worldToWindowCoordinates(scene, world);
    return point && Number.isFinite(point.x) && Number.isFinite(point.y)
      ? new maplibregl.Point(point.x, point.y)
      : new maplibregl.Point(OFF_SCREEN_PX, OFF_SCREEN_PX);
  }

  /**
   * The geographic position under a window coordinate — the terrain surface
   * when terrain is loaded, else the ellipsoid, sharing `pickGlobeHit` with
   * the cursor readout so both agree on where the ground is.
   *
   * A screen point that misses the globe entirely (space, past the horizon)
   * has no ground coordinate at all. It answers the current view centre: a
   * defined position inside the scene, which the callers — hit-testing a
   * pointer that is over the canvas — can carry on with, where a throw would
   * take down the control's event handler.
   */
  unproject(point: maplibregl.PointLike) {
    const C = this.Cesium;
    const scene = this.scene();
    const p = maplibregl.Point.convert(point);
    if (!C || !scene) return this.getCenter();
    const hit = pickGlobeHit(C, this.viewer, { x: p.x, y: p.y });
    if (!hit) return this.getCenter();
    const ellipsoid = scene.globe?.ellipsoid ?? C.Ellipsoid.WGS84;
    const carto = ellipsoid.cartesianToCartographic(hit.position);
    if (!carto) return this.getCenter();
    const lng = C.Math.toDegrees(carto.longitude);
    const lat = C.Math.toDegrees(carto.latitude);
    return Number.isFinite(lng) && Number.isFinite(lat)
      ? new maplibregl.LngLat(lng, lat)
      : this.getCenter();
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
  /**
   * The geographic extent the camera currently sees.
   *
   * `computeViewRectangle` has no answer when the globe does not fill enough
   * of the frustum to bound — looking at space past the limb, or mid-morph
   * between scene modes. Controls call `getBounds` to *narrow* something (a
   * catalog search to the viewport, a fetch to the visible tiles), so the
   * fallback is the whole world: a superset returns more than the view holds,
   * where a guess or a throw would drop results the user can see.
   */
  getBounds() {
    const C = this.Cesium;
    const scene = this.scene();
    const rectangle =
      C && scene?.globe
        ? this.viewer.camera.computeViewRectangle(scene.globe.ellipsoid)
        : undefined;
    if (!C || !rectangle) return new maplibregl.LngLatBounds([-180, -90], [180, 90]);
    const degrees = C.Math.toDegrees;
    const west = degrees(rectangle.west);
    const east = degrees(rectangle.east);
    // Cesium inverts the pair across the antimeridian; LngLatBounds unwraps it
    // the way MapExtent does in CesiumEngine.getViewBounds.
    return new maplibregl.LngLatBounds(
      [west, degrees(rectangle.south)],
      [east < west ? east + 360 : east, degrees(rectangle.north)],
    );
  }

  /** The live scene, or null once the widget has been destroyed. */
  private scene() {
    return this.viewer.isDestroyed?.() ? null : (this.viewer.scene ?? null);
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

  /**
   * @param viewer The globe this host mounts controls over.
   * @param containerParent The element the corner containers are appended to.
   * @param Cesium The engine namespace, for the facade's scene geometry
   *   (`project` / `unproject` / `getBounds`). Omitting it leaves those
   *   answering their documented fallbacks rather than throwing.
   */
  constructor(
    public viewer: CesiumWidget,
    containerParent: HTMLElement,
    Cesium: CesiumNs | null = null,
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
    this.facade = new CesiumMapFacade(this, viewer, Cesium);
  }

  destroy() {
    this.facade.dispose();
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
