import { disposeArcgisControlAdapters } from "./arcgis-control-adapters";
import { ArcgisControlHost, type ArcgisControlHostHooks } from "./arcgis-control-host";
import { createArcgisScaleBar, type ArcgisScaleBar } from "./arcgis-scale-bar";
import type * as maplibregl from "maplibre-gl";
import type { Position } from "geojson";
import {
  type MapPreferences,
  type MapProjection,
  type StoryChapterAnimation,
  type StoryChapterLocation,
} from "@geolibre/core";
import {
  DEFAULT_BUILT_IN_CONTROL_VISIBILITY,
  type BuiltInMapControl,
  type CameraIdleEvent,
  type ExtentDrawingOptions,
  type ManualPlacementOptions,
  type MapEngine,
  type MapExtent,
  type MapRenderSurface,
} from "./map-engine";
import { zoomToScale } from "./arcgis-layers";
import {
  redactArcgisError,
  type ArcgisGeometryJson,
  type ArcgisHandle,
  type ArcgisLayer,
  type ArcgisMap,
  type ArcgisSdk,
  type ArcgisView,
  type ArcgisWidget,
} from "./arcgis-sdk";
import { drawExtentOnCanvas } from "./extent-drawing";
import {
  type ArcgisEngineMessages,
  DEFAULT_ARCGIS_MESSAGES,
  type ArcgisEngineOptions,
} from "./arcgis-engine-base";
import { viewZoom, scaleForZoom, reportGoToFailure } from "./arcgis-engine-camera";
import { HIT_TOLERANCE_PX, geojsonToArcgisGeometry } from "./arcgis-engine-identify";
import { ArcgisEngineBasemap } from "./arcgis-engine-basemap";
export { geojsonToArcgisGeometry } from "./arcgis-engine-identify";
export { ARCGIS_WORLD_ELEVATION_URL } from "./arcgis-engine-terrain";
export {
  ARCGIS_CAPABILITIES,
  ARCGIS_DECK_CAPABILITIES,
  type ArcgisEngineMessages,
  arcgisPointLngLat,
  bearingToRotation,
  rotationToBearing,
  type ArcgisEngineOptions,
} from "./arcgis-engine-base";

/**
 * The built-in controls the SDK has a widget for, the globe toggle (a DOM
 * button), terrain (a scene setting with no button, as on Mapbox and Cesium),
 * plus attribution, which the view draws itself (`attributionVisible`) and
 * which cannot be turned off.
 */
const HOSTED_CONTROLS: ReadonlySet<BuiltInMapControl> = new Set<BuiltInMapControl>([
  "layer-control",
  "navigation",
  "fullscreen",
  "compass",
  "geolocate",
  "globe",
  "terrain",
  "scale",
  "attribution",
]);

/**
 * Order within a corner, matching MapLibre: `MapController.init` adds the
 * built-ins in this order, and the layer control mounts after them once the
 * style loads.
 */
const HOSTED_CONTROL_ORDER: readonly BuiltInMapControl[] = [
  "fullscreen",
  "compass",
  "navigation",
  "geolocate",
  "globe",
  "scale",
  "layer-control",
];

/**
 * How an ArcGIS pane renders: a flat `MapView`, or a `SceneView` that is
 * either a globe (`global`) or a flat 3D map (`local`).
 */
export type ArcgisSceneMode = "2d" | "global" | "local";

/**
 * The view an ArcGIS pane needs for the project's map preferences.
 *
 * The SDK splits what MapLibre does in one map across two view classes: a
 * `MapView` cannot tilt, draw a globe or drape terrain, and a `SceneView`
 * does all three. So the globe projection selects a global scene, terrain on
 * a Mercator map selects a local (projected) scene, and only a Mercator map
 * without terrain stays a `MapView`. A flat map in a projection other than
 * Web Mercator (issue #2708) is always a `MapView`: a local scene cannot use
 * it, so terrain is set aside there. The canvas rebuilds the view when the
 * answer changes.
 */
export function arcgisSceneMode(
  projection: MapProjection,
  terrainEnabled: boolean,
  customProjection = false,
): ArcgisSceneMode {
  if (projection === "globe") return "global";
  return terrainEnabled && !customProjection ? "local" : "2d";
}

/** Keys the SDK's keyboard navigation moves the camera with. */
const CAMERA_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "+",
  "-",
  "=",
  "_",
  "PageUp",
  "PageDown",
  "a",
  "A",
  "d",
  "D",
  "w",
  "W",
  "s",
  "S",
  "n",
  "N",
  // SceneView only: move the camera up (U) and down (J), and look at the
  // point under the pointer (P).
  "j",
  "J",
  "u",
  "U",
  "p",
  "P",
]);

