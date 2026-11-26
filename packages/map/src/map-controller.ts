import { showGlSearchResult } from "./gl-search-result";
import { resolveMapPixelRatio, watchMapPixelRatio } from "./mobile-pixel-ratio";
import {
  BLANK_BASEMAP,
  DEFAULT_BASEMAP,
  normalizeMapCrs,
  scaleAltitudeToActiveBody,
} from "@geolibre/core";
import type {
  GeoLibreLayer,
  MapPreferences,
  MapViewState,
  StoryChapterAnimation,
  StoryChapterLocation,
} from "@geolibre/core";
import type { Point, Polygon } from "geojson";
import * as maplibregl from "maplibre-gl";
export { layerControlPaintToStyle, restoreControlOrder } from "./layer-control-host";
import { unregisterAllGeoJsonVtSourcesForOwner } from "./geojson-vt-protocol";
import { globeSafeMaxZoom } from "./globe-fit-bounds";
import { drawExtentOnCanvas } from "./extent-drawing";
import { captureEngineImage } from "./map-capture";
import type { CameraIdleEvent, ExtentDrawingOptions, MapExtent } from "./map-engine";
import { installLayerBlendModes } from "./layer-blend-modes";
import { ensureGeneratedImageHandler } from "./generated-images";
import { installSelectionDragGuard } from "./selection-drag-guard";
import { installGlobePopupOcclusion } from "./globe-popup-occlusion";
import { isMapboxStyleUrl } from "./mapbox-style";
import {
  BLANK_BACKGROUND_LAYER_ID,
  createBlankMapStyle,
  defaultBlankBackgroundColor,
  resolveMapStyle,
} from "./basemap-style";
// Moved to ./basemap-style; re-exported so existing importers keep working.
export { defaultBlankBackgroundColor };
import {
  cameraAltitudeFromProjectedCamera,
  installMapTransformCompat,
  type ProjectedCameraLike,
} from "./map-transform-compat";
import { isInitialMapCrsFrameRequested, notifyMapCrsChange } from "./active-map-crs";
import { transformTileRequest } from "./tile-request-headers";
import {
  type BuiltInMapControl,
  DEFAULT_BUILT_IN_CONTROL_VISIBILITY,
  DEFAULT_BUILT_IN_CONTROL_POSITIONS,
  type MapEngine,
} from "./map-engine";
import {
  FIT_BOUNDS_PADDING,
  clampNumber,
  effectiveMinZoomForPreferences,
  tilesetCenter,
  mapBoundsForPreferences,
} from "./map-controller-style";
import { MapControllerHighlight } from "./map-controller-highlight";
export { storyScaledPaintValue } from "./map-controller-layers";
export { geolocateControlFactory, TERRAIN_SETTINGS_CLOSE_EVENT } from "./map-controller-controls";
export { TERRAIN_SETTINGS_EVENT } from "./map-controller-terrain";

// Before any `Map` is constructed: re-expose `map.transform` for the packages
// we do not control that still read it (deck.gl above all). See the module for
// why it cannot wait until a map exists.
installMapTransformCompat();
const DEFAULT_MAX_PITCH = 85;

// Moved to ./map-engine so MapEngine can reference it without importing this
// module; re-exported here because 80-odd files import it from map-controller.
export type { BuiltInMapControl };

// Shared with the other engines from ./map-engine (see the note on
// BuiltInMapControl above); re-exported so existing importers keep working.
export { DEFAULT_BUILT_IN_CONTROL_VISIBILITY, DEFAULT_BUILT_IN_CONTROL_POSITIONS };

// MapController is split by concern across an inheritance chain, each layer in
// its own module: MapControllerBase (map handle, style-layer queries) <-
// MapControllerTerrain <- MapControllerControls (built-in controls) <-
// MapControllerStyle (CRS and style application) <- MapControllerLayers (layer
// sync, basemap and story opacity) <- MapControllerHighlight (identify and
// highlight) <- MapController (init, view, camera, fits and teardown). A member
// another layer reads is `protected`; everything else stays `private`.
export class MapController extends MapControllerHighlight implements MapEngine {
  /** Whether {@link clampViewToPreferences} has a clamp queued on `moveend`. */
  private pendingViewClamp = false;
  /**
   * The store `mapView` objects {@link markStoreEcho} recorded, until their
   * store sync reaches {@link applyStoreView} (issue #3083).
   */
  private storeEchoes = new WeakSet<MapViewState>();
  private blankBackgroundColor: string | null = null;

