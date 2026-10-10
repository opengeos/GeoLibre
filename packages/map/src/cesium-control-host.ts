import * as maplibregl from "maplibre-gl";
import type { CesiumWidget, CustomDataSource } from "@cesium/engine";
import { useAppStore } from "@geolibre/core";
import {
  installControlLayerEvents,
  type LayerEventDispatch,
  type PointerSource,
} from "./control-layer-events";
import { pickOverlayGraphics, shadowOverlayGraphics, type OverlayGraphic } from "./shadow-overlay";
import { groundHeightAt, pickGlobeHit } from "./cesium-camera";
import {
  applyHorizonVisibility,
  cameraFacingTest,
  drawCesiumOverlayGraphics,
  type AnchoredEntity,
  type FacingTest,
} from "./cesium-control-overlay";
import type { IdentifiedFeature } from "./map-engine";
import { controlLayerMirrors, createShadowStyle, storeStyleLayer } from "./shadow-style";

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

/**
 * The store-layer fields `controlLayerMirrors` reads, as one string: the
 * overlay only needs a redraw when this changes.
 *
 * @param layers - The store layers.
 * @returns A signature of their ids and mirror metadata.
 */
export function mirrorSignature(
  layers: readonly { id: string; metadata: Record<string, unknown> }[],
): string {
  return JSON.stringify(
    layers.map(({ id, metadata }) => [
      id,
      metadata.nativeLayerIds ?? null,
      metadata.sourceId ?? null,
      metadata.sourceIds ?? null,
    ]),
  );
}

/** The pointer events layer-scoped listeners are fed from. */
const LAYER_POINTER = { click: true, mousemove: true, mousedown: true, mouseup: true };

/** Pixels of slack a click on an overlay point or line is given, as on ArcGIS. */
const HIT_TOLERANCE_PX = 4;

/**
 * How far the pointer may move between press and release and still count as a
 * click, as MapLibre's `clickTolerance` (3 px by default). The browser fires
 * `click` after any press and release on the canvas, so without it every drag
 * that pans the globe also reaches a control's click handler.
 */
const CLICK_TOLERANCE_PX = 3;

/**
 * The MapLibre-shaped map a plugin control receives on the globe.
 *
 * Camera, DOM and pointer events act on the globe. The Style Spec half is
 * recorded into a shadow style that is never drawn as such (the model the
 * ArcGIS host uses, issue #3088): a layer the plugin mirrors into the GeoLibre
 * store is drawn by `CesiumLayerSync` from that record, and the host draws any
 * other GeoJSON fill, line, circle or text layer as globe entities. A plugin
 * still reaches this facade only when its `engines` list declares `cesium`.
 */
class CesiumMapFacade extends maplibregl.Evented {
  private cleanups: Array<() => void> = [];
  private disposed = false;
  private layerEvents: LayerEventDispatch;
  /** The recorded style, for the host's overlay; not a MapLibre method. */
  readonly peekStyle: ReturnType<typeof createShadowStyle>["peek"];