const SVG_NS = "http://www.w3.org/2000/svg";

/** A 16px outline globe, the size of the SDK's own widget icons. */
function createGlobeGlyph(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  const circle = document.createElementNS(SVG_NS, "circle");
  circle.setAttribute("cx", "8");
  circle.setAttribute("cy", "8");
  circle.setAttribute("r", "6.5");
  const meridians = document.createElementNS(SVG_NS, "ellipse");
  meridians.setAttribute("cx", "8");
  meridians.setAttribute("cy", "8");
  meridians.setAttribute("rx", "2.75");
  meridians.setAttribute("ry", "6.5");
  const parallels = document.createElementNS(SVG_NS, "path");
  parallels.setAttribute("d", "M1.5 8h13M2.6 4.75h10.8M2.6 11.25h10.8");
  svg.append(circle, meridians, parallels);
  return svg;
}

/**
 * The on-map globe/Mercator toggle. The SDK has no such widget, so this is a
 * plain button carrying MapLibre's `GlobeControl` state classes, as the Mapbox
 * engine's toggle does. It wears Esri's widget classes and draws its glyph in
 * `currentColor`, so the SDK theme sizes and colours it like the widgets
 * beside it in both light and dark mode.
 * Toggling rebuilds the view (a `MapView` cannot become a globe), which is the
 * canvas's job; the button only reports the click.
 */
function createGlobeToggle(
  projection: MapProjection,
  onToggle: (projection: MapProjection) => void,
): ArcgisWidget {
  const container = document.createElement("div");
  container.className = "esri-widget geolibre-arcgis-globe";
  const button = document.createElement("button");
  button.type = "button";
  button.append(createGlobeGlyph());
  let globe = projection === "globe";
  const paint = () => {
    button.className = `esri-widget--button ${globe ? "maplibregl-ctrl-globe-enabled" : "maplibregl-ctrl-globe"}`;
    const label = globe ? "Disable globe" : "Enable globe";
    button.title = label;
    button.setAttribute("aria-label", label);
  };
  paint();
  button.addEventListener("click", () => {
    // Repaint at once: the rebuilt view takes a moment to appear, and until
    // then this button (on the outgoing view) is the only sign of the click.
    globe = !globe;
    paint();
    onToggle(globe ? "globe" : "mercator");
  });
  container.append(button);
  return { uiComponent: container, destroy: () => container.remove() };
}

/**
 * Which zoom-level scheme the view is in, as the power of two its levels are
 * offset by from the standard scheme; changes only when the basemap does.
 */
function levelScheme(view: ArcgisView): number {
  return view.zoom >= 0 && view.scale > 0
    ? Math.round(Math.log2(scaleForZoom(view, 0) / zoomToScale(0)))
    : 0;
}

/** Whether an SDK error is a cancelled request rather than a failure. */
function isAbortError(error: { name?: string; message?: string } | null | undefined): boolean {
  return (
    error?.name === "AbortError" ||
    error?.name === "view:goto-interrupted" ||
    /^aborted$/i.test(error?.message?.trim() ?? "")
  );
}

// ArcgisEngine is split by concern across an inheritance chain, each layer in
// its own module: ArcgisEngineBase (handles, bookkeeping, coordinates) <-
// ArcgisEngineTerrain <- ArcgisEngineCamera (view, navigation, fits) <-
// ArcgisEngineIdentify (identify and highlight) <- ArcgisEngineLayers (layer
// sync) <- ArcgisEngineBasemap (basemap and story opacity) <- ArcgisEngine
// (construction, built-in controls, events, capture and teardown). A formerly
// private member another layer reads is `protected`; the rest keep their
// visibility.
/**
 * The ArcGIS Maps SDK for JavaScript behind the shared {@link MapEngine}
 * surface. Construction (loading the SDK from the CDN, building the `Map` and
 * `MapView`) is the canvas component's job; everything after it is here.
 */
export class ArcgisEngine extends ArcgisEngineBasemap implements MapEngine {
  private builtInControls = new Map<BuiltInMapControl, ArcgisWidget>();
  private compassLabel: string | undefined;
  /** Bumped by every story camera move, so a superseded move never starts a rotation. */
  private storyCameraToken = 0;
  /** Open `suspendNavigation` holds; Ctrl-drag steering waits for none. */
  private navigationSuspensions = 0;
  private zoomWatch: ArcgisHandle | null = null;