  init(
    container: HTMLElement,
    options: {
      styleUrl?: string;
      mapView?: MapViewState;
      mapPreferences?: MapPreferences;
      /**
       * Override built-in control visibility before the controls are added.
       * Secondary (split/grid) map panes pass `{ "layer-control": false }` so
       * they don't mount a second layer control that would write the shared
       * layer/basemap state back to the global store.
       */
      controlVisibility?: Partial<Record<BuiltInMapControl, boolean>>;
    },
  ): maplibregl.Map {
    const view = options.mapView;
    if (options.controlVisibility) {
      this.controlVisibility = {
        ...this.controlVisibility,
        ...options.controlVisibility,
      };
    }
    const mapPreferences = options.mapPreferences ?? this.mapPreferences;
    const minZoom = clampNumber(mapPreferences.minZoom, 0, 24);
    const maxZoom = Math.max(minZoom, clampNumber(mapPreferences.maxZoom, 0, 24));
    const maxPitch = clampNumber(mapPreferences.maxPitch, 0, DEFAULT_MAX_PITCH);
    this.mapPreferences = mapPreferences;
    this.basemapStyleUrl = options.styleUrl ?? DEFAULT_BASEMAP;
    // A Mapbox descriptor has to be fetched and rewritten before MapLibre will
    // take it (see applyStyleToMap), which the Map constructor cannot wait for.
    // Start blank and apply it below, as soon as the listeners are wired — the
    // path a project saved with a Mapbox basemap and a split-view pane both take.
    const deferMapboxStyle = isMapboxStyleUrl(this.basemapStyleUrl);
    // A map in a custom CRS also starts blank: its style is built once the CRS
    // resolves (syncMapCrs below), so the Web Mercator basemap never loads.
    const deferCrsStyle = normalizeMapCrs(mapPreferences.mapCrs) !== undefined;
    this.crsStyleDeferred = deferCrsStyle;
    this.map = new maplibregl.Map({
      container,
      style:
        deferMapboxStyle || deferCrsStyle
          ? createBlankMapStyle()
          : resolveMapStyle(this.basemapStyleUrl),
      center: view?.center ?? [-100, 40],
      zoom: view?.zoom ?? 2,
      bearing: view?.bearing ?? 0,
      pitch: view?.pitch ?? 0,
      minZoom,
      maxZoom,
      maxPitch,
      maxBounds: mapBoundsForPreferences(mapPreferences) ?? undefined,
      renderWorldCopies: mapPreferences.renderWorldCopies,
      attributionControl: false,
      maplibreLogo: false,
      // The canvases own resizing through the shared scheduler in map-resize.ts
      // (both MapCanvas and SecondaryMapCanvas) because the container also
      // changes when app panels open and close. Letting MapLibre listen to
      // window.resize as well causes competing framebuffer reallocations while
      // a browser window is dragged, briefly exposing a transparent canvas.
      trackResize: false,
      // preserveDrawingBuffer must stay true: the Print Layout composer and any
      // future export feature reads the canvas via drawImage / toDataURL outside
      // of a render callback. Removing this causes blank captures on browsers
      // that discard the drawing buffer after compositing (most mobile GPUs).
      // Trade-off: adds one extra framebuffer copy per frame on tiled renderers.
      canvasContextAttributes: { preserveDrawingBuffer: true },
      pixelRatio: resolveMapPixelRatio(),
      // The map's only request transform: plugins register headers for their
      // tile services rather than replacing it (see tile-request-headers.ts).
      transformRequest: transformTileRequest,
    });
    ensureGeneratedImageHandler(this.map);
    // A leftover text selection would otherwise turn a map drag into a native
    // drag of the selection in WebKit; see selection-drag-guard.ts.
    this.selectionDragGuardDispose?.();
    this.selectionDragGuardDispose = installSelectionDragGuard(this.map.getCanvasContainer());
    this.pixelRatioWatchDispose?.();
    this.pixelRatioWatchDispose = watchMapPixelRatio((ratio) => {
      this.map?.setPixelRatio(ratio);
    });
    installGlobePopupOcclusion(maplibregl);
    // Per-layer blend modes wrap MapLibre's render loop, so they have to be in
    // place before the first frame. Feature-detected: an unsupported build
    // leaves the map untouched and the Style panel hides the control.
    installLayerBlendModes(this.map);
    // The constructor options above already apply the static constraints.
    // The transform constraint is installed by the MapCanvas effect that
    // fires on mount, so calling applyMapPreferences here would only add a
    // redundant jumpTo that can interrupt the initial camera.
    const handleStyleReady = () => {
      this.styleReady = true;
      // Retried here because the constructor call above is a no-op if the
      // painter does not exist yet: it leaves support undecided rather than
      // declaring blending unavailable, and this is the "next call" that
      // resolves it. Idempotent (the wrappers live on shared prototypes and
      // are installed once), so the repeat costs a feature probe.
      if (this.map) installLayerBlendModes(this.map);
      this.enforceProjection();
      this.addTerrainSource();
      // If the Terrain control was switched on before the style finished
      // loading, the DEM source didn't exist yet and auto-enable was deferred;
      // now that the source is in, turn terrain on so the toggle isn't dropped.
      if (this.terrainEnablePending) this.autoEnableTerrain();
      this.applyBasemapVisibility();
      this.applyBasemapOpacity();
      this.setBlankBackgroundColor(this.blankBackgroundColor);
      this.addLayerControl();
      this.restoreHighlight();
    };
    this.map.on("style.load", handleStyleReady);
    this.map.once("load", handleStyleReady);
    this.map.once("idle", () => this.enforceProjection());
    // Plugins can add native style layers directly (outside the layer store);
    // refresh the layer control on style changes so internal-flagged layers are
    // excluded reactively (debounced by the host).
    this.map.on("styledata", () => this.layerControlHost.scheduleStyleRefresh());
    // Add the fullscreen toggle first so it anchors the top of the top-right
    // control cluster, matching the universal placement users expect (issue
    // #512). MapLibre stacks controls in insertion order within a corner.
    this.addFullscreenControl();
    // Added right after fullscreen so, with both at their default top-right
    // position, the compass stacks directly below the fullscreen toggle (the
    // placement requested in issue #508). MapLibre orders controls by insertion
    // within a corner.
    this.addCompassControl();
    this.addNavigationControl();
    this.addGeolocateControl();
    this.addGlobeControl();
    this.addTerrainControl();
    this.addScaleControl();
    this.addAttributionControl();
    this.addLogoControl();
    this.addMaptoolkitLogoControl();
    // Kick off the deferred Mapbox descriptor fetch now that `style.load` and
    // `styledata` are wired, so the real style is treated exactly like a later
    // basemap switch rather than racing the listeners above.
    if (deferMapboxStyle) this.applyStyleToMap(this.basemapStyleUrl);
    // Keep the project's saved view: frame the CRS only on a later switch, or
    // when a link names a CRS and no view.
    this.initialCrsFrame = isInitialMapCrsFrameRequested();
    this.syncMapCrs(this.initialCrsFrame);
    this.guardMapCrsFits(this.map);
    return this.map;
  }

