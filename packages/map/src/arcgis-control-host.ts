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
import { installArcgisLayerEvents, type NativeLayerPicker } from "./arcgis-layer-events";
import {
  pickOverlayGraphics,
  shadowOverlayGraphics,
  type OverlayGraphic,
} from "./arcgis-shadow-overlay";
import type { ArcgisGeometryJson, ArcgisLayer } from "./arcgis-sdk";
import type { Geometry } from "geojson";
import { createShadowStyle } from "./shadow-style";

/**
 * DOM controls receive view/navigation methods; rendering needs an explicit
 * bridge. The facade's style methods record into a shadow style that is never
 * drawn: enough for a control that mirrors its layers into the GeoLibre store,
 * which is what the engine draws.
 */
export class ArcgisControlHost {
  private controls = new Map<IControl, HTMLElement>();
  private peekShadow: ReturnType<typeof createShadowStyle>["peek"];
  private sdk: ArcgisSdk;
  private hooks: ArcgisControlHostHooks;
  private overlay: ArcgisLayer | null = null;
  private overlayGraphics: OverlayGraphic[] = [];
  private overlayQueued = false;
  private destroyed = false;
  private adapted = new Map<IControl, () => void>();
  private cleanup: (() => void)[] = [];
  private facade: Evented & Record<string, unknown>;
  constructor(
    private engine: MapEngine,
    private view: ArcgisView,
    sdk: ArcgisSdk,
    hooks: ArcgisControlHostHooks = NO_HOOKS,
  ) {
    class ControlEvents extends Evented {}
    const facade = new ControlEvents() as Evented & Record<string, unknown>;
    this.facade = facade;
    const surface = () => engine.getRenderSurface()!;
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
    const { peek, ...shadow } = createShadowStyle({
      fire: (type, data) => facade.fire(type, data),
      self: () => facade,
    });
    this.peekShadow = peek;
    this.sdk = sdk;
    this.hooks = hooks;
    const images = new Set<string>();
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
      ...shadow,
      // Feature state, images and interaction handlers have nothing to act on
      // without a MapLibre renderer; they answer as a map that has them would,
      // so a control that touches them in passing does not throw.
      setFeatureState: () => {},
      removeFeatureState: () => {},
      getFeatureState: () => ({}),
      addImage: (id: string) => void images.add(id),
      updateImage: () => {},
      hasImage: (id: string) => images.has(id),
      removeImage: (id: string) => void images.delete(id),
      listImages: () => [...images],
      // Turning drag-pan off is what a control's box or line draw needs: the
      // drag has to reach its mouse handlers instead of moving the view.
      dragPan: blockingHandler(() => view.on("drag", (event) => event.stopPropagation())),
      ...Object.fromEntries(
        [
          "dragRotate",
          "scrollZoom",
          "boxZoom",
          "doubleClickZoom",
          "touchZoomRotate",
          "touchPitch",
          "keyboard",
        ].map((name) => [name, inertHandler()]),
      ),
    });
    installArcgisLayerEvents({
      facade,
      // A control's layer is either mirrored by a store layer, which the
      // engine draws and picks, or drawn by this host's overlay.
      pick: (lngLat, layerId, sourceId) =>
        sourceId !== undefined && hooks.isMirrored(layerId, sourceId)
          ? hooks.pick(lngLat, layerId, sourceId)
          : pickOverlayGraphics(this.overlayGraphics, lngLat, layerId, hooks.tolerance(lngLat)),
      layerSource: (layerId) => {
        const layer = shadow.getLayer(layerId);
        return layer && "source" in layer && typeof layer.source === "string"
          ? layer.source
          : undefined;
      },
      layerIds: () => shadow.getLayersOrder(),
      unproject: (point) => {
        const out = surface().unproject([point.x, point.y]);
        return out ? [out.lng, out.lat] : null;
      },
    });
    // Redraw the overlay once per burst of style edits (the shadow style
    // coalesces them into one `styledata`), and when the integer zoom a zoom
    // range or zoom expression reads changes.
    const redraw = () => this.refreshOverlay();
    facade.on("styledata", redraw);
    facade.on("sourcedata", redraw);
    let overlayZoom = Math.floor(engine.readView().zoom);
    facade.on("moveend", () => {
      const zoom = Math.floor(engine.readView().zoom);
      if (zoom === overlayZoom) return;
      overlayZoom = zoom;
      this.refreshOverlay();
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
    const pointer =
      (type: "click" | "mousemove" | "mousedown" | "mouseup") => (event: ArcgisViewEvent) => {
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
      view.on("pointer-down", pointer("mousedown")),
      view.on("pointer-up", pointer("mouseup")),
    ])
      this.cleanup.push(() => handle.remove());
    if (view.container && typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => facade.fire("resize"));
      observer.observe(view.container);
      this.cleanup.push(() => observer.disconnect());
    }
  }
  /**
   * The MapLibre-shaped facade controls receive, for a control mounted outside
   * the view's UI (a docked panel) that still needs a map to talk to.
   */
  /**
   * Redraw the controls' own GeoJSON overlays (the shadow style's layers no
   * store layer mirrors). The engine calls it after a layer sync, since a
   * store record registered or dropped changes which layers are mirrored.
   */
  refreshOverlay(): void {
    // A control torn down with the view edits its style on the way out; the
    // redraw that queues must not add a layer to the dying map.
    if (this.destroyed || this.overlayQueued) return;
    this.overlayQueued = true;
    queueMicrotask(() => {
      this.overlayQueued = false;
      if (!this.destroyed) this.drawOverlay();
    });
  }
  private drawOverlay(): void {
    const map = this.view.map;
    if (!map) return;
    const graphics = shadowOverlayGraphics(
      this.peekShadow(),
      this.engine.readView().zoom,
      this.hooks.isMirrored,
    );
    this.overlayGraphics = graphics;
    if (!graphics.length && !this.overlay) return;
    if (!this.overlay) {
      this.overlay = new this.sdk.layers.GraphicsLayer({
        title: "Plugin overlays",
        listMode: "hide",
      });
      map.add(this.overlay);
    }
    const drawn = graphics.flatMap((graphic) => {
      const geometry = this.hooks.toGeometry(graphic.geometry);
      return geometry ? [new this.sdk.Graphic({ geometry, symbol: graphic.symbol })] : [];
    });
    this.overlay.graphics?.removeAll();
    this.overlay.graphics?.addMany(drawn);
  }
  getControlMap(): MapLibreMap {
    return this.facade as unknown as MapLibreMap;
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
    this.destroyed = true;
    this.facade.fire("remove");
    if (this.overlay) {
      this.view.map?.remove(this.overlay);
      this.overlay.destroy();
      this.overlay = null;
    }
    for (const control of [...this.controls.keys(), ...this.adapted.keys()])
      this.removeControl(control);
    for (const dispose of this.cleanup) dispose();
    this.cleanup = [];
  }
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

/** What the engine lends its control host: its store layers' picking and geometry. */
export interface ArcgisControlHostHooks {
  /** Hits on the store layers mirroring a control's layer (see `NativeLayerPicker`). */
  pick: NativeLayerPicker;
  /** Whether a store layer draws a control's style layer, so the overlay must not. */
  isMirrored: (layerId: string, sourceId: string) => boolean;
  /** Pick tolerance in degrees of longitude at a point, as the engine's identify uses. */
  tolerance: (lngLat: [number, number]) => number;
  toGeometry: (geometry: Geometry) => ArcgisGeometryJson | null;
}

const NO_HOOKS: ArcgisControlHostHooks = {
  pick: () => [],
  isMirrored: () => false,
  tolerance: () => 0,
  toGeometry: () => null,
};

/**
 * A handler whose `disable()` holds a view listener that stops the gesture
 * (`install`), released again by `enable()`.
 */
function blockingHandler(install: () => { remove(): void }) {
  let block: { remove(): void } | null = null;
  return {
    enable: () => {
      block?.remove();
      block = null;
    },
    disable: () => {
      block ??= install();
    },
    isEnabled: () => block === null,
    isActive: () => false,
  };
}