  constructor(sdk: ArcgisSdk, map: ArcgisMap, view: ArcgisView, options: ArcgisEngineOptions = {}) {
    super();
    this.sdk = sdk;
    this.options = options;
    this.map = map;
    this.view = view;
    this.compiledZoom = Math.round(viewZoom(view));
    this.controlVisibility = {
      ...DEFAULT_BUILT_IN_CONTROL_VISIBILITY,
      ...options.controlVisibility,
      // Esri's terms require attribution; an override cannot hide it.
      attribution: true,
    };
    this.controlPositions = { ...this.controlPositions, ...options.controlPositions };
    this.surface = {
      getCanvas: () => this.canvas(),
      getContainer: () => view.container ?? document.createElement("div"),
      getBearing: () => this.bearing(),
      project: (p) => {
        const screen = this.view?.toScreen(this.point(p));
        return screen ? { x: screen.x, y: screen.y } : { x: 0, y: 0 };
      },
      unproject: (p) => {
        const lngLat = this.lngLatOf(this.view?.toMap({ x: p[0], y: p[1] }));
        return lngLat ? { lng: lngLat[0], lat: lngLat[1] } : null;
      },
      redraw: () => {},
    };
    // The SDK's default UI components (zoom on older releases) are replaced by
    // the built-in set the Controls menu governs. Attribution is not a
    // component in 5.x: the view draws it itself while `attributionVisible`
    // is on, which Esri's terms require alongside its basemaps.
    view.ui.components = [];
    view.attributionVisible = true;
    for (const id of HOSTED_CONTROL_ORDER)
      if (this.controlVisibility[id]) this.mountBuiltInControl(id);
    this.handles.add(
      view.on("layerview-create-error", (event) => {
        const layer = event.layer as ArcgisLayer | undefined;
        const error = event.error as { message?: string; name?: string } | undefined;
        // A restyle rebuilds the native layers, and the SDK reports the
        // outgoing layer's cancelled load as an error ("Aborted") — routine,
        // not a failure. The same goes for any layer the engine no longer
        // tracks: it was removed on purpose.
        if (isAbortError(error)) return;
        const storeId = layer ? this.storeIdFor(layer) : undefined;
        if (!storeId) return;
        this.errors.set(
          `layer:${storeId}`,
          `${layer?.title ?? "Layer"}: ${redactArcgisError(error?.message ?? "failed to load")}`,
        );
      }),
    );
    // The user taking the camera ends a story move: the settle that follows is
    // theirs, and viewport history and collaboration must record it.
    for (const type of ["drag", "mouse-wheel", "double-click"] as const)
      this.handles.add(
        view.on(type, () => {
          this.storyMove = false;
        }),
      );
    this.handles.add(this.bindCtrlDragRotate(view));
    // Only the keys that move the camera; a Shift press does not.
    this.handles.add(
      view.on("key-down", (event) => {
        if (CAMERA_KEYS.has((event as { key?: string }).key ?? "")) this.storyMove = false;
      }),
    );
    // A string, so the camera's own changes (the scheme reads the zoom and
    // scale) re-evaluate the getter without re-running the callback.
    this.handles.add(
      sdk.reactiveUtils.watch(
        () => `${view.ready}|${view.width}|${view.height}|${levelScheme(view)}`,
        () => this.applyNavigationLimits(),
      ),
    );
    // The project's zoom range on a flat view (see `applyNavigationLimits`):
    // a wheel step past a limit the view is at is dropped, and one that
    // overshoots a limit is eased back once the view settles.
    this.handles.add(
      view.on("mouse-wheel", (event) => {
        if (view.type !== "2d") return;
        const deltaY = event.deltaY ?? 0;
        const zoom = viewZoom(view);
        const { minZoom, maxZoom } = this.zoomRange();
        if ((deltaY > 0 && zoom <= minZoom + 0.01) || (deltaY < 0 && zoom >= maxZoom - 0.01))
          event.stopPropagation();
      }),
    );
    // Expressions baked at one zoom are re-evaluated when the integer zoom
    // changes, the way MapLibre would evaluate `["zoom"]` live.
    this.zoomWatch = sdk.reactiveUtils.when(
      () => view.stationary,
      () => {
        if (!this.view) return;
        this.constrainSettledView();
        const zoom = Math.round(viewZoom(this.view));
        if (zoom === this.compiledZoom) return;
        this.compiledZoom = zoom;
        if ([...this.natives.values()].some((n) => n.plan.zoomDependent))
          this.syncLayers(this.layers);
      },
    );
  }