  /**
   * Move the camera to a story chapter view during presentation playback.
   *
   * Cancels any in-progress movement first so a prior chapter's rotation cannot
   * fight the new transition, then optionally starts a slow rotation once the
   * move settles. Keeping this in the controller lets the presenter drive the
   * camera without reaching into the raw MapLibre instance.
   *
   * @param location Target camera (center, zoom, pitch, bearing).
   * @param animation MapLibre camera method to use.
   * @param rotate When true, slowly rotate 180° after the move settles.
   * @param onArrive Runs after the initial transition, before optional rotation.
   */
  applyStoryChapterCamera(
    location: StoryChapterLocation,
    animation: StoryChapterAnimation = "flyTo",
    rotate = false,
    onArrive?: () => void,
  ): void {
    if (!this.map) {
      onArrive?.();
      return;
    }
    const map = this.map;
    // Bump the token first so any pending rotation from a prior chapter is
    // invalidated. We do NOT call map.stop() here: flyTo/easeTo already
    // supersede an in-progress camera animation, and calling stop() immediately
    // before a new movement during rapid chapter changes can drop it entirely.
    const token = ++this.storyCameraToken;
    // Detach any rotate-on-settle listener still waiting on a superseded move so
    // handlers can never accumulate across rapid chapter changes or a presenter
    // exit. The matching listener for the new move is registered below.
    if (this.pendingRotateHandler) {
      map.off("moveend", this.pendingRotateHandler);
      this.pendingRotateHandler = null;
    }
    // Tag the movement so the rotate-on-settle handler can recognize *this*
    // move's `moveend`. When flyTo/easeTo supersedes a prior chapter's in-flight
    // rotation, MapLibre fires a deferred `moveend` for that halted rotation; an
    // untagged `once("moveend")` would catch it and start rotating immediately,
    // around the previous chapter's center, before the new camera has travelled.
    // MapLibre re-fires the original move's eventData on this deferred moveend
    // (Camera._afterEase), so the token survives cancellation. The
    // pendingRotateHandler cleanup above and in restoreLayerStyles is the
    // backstop should that ever change, so handlers cannot leak regardless.
    if (rotate || onArrive) {
      const onMoveEnd = (event: maplibregl.MapLibreEvent & { storyCameraToken?: number }) => {
        // Only detach once the token matches. Stay attached through any
        // preceding moveend (e.g. the deferred moveend of a halted prior
        // rotateTo, which carries no storyCameraToken) so we can still react to
        // this move's own matching moveend below.
        if (event.storyCameraToken !== token) return;
        map.off("moveend", onMoveEnd);
        if (this.pendingRotateHandler === onMoveEnd) {
          this.pendingRotateHandler = null;
        }
        if (this.storyCameraToken !== token || !this.map) return;
        onArrive?.();
        // The callback may pause playback or select another chapter.
        if (rotate && this.storyCameraToken === token && this.map) {
          this.map.rotateTo(this.map.getBearing() + 180, {
            duration: 30000,
            easing: (time) => time,
          });
        }
      };
      this.pendingRotateHandler = onMoveEnd;
      map.on("moveend", onMoveEnd);
    }
    // Register first: jumpTo and reduced-motion transitions settle synchronously.
    map[animation](
      {
        center: location.center,
        zoom: location.zoom,
        pitch: location.pitch,
        bearing: location.bearing,
      },
      { storyCameraToken: token },
    );
  }