  constructor(
    private host: CesiumControlHost,
    private viewer: CesiumWidget,
    private Cesium: CesiumNs | null,
  ) {
    super();
    const { peek, ...shadow } = createShadowStyle({
      fire: (type, data) => this.fire(type, data),
      self: () => this,
    });
    this.peekStyle = peek;
    const images = new Set<string>();
    // A store layer's derived style layers (`layer-<id>-fill`) read back too,
    // as they would on MapLibre; see `storeStyleLayer`.
    const getLayer = (id: string) =>
      shadow.getLayer(id) ?? storeStyleLayer(useAppStore.getState().layers, id);
    Object.assign(this, shadow, {
      getLayer,
      // A custom layer renders through MapLibre's WebGL context, which the
      // globe does not have: recording one would let a GPU control (the COG,
      // LiDAR, splat and deck.gl overlays) mount and then never draw, or spin
      // waiting for frames that never come. Refuse it loudly, as the facade
      // refused every style call before it recorded them, so such a control
      // fails to mount instead.
      addLayer: (layer: { type?: string; id?: string }, beforeId?: string) => {
        if (layer?.type === "custom")
          throw new Error(
            `CesiumControlHost: custom layer "${layer.id}" cannot render on the globe.`,
          );
        return shadow.addLayer(layer as never, beforeId);
      },
      // Feature state and images have nothing to act on without a MapLibre
      // renderer; they answer as a map that has them would, so a control that
      // touches them in passing does not throw.
      setFeatureState: () => {},
      removeFeatureState: () => {},
      getFeatureState: () => ({}),
      addImage: (id: string) => void images.add(id),
      updateImage: () => {},
      hasImage: (id: string) => images.has(id),
      removeImage: (id: string) => void images.delete(id),
      listImages: () => [...images],
      // A control's box or line draw turns drag-pan off so the drag reaches
      // its own mouse handlers instead of moving the globe.
      dragPan: cameraInputHandler(viewer, ["enableRotate", "enableTranslate", "enableTilt"]),
      scrollZoom: cameraInputHandler(viewer, ["enableZoom"]),
      dragRotate: cameraInputHandler(viewer, ["enableLook"]),
      ...Object.fromEntries(
        ["boxZoom", "doubleClickZoom", "touchZoomRotate", "touchPitch", "keyboard"].map((name) => [
          name,
          inertHandler(),
        ]),
      ),
    });
    this.layerEvents = installControlLayerEvents({
      manualPointer: true,
      facade: this as unknown as maplibregl.Evented & Record<string, unknown>,
      pick: (lngLat, layerId, sourceId) => host.pickControlLayer(lngLat, layerId, sourceId),
      layerSource: (layerId) => {
        const layer = getLayer(layerId);
        return layer && "source" in layer && typeof layer.source === "string"
          ? layer.source
          : undefined;
      },
      layerIds: () => shadow.getLayersOrder(),
      unproject: (point) => this.pickLngLat(point),
    });
    for (const [event, name] of [
      [viewer.camera.moveStart, "movestart"],
      [viewer.camera.changed, "move"],
      [viewer.camera.moveEnd, "moveend"],
    ] as const) {
      if (event) this.cleanups.push(event.addEventListener(() => this.fire(name)));
    }
    // MapLibre fires `render` every frame; the camera's `changed` above only
    // fires past a movement threshold, so an element pinned to the map (a
    // popup) follows the frames instead. Only built when someone listens.
    const postRender = viewer.scene?.postRender;
    if (postRender)
      this.cleanups.push(
        postRender.addEventListener(() => {
          if (this.listens("render")) this.fire("render");
        }),
      );
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => this.fire("resize"));
      observer.observe(viewer.canvas);
      this.cleanups.push(() => observer.disconnect());
    }
    this.cleanups.push(restoreCompatibilityMouseEvents(viewer.canvas));
    // Where the current press started, to drop the `click` that ends a drag.
    // Each click consumes it, so a later click with no press of its own (from
    // the keyboard, or dispatched) is not measured against a stale one; the
    // consumed press stays on hand for the `dblclick` that follows the click.
    let pressedAt: { x: number; y: number } | null = null;
    let clickPress: { x: number; y: number } | null = null;
    const onPress = (event: PointerEvent) => {
      pressedAt = { x: event.clientX, y: event.clientY };
    };
    const onCancel = () => {
      pressedAt = null;
      clickPress = null;
    };
    viewer.canvas.addEventListener("pointerdown", onPress, true);
    viewer.canvas.addEventListener("pointercancel", onCancel, true);
    this.cleanups.push(() => {
      viewer.canvas.removeEventListener("pointerdown", onPress, true);
      viewer.canvas.removeEventListener("pointercancel", onCancel, true);
    });
    for (const name of [
      "click",
      "dblclick",
      "mousemove",
      "mousedown",
      "mouseup",
      "contextmenu",
    ] as const) {
      const listener = (originalEvent: MouseEvent) => {
        // Consume the press before any early return, so it never goes stale.
        const press = name === "dblclick" ? clickPress : name === "click" ? pressedAt : null;
        if (name === "click") {
          clickPress = pressedAt;
          pressedAt = null;
        } else if (name === "dblclick") {
          clickPress = null;
        }
        const C = this.Cesium;
        const scene = this.scene();
        if (!C || !scene) return;
        // `pickGlobeHit` costs a terrain ray intersection, and `mousemove` fires
        // on every pointer frame. The engine's own cursor readout already picks
        // on move, so skip the work entirely when no control is listening here,
        // on the map or on one of its style layers.
        const layered = name in LAYER_POINTER && this.layerEvents.listening(name as PointerSource);
        if (!this.listens(name) && !layered) return;
        if (
          press &&
          Math.hypot(originalEvent.clientX - press.x, originalEvent.clientY - press.y) >
            CLICK_TOLERANCE_PX
        )
          return;
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
        const payload = {
          point,
          lngLat,
          originalEvent,
          preventDefault: () => originalEvent.preventDefault(),
        };
        this.fire(new maplibregl.Event(name, payload));
        if (layered) this.layerEvents.dispatch(name as PointerSource, payload);
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

  getCanvasContainer() {
    return this.getContainer();
  }

  loaded() {
    return true;
  }

  /** "globe" in the 3D scene, "mercator" in the flat 2D and Columbus modes. */
  getProjection() {
    const C = this.Cesium;
    const mode = this.scene()?.mode;
    return { type: C && mode !== undefined && mode !== C.SceneMode.SCENE3D ? "mercator" : "globe" };
  }

  triggerRepaint() {
    if (!this.viewer.isDestroyed?.()) this.viewer.scene?.requestRender?.();
  }

  fitBounds(bounds: maplibregl.LngLatBoundsLike) {
    const b = maplibregl.LngLatBounds.convert(bounds);
    this.host.fitBounds([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
    return this;
  }

  addControl(control: maplibregl.IControl, position?: maplibregl.ControlPosition) {
    this.host.addControl(control, position);
    return this;
  }

  removeControl(control: maplibregl.IControl) {
    this.host.removeControl(control);
    return this;
  }

  hasControl(control: maplibregl.IControl) {
    return this.host.hasControl(control);
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
    const lngLat = this.pickLngLat(p);
    return lngLat ? new maplibregl.LngLat(lngLat[0], lngLat[1]) : this.getCenter();
  }

  /** The ground position under a window coordinate, or null off the globe. */
  pickLngLat(point: { x: number; y: number }): [number, number] | null {
    const C = this.Cesium;
    const scene = this.scene();
    if (!C || !scene) return null;
    const hit = pickGlobeHit(C, this.viewer, { x: point.x, y: point.y });
    if (!hit) return null;
    const ellipsoid = scene.globe?.ellipsoid ?? C.Ellipsoid.WGS84;
    const carto = ellipsoid.cartesianToCartographic(hit.position);
    if (!carto) return null;
    const lng = C.Math.toDegrees(carto.longitude);
    const lat = C.Math.toDegrees(carto.latitude);
    return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
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
}

/**
 * Re-dispatch the mouse events the browser drops during a press on the globe.
 *
 * Cesium's input handler cancels `pointerdown`, and a cancelled `pointerdown`
 * suppresses the compatibility `mousedown`, `mousemove` and `mouseup` until
 * the pointer is released (only `click` still fires). A plugin control that
 * draws by dragging - a STAC search box, a measure line - listens for those
 * mouse events on the canvas and the window, as it would on MapLibre, so on
 * the globe it never saw the press. While a mouse press Cesium cancelled is
 * down, each pointer event is mirrored as its mouse event on the same target,
 * bubbling as the real one would.
 *
 * Listeners sit on the window in the bubble phase, so they run after the
 * canvas's own and see whether Cesium cancelled the press. A press nothing
 * cancelled keeps the browser's own mouse events and is not mirrored.
 *
 * @param canvas - The globe's canvas.
 * @returns Removes the listeners.
 */
export function restoreCompatibilityMouseEvents(canvas: HTMLCanvasElement): () => void {
  const view = canvas.ownerDocument?.defaultView;
  if (!view || typeof view.MouseEvent !== "function") return () => {};
  let pressed: number | null = null;
  const mirror = (type: string, event: PointerEvent) => {
    const target = event.target instanceof view.Node ? event.target : canvas;
    target.dispatchEvent(
      new view.MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view,
        clientX: event.clientX,
        clientY: event.clientY,
        screenX: event.screenX,
        screenY: event.screenY,
        button: event.button,
        buttons: event.buttons,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
      }),
    );
  };
  const onDown = (event: PointerEvent) => {
    if (event.pointerType !== "mouse" || event.target !== canvas || !event.defaultPrevented) return;
    pressed = event.pointerId;
    mirror("mousedown", event);
  };
  const onMove = (event: PointerEvent) => {
    if (event.pointerId === pressed) mirror("mousemove", event);
  };
  const onUp = (event: PointerEvent) => {
    if (event.pointerId !== pressed) return;
    pressed = null;
    mirror("mouseup", event);
  };
  const onCancel = (event: PointerEvent) => {
    if (event.pointerId === pressed) pressed = null;
  };
  view.addEventListener("pointerdown", onDown);
  view.addEventListener("pointermove", onMove);
  view.addEventListener("pointerup", onUp);
  view.addEventListener("pointercancel", onCancel);
  return () => {
    view.removeEventListener("pointerdown", onDown);
    view.removeEventListener("pointermove", onMove);
    view.removeEventListener("pointerup", onUp);
    view.removeEventListener("pointercancel", onCancel);
  };
}

/** A MapLibre interaction handler with nothing to drive: it only keeps its flag. */
function inertHandler() {
  let enabled = true;
  return {
    enable: () => {
      enabled = true;
    },
    disable: () => {
      enabled = false;
    },
    isEnabled: () => enabled,
    isActive: () => false,
  };
}

type CameraInput = "enableRotate" | "enableTranslate" | "enableTilt" | "enableZoom" | "enableLook";

/**
 * A MapLibre interaction handler that switches the globe's own camera inputs:
 * `disable()` turns them off and `enable()` restores what they were, so a
 * control that suspends panning for a draw gesture does not re-enable an
 * input something else had turned off.
 */
function cameraInputHandler(viewer: CesiumWidget, inputs: CameraInput[]) {
  let saved: Partial<Record<CameraInput, boolean>> | null = null;
  const controller = () =>
    viewer.isDestroyed?.() ? null : (viewer.scene?.screenSpaceCameraController ?? null);
  return {
    enable: () => {
      const camera = controller();
      if (camera && saved) for (const input of inputs) camera[input] = saved[input] ?? true;
      saved = null;
    },
    disable: () => {
      const camera = controller();
      if (!camera || saved) return;
      saved = Object.fromEntries(inputs.map((input) => [input, camera[input]]));
      for (const input of inputs) camera[input] = false;
    },
    isEnabled: () => saved === null,
    isActive: () => false,
  };
}

/** What the engine lends the control host: picking and framing on the globe. */
export interface CesiumControlHostHooks {
  /** Store features under a point for one store layer (`CesiumEngine.identifyFeatures`). */
  identify: (lngLat: [number, number], layerId: string) => IdentifiedFeature[];
  /** Frame a west/south/east/north extent (`CesiumEngine.fitBounds`). */
  fitBounds: (bounds: [number, number, number, number]) => void;
}

const NO_HOOKS: CesiumControlHostHooks = { identify: () => [], fitBounds: () => {} };

export class CesiumControlHost {
  private container: HTMLDivElement;
  private corners: Record<string, HTMLDivElement>;
  private controls = new Map<maplibregl.IControl, HTMLElement>();
  private facade: CesiumMapFacade;
  private overlay: CustomDataSource | null = null;
  private overlayGraphics: OverlayGraphic[] = [];
  private overlayQueued = false;
  private facing: FacingTest | null = null;
  private anchored: AnchoredEntity[] = [];
  private destroyed = false;
  private cleanups: Array<() => void> = [];

  /**
   * @param viewer The globe this host mounts controls over.
   * @param containerParent The element the corner containers are appended to.
   * @param Cesium The engine namespace, for the facade's scene geometry
   *   (`project` / `unproject` / `getBounds`). Omitting it leaves those
   *   answering their documented fallbacks rather than throwing.
   * @param hooks What the engine lends for picking a control's mirrored
   *   layers and framing an extent.
   */
  constructor(
    public viewer: CesiumWidget,
    containerParent: HTMLElement,
    private Cesium: CesiumNs | null = null,
    private hooks: CesiumControlHostHooks = NO_HOOKS,
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
    // Redraw the overlay once per burst of style edits, when the store's
    // layers change (a record registered or dropped changes which control
    // layers are mirrored), and when the integer zoom a zoom range or zoom
    // expression reads changes.
    const redraw = () => this.refreshOverlay();
    this.facade.on("styledata", redraw);
    // Points and labels past the horizon follow the camera, not the style.
    for (const event of [viewer.camera?.changed, viewer.camera?.moveEnd])
      if (event) this.cleanups.push(event.addEventListener(() => this.updateHorizon()));
    this.facade.on("sourcedata", redraw);
    let overlayZoom = Math.floor(this.facade.getZoom());
    this.facade.on("moveend", () => {
      const zoom = Math.floor(this.facade.getZoom());
      if (zoom === overlayZoom) return;
      overlayZoom = zoom;
      this.refreshOverlay();
    });
    // Only what decides which control layers are mirrored matters here: an
    // opacity drag or a restyle must not rebuild every overlay entity.
    let mirrors = mirrorSignature(useAppStore.getState().layers);
    this.cleanups.push(
      useAppStore.subscribe((state, previous) => {
        if (state.layers === previous.layers) return;
        const next = mirrorSignature(state.layers);
        if (next === mirrors) return;
        mirrors = next;
        this.refreshOverlay();
      }),
    );
  }

  /**
   * The MapLibre-shaped map a control receives here, for a plugin that docks
   * its panel outside the globe but still needs a map to talk to.
   */
  getControlMap(): maplibregl.Map {
    return this.facade as unknown as maplibregl.Map;
  }

  hasControl(control: maplibregl.IControl): boolean {
    return this.controls.has(control);
  }

  /** Frame an extent through the engine. */
  fitBounds(bounds: [number, number, number, number]): void {
    this.hooks.fitBounds(bounds);
  }

  /**
   * Features a control's style layer has under `lngLat`: the hits on the store
   * layers that mirror it, which `CesiumLayerSync` draws, or else the hits on
   * this host's own overlay graphics for that layer.
   */
  pickControlLayer(
    lngLat: [number, number],
    layerId: string,
    sourceId: string | undefined,
  ): IdentifiedFeature[] {
    const mirrors = this.mirrorsOf(layerId, sourceId);
    if (mirrors.length)
      return mirrors.flatMap((layer) =>
        this.hooks.identify(lngLat, layer.id).map((hit) => ({ ...hit, layerId: layer.id })),
      );
    return pickOverlayGraphics(this.overlayGraphics, lngLat, layerId, this.tolerance(lngLat));
  }

  private mirrorsOf(layerId: string, sourceId: string | undefined) {
    return controlLayerMirrors(useAppStore.getState().layers, layerId, sourceId);
  }

  /** {@link HIT_TOLERANCE_PX} in degrees of longitude at `lngLat`. */
  private tolerance(lngLat: [number, number]): number {
    const at = this.facade.project(lngLat);
    // Probe both sides: next to the limb one of them is off the globe, and a
    // zero tolerance would leave points and lines there unclickable.
    for (const dx of [HIT_TOLERANCE_PX, -HIT_TOLERANCE_PX]) {
      const beside = this.facade.pickLngLat({ x: at.x + dx, y: at.y });
      if (!beside) continue;
      const span = Math.abs(beside[0] - lngLat[0]);
      // Across the antimeridian the short way round is 360 minus the gap.
      if (Number.isFinite(span)) return Math.min(span, 360 - span);
    }
    return 0;
  }

  /**
   * Redraw the controls' own GeoJSON overlays: the recorded style's layers
   * that no store layer mirrors. Coalesced to one redraw per microtask.
   */
  refreshOverlay(): void {
    // A control torn down with the globe edits its style on the way out; the
    // redraw that queues must not touch the destroyed widget.
    if (this.destroyed || this.overlayQueued) return;
    this.overlayQueued = true;
    queueMicrotask(() => {
      this.overlayQueued = false;
      if (!this.destroyed) this.drawOverlay();
    });
  }

  private drawOverlay(): void {
    const C = this.Cesium;
    if (!C || this.viewer.isDestroyed?.()) return;
    const graphics = shadowOverlayGraphics(
      this.facade.peekStyle(),
      this.facade.getZoom(),
      (layerId, sourceId) => this.mirrorsOf(layerId, sourceId).length > 0,
    );
    this.overlayGraphics = graphics;
    if (!graphics.length && !this.overlay) return;
    if (!this.overlay) {
      this.overlay = new C.CustomDataSource("geolibre-plugin-overlays");
      void this.viewer.dataSources.add(this.overlay);
    }
    this.anchored = drawCesiumOverlayGraphics(C, this.overlay, graphics);
    this.updateHorizon();
    this.viewer.scene?.requestRender?.();
  }

  /** Re-run the overlay's horizon pass (see `applyHorizonVisibility`). */
  private updateHorizon(): void {
    const C = this.Cesium;
    if (!C || !this.anchored.length || this.viewer.isDestroyed?.()) return;
    this.facing ??= cameraFacingTest(C, this.viewer.scene);
    if (applyHorizonVisibility(this.anchored, this.facing)) this.viewer.scene?.requestRender?.();
  }

  destroy() {
    this.destroyed = true;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.facade.fire("remove");
    this.facade.dispose();
    for (const control of Array.from(this.controls.keys())) {
      this.removeControl(control);
    }
    if (this.container.parentElement) {
      this.container.parentElement.removeChild(this.container);
    }
    if (this.overlay && !this.viewer.isDestroyed?.())
      this.viewer.dataSources.remove(this.overlay, true);
    this.overlay = null;
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