  /**
   * Replace the engine's user-facing messages (translated by the app). Errors
   * already reported are rewritten on the next sync.
   */
  setMessages(messages: Partial<ArcgisEngineMessages>): void {
    this.messages = { ...DEFAULT_ARCGIS_MESSAGES, ...messages };
    if (this.map) this.syncLayers(this.layers);
  }
  /**
   * MapLibre's Ctrl+drag: horizontal movement rotates and vertical movement
   * tilts, at MapLibre's rates. The SDK binds neither to a modifier (a scene
   * orbits on right-drag), so a Ctrl drag steers the camera itself. A flat
   * `MapView` only rotates.
   *
   * @param view The view whose drags to steer.
   * @returns The handle that removes the listener.
   */
  private bindCtrlDragRotate(view: ArcgisView): ArcgisHandle {
    // The camera the drag steers to, accumulated from the drag's start: an
    // unanimated goTo may not have landed before the next update, so reading
    // the live camera each time would drop part of the movement.
    let drag: { x: number; y: number; bearing: number; pitch: number } | null = null;
    return view.on("drag", (event) => {
      if (event.action === "start") {
        const native = event.native as MouseEvent | undefined;
        drag =
          native?.ctrlKey && (event.button ?? 0) === 0 && this.navigationSuspensions === 0
            ? {
                x: event.x,
                y: event.y,
                bearing: this.bearing(),
                pitch: this.sceneView()?.camera?.tilt ?? 0,
              }
            : null;
      }
      if (!drag) return;
      event.stopPropagation();
      const dx = event.x - drag.x;
      const dy = event.y - drag.y;
      const steer = drag;
      if (event.action === "end") drag = null;
      if (dx === 0 && dy === 0) return;
      steer.x = event.x;
      steer.y = event.y;
      // Suspended mid-drag: keep the gesture from reaching the SDK and hold
      // the camera, discarding the movement so resuming does not jump.
      if (this.navigationSuspensions > 0) return;
      steer.bearing += dx * 0.8;
      // Clamped as it accumulates, so reversing from the limit responds at once.
      steer.pitch = this.clampPitch(steer.pitch - dy * 0.5);
      const target = this.orientation(steer.bearing, steer.pitch);
      void this.view?.goTo(target, { animate: false }).catch(reportGoToFailure);
    });
  }

  // ---------------------------------------------------------------- lifecycle

  destroy(): void {
    const view = this.view;
    if (!view) return;
    this.stopCamera();
    clearTimeout(this.storyMoveLapse);
    for (const id of [...this.storyFades.keys()]) this.cancelStoryFade(id);
    this.controlHost?.destroy();
    this.controlHost = null;
    disposeArcgisControlAdapters(view);
    for (const dispose of this.disposers) dispose();
    this.disposers.clear();
    for (const handle of this.handles) handle.remove();
    this.handles.clear();
    this.zoomWatch?.remove();
    this.zoomWatch = null;
    this.clearFeatureHighlight();
    this.removeElevation();
    this.cogTerrainRequest++;
    this.cogTerrain?.dispose();
    void this.cogTiler?.then((tiler) => tiler.clear()).catch(() => {});
    this.cogTiler = null;
    this.cogUrls.clear();
    this.cogTerrain = null;
    for (const id of [...this.natives.keys()]) this.removeLayer(id);
    for (const widget of this.builtInControls.values()) widget.destroy();
    this.builtInControls.clear();
    // Destroying the view does not destroy the map; the map owns the layers.
    view.destroy();
    this.map?.destroy();
    this.view = null;
    this.map = null;
    this.surface = null;
  }
  applyStoryChapterCamera(
    location: StoryChapterLocation,
    animation: StoryChapterAnimation = "flyTo",
    rotate = false,
    onArrive?: () => void,
  ): void {
    this.stopCamera();
    const view = this.view;
    if (!view) {
      onArrive?.();
      return;
    }
    this.markStoryMove();
    const token = this.storyCameraToken;
    void view
      .goTo(
        {
          ...(location.center ? { center: location.center } : {}),
          ...(location.zoom !== undefined ? this.zoomTarget(location.zoom) : {}),
          ...this.orientation(location.bearing, location.pitch),
        },
        { duration: animation === "jumpTo" ? 0 : 800, animate: animation !== "jumpTo" },
      )
      .then(() => {
        // A later chapter (or any camera stop) superseded this move while it
        // flew; its rotation would otherwise orbit the wrong chapter.
        if (!this.view || token !== this.storyCameraToken) return;
        onArrive?.();
        if (rotate && this.view && token === this.storyCameraToken) this.rotate();
      })
      .catch((error: unknown) => {
        reportGoToFailure(error);
        if (
          this.view &&
          token === this.storyCameraToken &&
          !isAbortError(error as Parameters<typeof isAbortError>[0])
        )
          onArrive?.();
      });
  }
  readProjection(): MapProjection {
    return this.sceneView()?.viewingMode === "global" ? "globe" : "mercator";
  }
  applyMapPreferences(p: MapPreferences): void {
    this.preferences = p;
    if (!this.view) return;
    this.setTerrainEnabled(p.terrainEnabled);
    (this.builtInControls.get("scale") as ArcgisScaleBar | undefined)?.setUnit(p.scaleUnit);
    this.applyNavigationLimits();
  }