  /**
   * Fly the camera to a view, used for story authoring previews.
   *
   * @param location Target camera (center, zoom, pitch, bearing).
   */
  flyToView(location: StoryChapterLocation): void {
    this.storyCameraToken++;
    if (this.pendingRotateHandler) {
      this.map?.off("moveend", this.pendingRotateHandler);
      this.pendingRotateHandler = null;
    }
    this.map?.flyTo(
      {
        center: location.center,
        zoom: location.zoom,
        pitch: location.pitch,
        bearing: location.bearing,
      },
      // Tag as a story camera move (like applyStoryChapterCamera) so viewport
      // history skips this scripted preview rather than recording it.
      { storyCameraToken: this.storyCameraToken },
    );
  }

  destroy(): void {
    this.stopStoryCamera();
    this.storyOpacities.clear();
    for (const dispose of this.searchDisposers) dispose();
    this.extentDrawingDispose?.();
    this.removeNavigationControl();
    this.removeFullscreenControl();
    this.removeCompassControl();
    this.removeGeolocateControl();
    this.removeGlobeControl();
    this.removeTerrainControl();
    // Bumping the generation first invalidates a COG registration still being
    // opened, so it disposes itself instead of attaching to a destroyed map.
    this.cogDemGeneration += 1;
    this.cogDemRegistration?.dispose();
    this.cogDemRegistration = null;
    this.removeScaleControl();
    this.removeAttributionControl();
    this.removeLogoControl();
    this.removeMaptoolkitLogoControl();
    this.layerControlHost.destroy();
    this.abortPendingMapboxStyle();
    this.removeClusterZoomListener();
    this.removePendingNativeFilterListener();
    this.selectionDragGuardDispose?.();
    this.selectionDragGuardDispose = null;
    this.pixelRatioWatchDispose?.();
    this.pixelRatioWatchDispose = null;
    if (this.map) unregisterAllGeoJsonVtSourcesForOwner(this.map);
    this.map?.remove();
    this.map = null;
    this.styleReady = false;
    // A later init() starts from the default map and resolves its CRS afresh;
    // the bump drops a resolution still in flight for this map.
    const hadCrs = this.activeCrs !== null;
    this.activeCrs = null;
    this.activeCrsConverter = null;
    this.desiredCrsId = undefined;
    this.failedCrsId = undefined;
    this.crsStyleDeferred = false;
    this.crsGeneration += 1;
    this.clearLayerDisplayNames();
    if (hadCrs) notifyMapCrsChange();
  }

  setStyle(url: string): void {
    if (!this.map) return;
    this.basemapStyleUrl = url;
    this.applyStyleToMap(url);
    // Switching to/from a planetary basemap changes the active body (the store's
    // ellipsoid subscription runs first, so the singleton is already current),
    // so redraw the scale bar for the new radius without waiting for a pan.
    this.scaleControl?.refresh();
  }

  setBasemapVisible(visible: boolean): void {
    this.basemapVisible = visible;
    this.applyBasemapVisibility();
    this.syncLayerControlState();
  }

  setBasemapOpacity(opacity: number): void {
    this.basemapOpacity = opacity;
    this.applyBasemapOpacity();
    this.syncLayerControlState();
  }

  setBlankBackgroundColor(color: string | null): void {
    this.blankBackgroundColor = color;
    if (this.basemapStyleUrl !== BLANK_BASEMAP || !this.map?.getLayer(BLANK_BACKGROUND_LAYER_ID))
      return;
    this.map.setPaintProperty(
      BLANK_BACKGROUND_LAYER_ID,
      "background-color",
      color ?? defaultBlankBackgroundColor(),
    );
  }

  applyView(view: MapViewState): void {
    if (!this.map) return;
    // jumpTo stop()s drag handlers, so skip while the user is still panning.
    if (this.map.dragPan.isActive() || this.map.dragRotate.isActive()) return;
    this.map.jumpTo(constrainMapView(view, this.mapPreferences, this.map, this.activeCrs !== null));
  }

  /**
   * Record `storeView`, the store's `mapView` object right after the map wrote
   * its own view into the store, as an echo for {@link applyStoreView} to
   * skip. Identity, not camera values, marks the echo: any other store write
   * makes a new object, so a view set from outside always jumps even when its
   * values match one the map reported.
   */
  markStoreEcho(storeView: MapViewState): void {
    this.storeEchoes.add(storeView);
  }

  /**
   * Apply a store view change to the map, except an echo recorded by
   * {@link markStoreEcho}.
   *
   * The map was already at an echoed view, so the jump would do nothing but
   * stop a camera move started since: a plugin's `fitBounds` begun in (or
   * shortly after) the `moveend` that wrote it was cancelled a render later,
   * where it stood (issue #3083). Views set from outside (project load, undo,
   * collaboration, a synced pane) still jump.
   */
  applyStoreView(view: MapViewState): void {
    if (this.storeEchoes.delete(view)) return;
    this.storeViewSinceCrsChange = true;
    this.applyView(view);
  }

  /**
   * Like {@link applyView} but animates the camera (MapLibre `easeTo`) instead
   * of jumping, for browser-style back/forward viewport navigation.
   */
  easeToView(view: MapViewState): void {
    if (!this.map) return;
    this.map.easeTo(constrainMapView(view, this.mapPreferences, this.map, this.activeCrs !== null));
  }

  applyMapPreferences(preferences: MapPreferences): void {
    if (!this.map) return;
    this.mapPreferences = preferences;

    const requestedMinZoom = clampNumber(preferences.minZoom, 0, 24);
    const minZoom = effectiveMinZoomForPreferences(preferences, this.map, requestedMinZoom);
    const maxZoom = Math.max(minZoom, clampNumber(preferences.maxZoom, 0, 24));
    const maxPitch = clampNumber(preferences.maxPitch, 0, DEFAULT_MAX_PITCH);

    // Lower minZoom to an intermediate value first so neither setter ever
    // violates the live min <= max relationship MapLibre validates: this
    // covers both new minZoom > current maxZoom and new maxZoom < current
    // minZoom. Then raise maxZoom and finally apply the real minZoom.
    this.map.setMinZoom(Math.min(minZoom, this.map.getMinZoom()));
    this.map.setMaxZoom(maxZoom);
    this.map.setMinZoom(minZoom);
    this.map.setMaxPitch(maxPitch);
    this.map.setRenderWorldCopies(preferences.renderWorldCopies);
    // Reflect a changed projection preference (e.g. loading a project saved in
    // mercator) onto the live map.
    this.enforceProjection();
    this.applyViewConstraints(minZoom, maxZoom);
    this.syncMapCrs(true);
    this.clampViewToPreferences();
    // The ellipsoid or the scale unit can change here (Settings' dropdowns)
    // without the basemap changing, so push the unit and redraw the body-aware
    // scale bar now — the store's ellipsoid subscription has already updated the
    // active-radius singleton. setUnit only stores the unit, so the single
    // refresh() below redraws the bar once for whatever changed (unit, radius,
    // or both).
    this.scaleControl?.setUnit(preferences.scaleUnit);
    this.scaleControl?.refresh();
    // The side labels are in the scale bar's unit system, and the ellipsoid
    // they are measured on may have changed too.
    if (this.edgeLengthsEnabled && this.highlightedFeatures.length > 0) this.syncEdgeLengths();
  }

  /**
   * Re-apply the current camera so the constraints {@link applyMapPreferences}
   * just installed (min/max zoom, max pitch, max bounds) actually clamp it.
   *
   * `applyView` gets there by jumping, and a jump *stops* an in-flight camera
   * animation, leaving the camera wherever that animation had reached. Map
   * preferences do change mid-animation: loading a LiDAR point cloud flips the
   * projection preference through the deck.gl overlays' shared mercator lock
   * from the very `load` event the plugin fires right after starting its
   * fly-to-the-data, so that fly-to was being cancelled before it had moved a
   * pixel and the layer never came into view. While the camera is moving,
   * clamp once it settles instead — the setters above already constrain the
   * animation's own target, so nothing escapes the new limits in the meantime.
   */
  private clampViewToPreferences(): void {
    if (!this.map) return;
    if (!this.isCameraMoving()) {
      this.applyView(this.readView());
      return;
    }
    // One deferred clamp is enough however many preference changes land during
    // the same movement, and it must not re-arm on the `moveend` its own jump
    // fires.
    if (this.pendingViewClamp) return;
    this.pendingViewClamp = true;
    this.map.once("moveend", () => {
      this.pendingViewClamp = false;
      this.applyView(this.readView());
    });
  }

  readView(): MapViewState {
    if (!this.map) {
      return {
        center: [-100, 40],
        zoom: 2,
        bearing: 0,
        pitch: 0,
      };
    }
    const c = this.map.getCenter();
    const b = this.map.getBounds();
    return {
      center: [c.lng, c.lat],
      zoom: this.map.getZoom(),
      bearing: this.map.getBearing(),
      pitch: this.map.getPitch(),
      bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
    };
  }

  /**
   * The camera's height above sea level in metres — Google Earth Pro's
   * "Eye alt" (issue #1816). Corrected for the active body, since MapLibre
   * computes it from the Earth-based Mercator scale.
   *
   * v6 split `Camera` out of `Map`, moving the transform to `_camera`; v5
   * exposed it on the map itself, and 6.19 replaced the transform with a
   * derived `projectedCamera` whose camera math is not exported. All three are
   * read, and the whole chain is probed defensively: a MapLibre bump that
   * drops or renames any of them should blank the readout, not throw inside a
   * `moveend` handler.
   */
  readCameraAltitude(): number | null {
    const host = this.map as
      | {
          _camera?: {
            transform?: { getCameraAltitude?: () => number };
            projectedCamera?: ProjectedCameraLike;
          };
          transform?: { getCameraAltitude?: () => number };
        }
      | undefined;
    try {
      const transform = host?._camera?.transform ?? host?.transform;
      if (typeof transform?.getCameraAltitude === "function") {
        return scaleAltitudeToActiveBody(transform.getCameraAltitude());
      }
      const altitude = cameraAltitudeFromProjectedCamera(host?._camera?.projectedCamera);
      return altitude === null ? null : scaleAltitudeToActiveBody(altitude);
    } catch {
      return null;
    }
  }