  /** What the control host borrows from the engine to pick and draw. */
  private controlHostHooks(): ArcgisControlHostHooks {
    return {
      pick: (lngLat, nativeLayerId, sourceId) =>
        this.pickNativeLayer(lngLat, nativeLayerId, sourceId),
      isMirrored: (nativeLayerId, sourceId) => this.mirrorsOf(nativeLayerId, sourceId).length > 0,
      tolerance: (lngLat) => this.degreesPerPixel(lngLat[1]) * HIT_TOLERANCE_PX,
      toGeometry: geojsonToArcgisGeometry,
    };
  }

  /**
   * Keep a DOM element pinned to a geographic location as the view moves.
   * Returns the element's teardown.
   */
  private anchorElement(
    element: HTMLElement,
    lngLat: () => [number, number],
    offset: { x: number; y: number } = { x: 0, y: 0 },
  ): () => void {
    const view = this.view;
    if (!view?.container) return () => {};
    element.style.position = "absolute";
    element.style.zIndex = "5";
    view.container.append(element);
    const place = () => {
      const screen = this.view?.toScreen(this.point(lngLat()));
      if (!screen) return;
      element.style.left = `${screen.x + offset.x}px`;
      element.style.top = `${screen.y + offset.y}px`;
    };
    place();
    const handle = this.sdk.reactiveUtils.watch(() => viewPlacementState(view), place);
    return () => {
      handle.remove();
      element.remove();
    };
  }
  startManualPlacement(lngLat: [number, number], options: ManualPlacementOptions): () => void {
    const view = this.view;
    const map = this.map;
    if (!view || !map) return () => {};
    let position: [number, number] = lngLat;
    const layer = new this.sdk.layers.GraphicsLayer({ listMode: "hide" });
    const pin = new this.sdk.Graphic({
      geometry: geojsonToArcgisGeometry({ type: "Point", coordinates: position })!,
      symbol: {
        type: "simple-marker",
        style: "circle",
        color: [59, 130, 246, 1],
        size: "16px",
        outline: { color: [255, 255, 255, 1], width: "2px" },
      },
    });
    layer.graphics!.add(pin);
    map.add(layer);
    const content = document.createElement("div");
    content.className = "geolibre-arcgis-placement";
    const hint = document.createElement("p");
    hint.textContent = options.hint;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = options.doneLabel;
    content.append(hint, button);
    const unanchor = this.anchorElement(content, () => position, { x: 12, y: -12 });
    let dragging = false;
    const drag = view.on("drag", (event) => {
      if (event.action === "start") {
        const origin = { x: event.x, y: event.y };
        const start = view.toScreen(pin.geometry as ArcgisGeometryJson);
        if (start && Math.hypot(start.x - origin.x, start.y - origin.y) < 16) {
          dragging = true;
          event.stopPropagation();
        }
        return;
      }
      if (!dragging) return;
      event.stopPropagation();
      const lngLat = this.lngLatOf(view.toMap({ x: event.x, y: event.y }));
      if (lngLat) {
        position = lngLat;
        pin.geometry = geojsonToArcgisGeometry({ type: "Point", coordinates: position });
      }
      if (event.action === "end") {
        dragging = false;
        options.onMove(position);
      }
    });
    const dispose = () => {
      drag.remove();
      unanchor();
      if (this.map?.layers.includes(layer)) this.map.remove(layer);
      layer.destroy();
      this.disposers.delete(dispose);
    };
    button.onclick = () => {
      options.onMove(position);
      dispose();
      options.onDone?.();
    };
    this.disposers.add(dispose);
    return dispose;
  }
  drawExtent(options: ExtentDrawingOptions): () => void {
    const view = this.view;
    if (!view) return () => {};
    const stop = drawExtentOnCanvas(
      this.canvas(),
      (p) => {
        // A corner outside the projection's domain is no location; the
        // drawing ignores it (or cancels, on release) rather than using one.
        return this.lngLatOf(view.toMap({ x: p.x, y: p.y }));
      },
      () => this.suspendNavigation(),
      options,
    );
    const dispose = () => {
      stop();
      this.disposers.delete(dispose);
    };
    this.disposers.add(dispose);
    return dispose;
  }
  showExtent(extent: MapExtent): () => void {
    const map = this.map;
    if (!map) return () => {};
    const [w, s, e, n] = extent;
    const ring: Position[] = [
      [w, s],
      [e, s],
      [e, n],
      [w, n],
      [w, s],
    ];
    const layer = new this.sdk.layers.GraphicsLayer({
      listMode: "hide",
      graphics: [
        new this.sdk.Graphic({
          geometry: geojsonToArcgisGeometry({ type: "LineString", coordinates: ring })!,
          symbol: { type: "simple-line", color: [245, 158, 11, 1], width: "3px" },
        }),
      ],
    });
    map.add(layer);
    const dispose = () => {
      if (this.map?.layers.includes(layer)) this.map.remove(layer);
      layer.destroy();
      this.disposers.delete(dispose);
    };
    this.disposers.add(dispose);
    return dispose;
  }
  getRenderSurface(): MapRenderSurface | null {
    return this.surface;
  }
  getRenderStatus(): { pending: string[]; errors: string[] } {
    const pending: string[] = [];
    if (!this.view?.ready || this.view.updating) pending.push("ArcGIS map loading");
    for (const entry of this.natives.values())
      for (const native of entry.layers)
        if (native.loadStatus === "failed" && native.loadError && !isAbortError(native.loadError)) {
          const key = `layer:${entry.plan.id}`;
          if (!this.errors.has(key))
            this.errors.set(
              key,
              `${entry.plan.title}: ${redactArcgisError(native.loadError.message)}`,
            );
        }
    return { pending, errors: [...this.errors.values()] };
  }
  /**
   * The store layers that failed to load, as the last {@link getRenderStatus}
   * call left them. A plugin layer the SDK cannot draw is left out: it is
   * unsupported here, not broken, and the banner already says so.
   *
   * @returns Each failing layer's store id mapped to its render-status message.
   */
  getLayerLoadErrors(): Map<string, string> {
    const failures = new Map<string, string>();
    for (const [key, message] of this.errors) {
      if (!key.startsWith("layer:")) continue;
      const id = key.slice(6);
      if (this.pluginLayerIds.has(id)) continue;
      failures.set(id, message);
    }
    return failures;
  }
  async captureImage(): Promise<Blob> {
    const view = this.view;
    if (!view) throw new Error("ArcGIS map is not available");
    const shot = await view.takeScreenshot({ format: "png", ignorePadding: true });
    const response = await fetch(shot.dataUrl);
    return response.blob();
  }
  onMapClick(listener: (lngLat: [number, number]) => void): () => void {
    const view = this.view;
    if (!view) return () => {};
    const handle = view.on("click", (event) => {
      const lngLat = this.lngLatOf(view.toMap({ x: event.x, y: event.y }));
      if (lngLat) listener(lngLat);
    });
    this.handles.add(handle);
    return () => {
      handle.remove();
      this.handles.delete(handle);
    };
  }
  isCameraMoving(): boolean {
    return this.view ? !this.view.stationary : false;
  }
  onCameraMove(listener: () => void): () => void {
    const view = this.view;
    if (!view) return () => {};
    const handle = this.sdk.reactiveUtils.watch(
      () => viewPlacementState(view),
      () => listener(),
    );
    this.handles.add(handle);
    return () => {
      handle.remove();
      this.handles.delete(handle);
    };
  }
  /**
   * Unlike ArcgisCanvas's module-level `whenDrawn`, which waits for the
   * basemap only (for the loading indicator), this waits for the whole view,
   * data layers included, as a capture needs.
   */
  whenDrawn(timeoutMs: number): Promise<void> {
    const view = this.view;
    if (!view) return Promise.resolve();
    return new Promise((resolve) => {
      let finished = false;
      let handle: ArcgisHandle | undefined;
      let frame = 0;
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        cancelAnimationFrame(frame);
        if (handle) {
          handle.remove();
          this.handles.delete(handle);
        }
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      // Two frames first, as the canvas's own whenDrawn waits: right after a
      // jump the layer views have not scheduled the new extent's tiles, and
      // `updating` still reads false.
      frame = requestAnimationFrame(
        () =>
          (frame = requestAnimationFrame(() => {
            if (finished || this.view !== view) return done();
            handle = this.sdk.reactiveUtils.when(() => view.stationary && !view.updating, done, {
              initial: true,
            });
            // Torn down with the view, like the class's other subscriptions.
            if (finished) handle.remove();
            else this.handles.add(handle);
          })),
      );
    });
  }
  onCameraIdle(listener: (event?: CameraIdleEvent) => void): () => void {
    const view = this.view;
    if (!view) return () => {};
    const handle = this.sdk.reactiveUtils.when(
      () => view.stationary,
      () => {
        const storyCamera = this.storyMove;
        // Every subscriber sees the same answer for this settle; the flag
        // clears once they all have.
        queueMicrotask(() => {
          if (this.view?.stationary !== false) this.storyMove = false;
        });
        listener({ storyCamera });
      },
    );
    this.handles.add(handle);
    return () => {
      handle.remove();
      this.handles.delete(handle);
    };
  }
  stopCamera(): void {
    this.stopStoryCamera();
  }
  stopStoryCamera(): void {
    this.storyCameraToken++;
    // Stopping the animation settles an in-flight goTo where it is.
    (this.view?.animation as { stop?: () => void } | null | undefined)?.stop?.();
  }
  suspendNavigation(): () => void {
    const view = this.view;
    if (!view) return () => {};
    const wheel = view.navigation.mouseWheelZoomEnabled;
    const touch = view.navigation.browserTouchPanEnabled;
    view.navigation.mouseWheelZoomEnabled = false;
    view.navigation.browserTouchPanEnabled = false;
    const swallow = (event: { stopPropagation(): void }) => event.stopPropagation();
    const handles = [
      view.on("drag", swallow),
      view.on("double-click", swallow),
      view.on("key-down", swallow),
      view.on("mouse-wheel", swallow),
    ];
    this.navigationSuspensions++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.navigationSuspensions--;
      }
      for (const handle of handles) handle.remove();
      if (this.view) {
        this.view.navigation.mouseWheelZoomEnabled = wheel;
        this.view.navigation.browserTouchPanEnabled = touch;
      }
    };
  }

  // ----------------------------------------------------------------- controls

  addControl(control: maplibregl.IControl, position?: maplibregl.ControlPosition): boolean {
    if (!control || !this.view || this.options.domControls === false) return false;
    this.controlHost ??= new ArcgisControlHost(this, this.view, this.sdk, this.controlHostHooks());
    return this.controlHost.addControl(control, position);
  }
  removeControl(control: maplibregl.IControl): void {
    this.controlHost?.removeControl(control);
  }
  /**
   * The MapLibre-shaped map controls on this view receive: camera, events and
   * DOM through the view, and a style that is recorded but never drawn. Null
   * before the view exists or when DOM controls are disabled.
   */
  getControlMap(): maplibregl.Map | null {
    if (!this.view || this.options.domControls === false) return null;
    this.controlHost ??= new ArcgisControlHost(this, this.view, this.sdk, this.controlHostHooks());
    return this.controlHost.getControlMap();
  }
  private createBuiltInControl(id: BuiltInMapControl): ArcgisWidget | null {
    const view = this.view;
    if (!view) return null;
    const { widgets } = this.sdk;
    switch (id) {
      case "layer-control": {
        if (!this.options.onLayerVisibilityChange) return null;
        const list = new widgets.LayerList({ view });
        const expand = new widgets.Expand({ view, content: list });
        return {
          uiComponent: expand,
          destroy: () => {
            expand.destroy();
            list.destroy();
          },
        };
      }
      case "navigation":
        return new widgets.Zoom({ view });
      case "fullscreen":
        return new widgets.Fullscreen({ view, element: view.container ?? undefined });
      case "compass": {
        const compass = new widgets.Compass({
          view,
          ...(this.compassLabel ? { label: this.compassLabel } : {}),
        });
        // The SDK's compass only restores the heading; MapLibre's also levels
        // the pitch, so a click resets both.
        const viewModel = (compass as { viewModel?: { reset?: () => void } }).viewModel;
        if (viewModel) viewModel.reset = () => this.resetNorthPitch();
        return compass;
      }
      case "geolocate":
        return new widgets.Locate({ view });
      case "globe":
        // Only the canvas can rebuild the view in the other projection.
        if (!this.options.onProjectionToggle || typeof document === "undefined") return null;
        return createGlobeToggle(this.readProjection(), this.options.onProjectionToggle);
      case "scale":
        // The 2D map's scale bar: it knows nautical miles and other bodies'
        // radii, and it measures at the centre of a scene too.
        if (typeof document === "undefined") return null;
        return createArcgisScaleBar(
          this.sdk,
          view,
          () => this.getRenderSurface(),
          this.preferences?.scaleUnit ?? "metric",
        );
      default:
        return null;
    }
  }
  private mountBuiltInControl(id: BuiltInMapControl): void {
    if (!this.view || this.builtInControls.has(id)) return;
    const widget = this.createBuiltInControl(id);
    if (!widget) return;
    // The SDK appends by default, so a control mounted after its neighbours
    // (shown again from the Controls menu, or a toggle that lands after the
    // view is built) would drift out of order. Slot it after the built-ins
    // that precede it in the same corner.
    const position = this.controlPositions[id];
    const rank = HOSTED_CONTROL_ORDER.indexOf(id);
    let index = 0;
    for (const other of this.builtInControls.keys()) {
      const otherRank = HOSTED_CONTROL_ORDER.indexOf(other);
      if (otherRank !== -1 && otherRank < rank && this.controlPositions[other] === position)
        index++;
    }
    this.view.ui.add(widget.uiComponent ?? widget, { position, index });
    this.builtInControls.set(id, widget);
  }
  private unmountBuiltInControl(id: BuiltInMapControl): void {
    const widget = this.builtInControls.get(id);
    if (!widget) return;
    this.view?.ui.remove(widget.uiComponent ?? widget);
    widget.destroy();
    this.builtInControls.delete(id);
  }
  setBuiltInControlVisible(id: BuiltInMapControl, visible: boolean): boolean {
    if (!this.view) return false;
    if (!HOSTED_CONTROLS.has(id)) return false;
    if (id === "attribution") {
      // Always on; the view renders it from `attributionItems`.
      if (this.view) this.view.attributionVisible = true;
      return visible;
    }
    // Terrain has no button: it is the scene's elevation, and turning it on
    // over a MapView asks the canvas for a SceneView through the preference
    // the Controls menu writes once this reports success.
    if (id === "terrain") {
      this.controlVisibility.terrain = visible;
      this.setTerrainEnabled(visible);
      return true;
    }
    if (id === "globe" && !this.options.onProjectionToggle) return false;
    if (id === "layer-control" && !this.options.onLayerVisibilityChange) return false;
    this.controlVisibility[id] = visible;
    if (visible) this.mountBuiltInControl(id);
    else this.unmountBuiltInControl(id);
    return true;
  }
  getBuiltInControlPosition(id: BuiltInMapControl): maplibregl.ControlPosition {
    return this.controlPositions[id];
  }
  setBuiltInControlPosition(id: BuiltInMapControl, position: maplibregl.ControlPosition): boolean {
    if (!this.view || !HOSTED_CONTROLS.has(id)) return false;
    this.controlPositions[id] = position;
    this.options.onControlPositionChange?.(id, position);
    if (this.builtInControls.has(id)) {
      this.unmountBuiltInControl(id);
      this.mountBuiltInControl(id);
    }
    return true;
  }
  setCompassLabel(label: string): void {
    this.compassLabel = label;
    const compass = this.builtInControls.get("compass") as
      | (ArcgisWidget & { label?: string })
      | undefined;
    if (compass) compass.label = label;
  }
  setBackgroundLabel(): void {}
}

/**
 * What moves a screen-anchored element: the extent and size for both views,
 * plus the rotation of a MapView or the camera of a SceneView (a tilt or
 * heading change moves every screen point without changing the extent much).
 */
export function viewPlacementState(view: ArcgisView): unknown[] {
  return view.type === "3d"
    ? [
        view.extent,
        // Scalar fields rather than the Camera object, so a camera the SDK
        // mutates in place is tracked as surely as a replaced one.
        view.camera?.heading,
        view.camera?.tilt,
        view.camera?.position.x,
        view.camera?.position.y,
        view.camera?.position.z,
        view.width,
        view.height,
      ]
    : [view.extent, view.rotation, view.width, view.height];
}