  fitLayer(layer: GeoLibreLayer): boolean {
    if (layer.type === "3d-tiles" && this.map) {
      const center = tilesetCenter(layer);
      // A center off a custom CRS's grid would be clamped to its edge (#3516):
      // fall back to the tileset's bounds, which may still reach the grid.
      const centerOffGrid =
        center !== null && this.isExtentOutsideMapCrs([center[0], center[1], center[0], center[1]]);
      if (centerOffGrid && !this.resolveLayerBounds(layer)) return false;
      if (center && !centerOffGrid) {
        // Tilesets only expose their center, not a native zoom range. Use a
        // conservative floor so city-scale tilesets that render below zoom 18
        // are not flown past into an empty viewport.
        this.map.flyTo({
          center: [center[0], center[1]],
          duration: 800,
          pitch: Math.max(this.map.getPitch(), 60),
          zoom: Math.max(this.map.getZoom(), 14),
        });
        return true;
      }
    }

    const bounds = this.resolveLayerBounds(layer);
    if (!bounds || !this.map) return false;
    const minRenderZoom = this.getLayerMinRenderZoom(layer);
    // On a map in a custom CRS, an extent off the CRS's tile grid cannot be
    // framed: MapLibre clamps the camera to the grid edge (#3516).
    const crsFit = this.fitInMapCrs(bounds, minRenderZoom);
    if (crsFit !== null) return crsFit;
    const box: [[number, number], [number, number]] = [
      [bounds[0], bounds[1]],
      [bounds[2], bounds[3]],
    ];
    // `fitBounds` is built on `cameraForBounds`, so the camera the branches
    // below read back carries the same globe over-zoom on a hemisphere-wide
    // extent. Apply the ceiling to it too, or a world-scale layer is compared
    // (and flown to) at a zoom the map would never actually settle on.
    const fitCeiling = globeSafeMaxZoom(bounds, this.getViewportSize(), FIT_BOUNDS_PADDING);
    const cappedZoom = (zoom: number): number =>
      fitCeiling === null ? zoom : Math.min(zoom, fitCeiling);

    // Tile layers only carry data from their source `minzoom` up (e.g. an OGC
    // API vector tileset served only at z17). Fitting the whole extent would
    // land far below that zoom and render nothing, so when the fit is too far
    // out, fly to the extent center at the layer's minimum render zoom instead.
    if (minRenderZoom !== null) {
      const camera = this.map.cameraForBounds(box, { padding: FIT_BOUNDS_PADDING });
      if (
        camera?.center &&
        typeof camera.zoom === "number" &&
        cappedZoom(camera.zoom) < minRenderZoom
      ) {
        this.map.flyTo({
          center: camera.center,
          zoom: minRenderZoom,
          duration: 800,
        });
        return true;
      }
    }
    // A glTF scenegraph model (e.g. a KML `<Model>`) is a 3D object: viewed
    // straight down it is edge-on and effectively invisible (a vertical
    // geological cross-section shows as a hairline). Frame it at a tilt so it
    // reads as a 3D object on load, pulling back slightly so its vertical extent
    // fits. The user can flatten the pitch afterward.
    if (layer.metadata.customLayerType === "scenegraph") {
      const camera = this.map.cameraForBounds(box, { padding: FIT_BOUNDS_PADDING });
      if (camera?.center && typeof camera.zoom === "number") {
        this.map.flyTo({
          center: camera.center,
          zoom: Math.max(cappedZoom(camera.zoom) - 0.75, 0),
          pitch: 60,
          duration: 800,
        });
        return true;
      }
    }
    this.fitBounds(bounds);
    return true;
  }

  /** The layer's minimum render zoom (its tile source `minzoom`), if advertised
   * — the zoom below which a tile source shows no data. */
  private getLayerMinRenderZoom(layer: GeoLibreLayer): number | null {
    for (const value of [layer.source.minzoom, layer.metadata.minzoom]) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        return value;
      }
    }
    return null;
  }

  private searchDisposers = new Set<() => void>();

  private extentDrawingDispose: (() => void) | null = null;
  private selectionDragGuardDispose: (() => void) | null = null;
  private pixelRatioWatchDispose: (() => void) | null = null;

  getRenderSurface() {
    return this.map;
  }

  getRenderStatus(): { pending: string[]; errors: string[] } {
    const map = this.map;
    if (!map) return { pending: [], errors: ["The map is not available"] };
    return {
      pending:
        map.loaded() && map.areTilesLoaded() && !map.isMoving() ? [] : ["Map tiles and camera"],
      errors: [],
    };
  }

  captureImage(): Promise<Blob> {
    return captureEngineImage(this);
  }

  onMapClick(listener: (lngLat: [number, number]) => void): () => void {
    const map = this.map;
    const onClick = (event: maplibregl.MapMouseEvent) =>
      listener([event.lngLat.lng, event.lngLat.lat]);
    map?.on("click", onClick);
    return () => {
      map?.off("click", onClick);
    };
  }

  isCameraMoving(): boolean {
    return this.map?.isMoving() ?? false;
  }

  onCameraMove(listener: () => void): () => void {
    const map = this.map;
    map?.on("move", listener);
    return () => {
      map?.off("move", listener);
    };
  }

  onCameraIdle(listener: (event?: CameraIdleEvent) => void): () => void {
    const map = this.map;
    const onMoveEnd = (event: maplibregl.MapLibreEvent & { storyCameraToken?: number }) =>
      listener({ storyCamera: event?.storyCameraToken !== undefined });
    map?.on("moveend", onMoveEnd);
    return () => {
      map?.off("moveend", onMoveEnd);
    };
  }
  stopCamera(): void {
    this.stopStoryCamera();
  }
  suspendNavigation(): () => void {
    const map = this.map;
    if (!map) return () => {};
    const handlers = [
      map.dragPan,
      map.boxZoom,
      map.dragRotate,
      map.scrollZoom,
      map.touchZoomRotate,
      map.touchPitch,
      map.doubleClickZoom,
      map.keyboard,
    ];
    const enabled = handlers.map((handler) => handler.isEnabled());
    handlers.forEach((handler) => handler.disable());
    return () =>
      handlers.forEach((handler, index) => {
        if (enabled[index]) handler.enable();
      });
  }

  getViewBounds(): MapExtent | null {
    const bounds = this.map?.getBounds();
    return bounds
      ? [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]
      : null;
  }

  showSearchResult(geometry: Point | Polygon): () => void {
    const map = this.map;
    if (!map) return () => {};
    return showGlSearchResult(
      map,
      geometry,
      (center, color) => new maplibregl.Marker({ color }).setLngLat(center).addTo(map),
      this.searchDisposers,
    );
  }

  showExtent(_extent: MapExtent): () => void {
    // The extraction panels draw their MapLibre overlay above custom layers.
    return () => {};
  }

  drawExtent(options: ExtentDrawingOptions): () => void {
    this.extentDrawingDispose?.();
    const map = this.map;
    if (!map) return () => {};
    this.extentDrawingDispose = drawExtentOnCanvas(
      map.getCanvas(),
      (point) => {
        const location = map.unproject([point.x, point.y]);
        return [location.lng, location.lat];
      },
      () => this.suspendNavigation(),
      options,
    );
    return this.extentDrawingDispose;
  }

  /**
   * Drop a draggable pin at `lngLat` so the user can fine-tune the position of a
   * feature that was just placed without coordinates of its own (e.g. a
   * non-geotagged photo dropped at the map center). Every drag reports the new
   * position through `onMove`; clicking the pin's "Done" button (label supplied
   * by the caller so it stays translatable) removes the pin and runs `onDone`.
   *
   * The pin and its hint popup live outside the React tree, so the interaction
   * survives the dialog that started it being closed. Returns a disposer that
   * removes the pin early (e.g. if the caller needs to abort).
   *
   * @param lngLat - Where to drop the pin, as `[lng, lat]`.
   * @param options - Translated labels plus the move/done callbacks.
   * @returns A function that removes the pin and its popup.
   */
  startManualPlacement(
    lngLat: [number, number],
    options: {
      /** Instruction shown in the pin's popup while it is draggable. */
      hint: string;
      /** Label for the button that finishes placement. */
      doneLabel: string;
      /** Called with `[lng, lat]` on every drag of the pin. */
      onMove: (lngLat: [number, number]) => void;
      /** Called once when the user clicks the "Done" button. */
      onDone?: () => void;
    },
  ): () => void {
    const map = this.map;
    if (!map) return () => {};

    const marker = new maplibregl.Marker({ draggable: true, color: "#ef4444" })
      .setLngLat(lngLat)
      .addTo(map);

    const container = document.createElement("div");
    container.className = "geolibre-placement-popup";
    const hintText = document.createElement("p");
    hintText.className = "geolibre-placement-popup-hint";
    hintText.textContent = options.hint;
    const doneButton = document.createElement("button");
    doneButton.type = "button";
    doneButton.className = "geolibre-placement-popup-done";
    doneButton.textContent = options.doneLabel;
    container.append(hintText, doneButton);

    const popup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 28,
      className: "geolibre-placement-popup-root",
    })
      .setLngLat(lngLat)
      .setDOMContent(container)
      .addTo(map);

    let disposed = false;
    // The `drag` event fires once per pointer-move frame (60-120 Hz), and each
    // call rewrites the store and re-syncs the source. Coalesce to one update
    // per animation frame so a heavier `onMove` cannot stutter the drag.
    let rafPending = false;
    let dragRaf: number | null = null;
    const cancelPendingFrame = () => {
      if (dragRaf !== null) {
        cancelAnimationFrame(dragRaf);
        dragRaf = null;
      }
      rafPending = false;
    };
    const commit = () => {
      const next = marker.getLngLat();
      popup.setLngLat(next);
      options.onMove([next.lng, next.lat]);
    };
    const handleDrag = () => {
      if (rafPending) return;
      rafPending = true;
      dragRaf = requestAnimationFrame(() => {
        dragRaf = null;
        rafPending = false;
        if (disposed) return;
        commit();
      });
    };
    // The final `drag` may still be sitting in a pending frame when the user
    // releases and clicks Done; commit the release position synchronously so the
    // photo never lands one frame stale, dropping the queued frame so it does
    // not fire a second, identical update.
    const handleDragEnd = () => {
      if (disposed) return;
      cancelPendingFrame();
      commit();
    };
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      cancelPendingFrame();
      marker.off("drag", handleDrag);
      marker.off("dragend", handleDragEnd);
      doneButton.removeEventListener("click", handleDone);
      popup.remove();
      marker.remove();
    };
    const handleDone = () => {
      dispose();
      options.onDone?.();
    };

    marker.on("drag", handleDrag);
    marker.on("dragend", handleDragEnd);
    doneButton.addEventListener("click", handleDone);
    return dispose;
  }

  /**
   * Imperatively animate the camera, for the programmatic scripting API.
   *
   * Unlike {@link applyView} (which the store sync uses) this passes straight to
   * MapLibre's `flyTo`, so a script can request an animated move with an explicit
   * duration. Only the provided fields are changed; omitted camera properties
   * keep their current value.
   *
   * @param camera Target camera. `center` is `[lng, lat]`.
   */
  flyTo(camera: {
    center?: [number, number];
    zoom?: number;
    bearing?: number;
    pitch?: number;
    duration?: number;
  }): void {
    if (!this.map) return;
    this.map.flyTo({
      ...(camera.center ? { center: camera.center } : {}),
      ...(typeof camera.zoom === "number" ? { zoom: camera.zoom } : {}),
      ...(typeof camera.bearing === "number" ? { bearing: camera.bearing } : {}),
      ...(typeof camera.pitch === "number" ? { pitch: camera.pitch } : {}),
      duration: typeof camera.duration === "number" ? camera.duration : 800,
    });
  }

  /** Animate the map in by one zoom level, mirroring the navigation control. */
  zoomIn(): void {
    this.map?.zoomIn();
  }

  /** Animate the map out by one zoom level, mirroring the navigation control. */
  zoomOut(): void {
    this.map?.zoomOut();
  }

  /**
   * Animate the map back to north-up (bearing 0), leaving the center, zoom, and
   * pitch untouched. Mirrors MapLibre's compass-control click.
   */
  resetNorth(): void {
    this.map?.resetNorth();
  }

  /**
   * Animate the map back to north-up and flat (bearing 0 and pitch 0), leaving
   * the center and zoom untouched.
   */
  resetNorthPitch(): void {
    this.map?.resetNorthPitch();
  }

  /**
   * Animate the map back to flat (pitch 0), leaving the center, zoom, and
   * bearing untouched. The pitch counterpart to {@link resetNorth}, so the
   * heading and tilt can be reset independently.
   */
  resetPitch(): void {
    // Match MapLibre's native resetNorth/resetNorthPitch 1s animation so the
    // sibling orientation resets feel consistent (easeTo defaults to 300ms).
    this.map?.easeTo({ pitch: 0, duration: 1000 });
  }
}

function constrainMapView(
  view: MapViewState,
  preferences: MapPreferences,
  map: maplibregl.Map | null,
  customCrs = false,
): maplibregl.JumpToOptions {
  const requestedMinZoom = clampNumber(preferences.minZoom, 0, 24);
  // Use the same effective floor the transform constraint enforces so the
  // jumpTo does not land at a zoom the constraint would immediately correct,
  // which would show as a snap when bounds are restricted.
  const minZoom = map
    ? effectiveMinZoomForPreferences(preferences, map, requestedMinZoom)
    : requestedMinZoom;
  const maxZoom = Math.max(minZoom, clampNumber(preferences.maxZoom, 0, 24));

  // Web Mercator stops short of the poles; a custom CRS (a polar one) does not.
  // Keyed on the CRS applied, like applyViewConstraints.
  const maxLat = customCrs ? 90 : 85;
  return {
    center: [
      preferences.renderWorldCopies ? view.center[0] : clampNumber(view.center[0], -180, 180),
      clampNumber(view.center[1], -maxLat, maxLat),
    ],
    zoom: clampNumber(view.zoom, minZoom, maxZoom),
    bearing: view.bearing,
    pitch: clampNumber(view.pitch, 0, clampNumber(preferences.maxPitch, 0, DEFAULT_MAX_PITCH)),
  };
}

export function createMapController(): MapController {
  return new MapController();
}
