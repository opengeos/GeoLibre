import {
  useAppStore,
  type GeoLibreLayer,
  type MapPreferences,
  type MapProjection,
  type MapViewState,
  type StoryChapterAnimation,
  type StoryChapterLocation,
} from "@geolibre/core";
import type { CesiumWidget } from "@cesium/engine";
import type { FeatureCollection } from "geojson";
import type * as maplibregl from "maplibre-gl";
import {
  applyMapViewToCamera,
  cameraFovy,
  mapLibrePitchToCesiumDeg,
  normalizeBearing,
  canvasHeight,
  groundHeightAt,
  isSameView,
  readMapViewFromCamera,
  zoomToRange,
  zoomToSceneRange,
} from "./cesium-camera";
import { getPrimaryCesiumControlHost } from "./cesium-control-host";
import { CesiumLayerSync } from "./cesium-layer-sync";
import { getLayerBounds } from "./geojson-loader";
import type {
  BuiltInMapControl,
  IdentifiedFeature,
  ManualPlacementOptions,
  MapEngine,
  MapEngineCapabilities,
  FlyToCamera,
} from "./map-engine";

type CesiumNs = typeof import("@cesium/engine");

/**
 * What the globe can do (issue #2260).
 *
 * The four `false` flags are not "not yet wired" — they are the operations
 * Cesium has no equivalent for, or that this engine deliberately does not claim:
 *
 * - `styleSpec` / `nativeMapInstance`: Cesium draws imagery layers and
 *   primitives, not a Mapbox Style document, and there is no `maplibregl.Map`
 *   behind it. Everything that edits paint properties or reads the MapLibre
 *   canvas stays 2D-only.
 * - `customLayers`: a MapLibre `CustomLayerInterface` is a callback into
 *   MapLibre's own WebGL pass; deck.gl's MapLibre interop is the same shape.
 * - `picking`: `identifyFeatures` needs `scene.drillPick` plus a mapping from a
 *   picked primitive back to a `GeoLibreLayer` id and feature id, which
 *   `CesiumLayerSync` does not record today. Claiming it before that exists
 *   would make Identify report "no features here" instead of "not available".
 * - `onMapDrawing` / `domControls`: no manual-placement pin and nowhere to host
 *   an `IControl`. The control host is issue #2263.
 *
 * `terrain: true` is the flag worth noting in the other direction — terrain is
 * native on the globe, and the old `primaryRenderer === "cesium"` gates disabled
 * it anyway.
 */
export const CESIUM_CAPABILITIES: MapEngineCapabilities = Object.freeze({
  styleSpec: false,
  nativeMapInstance: false,
  customLayers: false,
  terrain: true,
  picking: false,
  onMapDrawing: false,
  domControls: true,
});

/**
 * Capabilities of a globe rendered as a **grid pane** rather than the primary
 * map area.
 *
 * Identical to {@link CESIUM_CAPABILITIES} except for `domControls`: the
 * control host is a singleton owned by the primary globe, so a pane has nowhere
 * to mount an `IControl`.
 */
export const CESIUM_PANE_CAPABILITIES: MapEngineCapabilities = Object.freeze({
  ...CESIUM_CAPABILITIES,
  domControls: false,
});

/**
 * Coerce a preference zoom into MapLibre's [0, 24] range, falling back to
 * `fallback` for a non-finite value. Mirrors `clampNumber` in `map-controller.ts`.
 */
function clampZoom(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(24, Math.max(0, value));
}

/**
 * Animation lengths, in seconds, matched to the 2D map's.
 *
 * The same click must not visibly run at a different speed depending on which
 * renderer is drawing, so each of these is pinned to what `MapController` does
 * rather than to one house default (#2265 review).
 */
/** MapLibre's `easeTo` default (500 ms), which backs `zoomIn`/`zoomOut`/`easeToView`. */
const EASE_SECONDS = 0.5;
/**
 * MapLibre's `resetNorth`/`resetNorthPitch` animate over 1 s, and
 * `MapController.resetPitch` sets 1000 ms explicitly to match its siblings.
 */
const RESET_SECONDS = 1;
/** `MapController.flyTo` and `MapController.fitBounds` both use 800 ms. */
const FLY_SECONDS = 0.8;
/** Zoom floor when framing a point-sized extent; matches MapController.fitBounds. */
const POINT_FIT_ZOOM = 14;

export interface CesiumEngineOptions {
  /**
   * Id of the `secondaryMapViews` record this globe draws, or `undefined` when
   * it *is* the primary map area. Decides which camera the engine publishes to
   * and whether per-pane visibility overrides apply — see `CesiumCanvas`.
   */
  viewId?: string;
}

/**
 * The 3D globe as a {@link MapEngine} (issue #2260).
 *
 * This owns the globe's camera state machine, which used to live in
 * `CesiumCanvas`'s mount effect. Moving it here is what lets menus, panels, and
 * shortcuts drive the globe the way they drive the 2D map: a caller that runs
 * `zoomIn()` has to land in the same echo-suppression and dirty-tracking logic
 * as a user's own scroll, and a second, independent camera owner would fight it
 * (see {@link markUserDriven}).
 *
 * The engine is constructed with an existing `CesiumWidget` rather than creating
 * one, mirroring `CesiumLayerSync`: `CesiumCanvas` owns the widget's async
 * lifecycle (the lazy `import()`, the cancellation dance, the container), and
 * the engine owns everything after it exists. That is the same split as
 * `MapCanvas`/`MapController`, minus `init` — construction is the one thing the
 * engines legitimately do differently, which is why `MapEngine` does not declare
 * it.
 */
export class CesiumEngine implements MapEngine {
  readonly kind = "cesium" as const;
  /**
   * Per-instance, because `domControls` is not true of every globe: the control
   * host is a singleton belonging to the primary map area, so a grid pane has
   * nowhere to mount an `IControl`. A flag that claimed otherwise while
   * {@link addControl} returned `false` would be the exact failure the
   * capability flags exist to prevent — UI gating on a capability the engine
   * does not actually honour.
   */
  readonly capabilities: MapEngineCapabilities;

  private readonly Cesium: CesiumNs;
  private viewer: CesiumWidget | null;
  private readonly viewId: string | undefined;
  private readonly layerSync: CesiumLayerSync;

  /**
   * The last view this engine pushed into the camera. Applying a view fires
   * Cesium's `moveEnd` with a (rounding-drifted) echo of that same view;
   * comparing against this is what tells a real user move from that echo.
   */
  private lastApplied: MapViewState | null = null;
  /**
   * Ground height (metres) the last `applyView` placed the camera against.
   * Terrain streams in after the camera is positioned, so the first apply over
   * a new area sees height 0; comparing against this tells a settled terrain
   * load whether the camera now needs correcting.
   */
  private lastGroundHeight = 0;
  /**
   * Set by real user input (or by a caller going through {@link markUserDriven})
   * and consumed by the `moveEnd` handler. Cesium's `camera.moveEnd` carries no
   * user-driven flag (unlike MapLibre's `moveend.originalEvent`), so this stands
   * in for it: an autonomous settle (terrain streaming, a container resize)
   * leaves it false and must not mark the project dirty.
   */
  private userMoved = false;
  /**
   * Whether the camera's current position came from the user rather than from
   * {@link applyView}. Unlike {@link userMoved} (which `moveEnd` consumes) this
   * stays set until the next programmatic apply, and it is what stops the
   * terrain correction from fighting live navigation.
   */
  private userOwnsCamera = false;

  /**
   * Zoom bounds from the project's `MapPreferences`, in MapLibre zoom levels.
   *
   * MapLibre enforces these for free: `setMinZoom`/`setMaxZoom` clamp every
   * camera operation, so `MapController.zoomIn()` cannot walk past the
   * project's `maxZoom`. Cesium has no equivalent — its
   * `screenSpaceCameraController` distance limits govern interactive navigation
   * only, not a programmatic `flyToBoundingSphere` — so the engine has to clamp
   * the target zoom itself or the two renderers disagree on the same click
   * (#2265 review). Defaults span MapLibre's full range until preferences
   * arrive.
   */
  private minZoom = 0;
  private maxZoom = 24;

  private terrainEnabled = false;
  private terrainExaggeration = 1;
  private disposers: Array<() => void> = [];
  /**
   * Controls `CesiumCanvas` built and handed over under a built-in control id.
   * See {@link registerBuiltInControl}.
   */
  private builtInControls = new Map<BuiltInMapControl, maplibregl.IControl>();

  constructor(Cesium: CesiumNs, viewer: CesiumWidget, options: CesiumEngineOptions = {}) {
    this.Cesium = Cesium;
    this.viewer = viewer;
    this.viewId = options.viewId;
    this.capabilities =
      options.viewId === undefined ? CESIUM_CAPABILITIES : CESIUM_PANE_CAPABILITIES;
    this.layerSync = new CesiumLayerSync(Cesium, viewer);
    this.terrainExaggeration = viewer.scene.verticalExaggeration ?? 1;
    this.installInputTracking();
    this.installTerrainCorrection();
    this.installCameraPublisher();
    this.installMorphHandling();
  }

  /** Whether this globe is the primary map area rather than a grid pane. */
  private get isPrimary(): boolean {
    return this.viewId === undefined;
  }

  /** The viewer, or `null` once it has been destroyed out from under us. */
  private live(): CesiumWidget | null {
    const viewer = this.viewer;
    return viewer && !viewer.isDestroyed() ? viewer : null;
  }

  /**
   * Whether the scene is mid-flight between 2D, 3D and Columbus view.
   *
   * A morph is the one window where the camera cannot be read or written.
   * Cesium throws outright from `lookAt` and `flyTo` while morphing, and
   * `camera.heading` returns `undefined` — so both halves of the camera sync
   * have to stand down and let the morph finish. {@link installMorphHandling}
   * re-applies the stored view once it does.
   */
  private isMorphing(): boolean {
    const viewer = this.live();
    return viewer?.scene.mode === this.Cesium.SceneMode.MORPHING;
  }

  // ---------------------------------------------------------------- lifecycle

  destroy(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
    this.layerSync.destroy();
    // The control host tears the controls themselves down; drop the references
    // so a late setBuiltInControlVisible cannot re-add one to a dead globe.
    this.builtInControls.clear();
    // The widget itself belongs to CesiumCanvas, which destroys it; dropping the
    // handle here is what stops a late listener from touching a dead viewer.
    this.viewer = null;
  }

  // ------------------------------------------------------------------- camera

  applyView(view: MapViewState): void {
    const viewer = this.live();
    if (!viewer || this.isMorphing()) return;
    this.lastApplied = view;
    // This placement is ours, so the terrain correction may adjust it.
    this.userOwnsCamera = false;
    this.lastGroundHeight = groundHeightAt(this.Cesium, viewer, view.center[0], view.center[1]);
    applyMapViewToCamera(this.Cesium, viewer, view);
  }

  readView(): MapViewState {
    const viewer = this.live();
    // A morph is as unreadable as a destroyed viewer, and for a sharper reason:
    // `camera.heading` returns `undefined` while `scene.mode` is MORPHING, and
    // Cesium's `Math.toDegrees` *throws* on that rather than returning NaN. So a
    // read that lands mid-morph does not merely report a half-projected camera,
    // it takes its caller down — and the callers are ordinary background work
    // (the autosave snapshot, the View menu's limit check, the status bar),
    // none of which expects reading the camera to be fallible. The last applied
    // view is the honest answer: the morph is on its way to it, and
    // `installMorphHandling` re-applies it on arrival.
    if (!viewer || this.isMorphing()) {
      return this.lastApplied ?? useAppStore.getState().mapView;
    }
    return readMapViewFromCamera(this.Cesium, viewer);
  }

  /**
   * Animate to `view` with a linear ease, matching `map.easeTo`'s 500 ms.
   *
   * Note the globe cannot reproduce MapLibre's *shape* distinction: `easeTo`
   * interpolates the camera directly while `flyTo` traces a curved
   * zoom-out-then-in arc, whereas Cesium exposes one flight primitive that both
   * {@link easeToView} and {@link flyToView} necessarily share. Only the
   * durations differ here. If a caller ever depends on the arc — a story
   * transition that reads as "travelling" rather than "sliding" — it needs a
   * real Cesium implementation, not a duration tweak.
   */
  easeToView(view: MapViewState): void {
    this.animateTo(view, EASE_SECONDS);
  }

  /** Animate to a story-chapter location. See {@link easeToView} on the arc. */
  flyToView(location: StoryChapterLocation): void {
    this.animateTo(location, FLY_SECONDS);
  }

  applyStoryChapterCamera(
    location: StoryChapterLocation,
    animation: StoryChapterAnimation = "flyTo",
    _rotate = false,
  ): void {
    // Auto-rotation is MapLibre-only for now: it drives a per-frame bearing tick
    // against the 2D map, and the globe has no equivalent hook yet.
    if (animation === "jumpTo") {
      this.applyView(location);
      return;
    }
    this.animateTo(location, animation === "easeTo" ? EASE_SECONDS : FLY_SECONDS);
  }

  flyTo(camera: FlyToCamera): void {
    const current = this.readView();
    this.animateTo(
      {
        center: camera.center ?? current.center,
        zoom: camera.zoom ?? current.zoom,
        bearing: camera.bearing ?? current.bearing,
        pitch: camera.pitch ?? current.pitch,
      },
      camera.duration === undefined ? FLY_SECONDS : camera.duration / 1000,
    );
  }

  zoomIn(): void {
    const view = this.readView();
    this.animateTo({ ...view, zoom: view.zoom + 1 });
  }

  zoomOut(): void {
    const view = this.readView();
    this.animateTo({ ...view, zoom: view.zoom - 1 });
  }

  resetNorth(): void {
    this.animateTo({ ...this.readView(), bearing: 0 }, RESET_SECONDS);
  }

  resetNorthPitch(): void {
    this.animateTo({ ...this.readView(), bearing: 0, pitch: 0 }, RESET_SECONDS);
  }

  resetPitch(): void {
    this.animateTo({ ...this.readView(), pitch: 0 }, RESET_SECONDS);
  }

  fitBounds(bounds: [number, number, number, number]): void {
    const viewer = this.live();
    if (!viewer) return;
    const [west, south, east, north] = bounds;
    if (![west, south, east, north].every((value) => Number.isFinite(value))) return;
    // A degenerate point-sized box cannot be fit; fly to the point instead.
    // `fitLayer` on a single-point layer produces exactly this box, and a
    // zero-area Rectangle has no "zoom to fit" — Cesium would derive a
    // nonsensical camera distance from it. Mirrors MapController.fitBounds,
    // including its zoom floor, so a single marker frames the same on both
    // engines.
    if (west === east && south === north) {
      this.animateTo(
        {
          center: [west, south],
          zoom: Math.max(this.readView().zoom, POINT_FIT_ZOOM),
          bearing: 0,
          pitch: 0,
        },
        FLY_SECONDS,
      );
      return;
    }
    viewer.camera.flyTo({
      destination: this.Cesium.Rectangle.fromDegrees(west, south, east, north),
      duration: FLY_SECONDS,
    });
  }

  fitLayer(layer: GeoLibreLayer): void {
    const bounds = getLayerBounds(layer);
    if (bounds) this.fitBounds(bounds);
  }

  readCameraAltitude(): number | null {
    const viewer = this.live();
    // Unreadable mid-morph, the same way {@link readView} is: the camera is
    // between two frames of reference and its cartographic height means nothing
    // in either. `null` is the value callers already handle for "no altitude".
    if (!viewer || this.isMorphing()) return null;
    const carto = this.Cesium.Cartographic.fromCartesian(viewer.camera.positionWC);
    if (!carto || !Number.isFinite(carto.height)) return null;
    const ground = groundHeightAt(
      this.Cesium,
      viewer,
      this.Cesium.Math.toDegrees(carto.longitude),
      this.Cesium.Math.toDegrees(carto.latitude),
    );
    return carto.height - ground;
  }

  /** Always `"globe"`: Cesium draws an ellipsoid, never a flat projection. */
  readProjection(): MapProjection {
    return "globe";
  }

  applyMapPreferences(preferences: MapPreferences): void {
    const viewer = this.live();
    if (!viewer) return;
    // MapLibre's min/max zoom become camera distance limits, which is the
    // closest Cesium analogue. The latitude the conversion needs is the camera's
    // own, so the limits track the scale the user actually sees. Bounds and
    // maxPitch have no equivalent the globe can enforce without fighting
    // Cesium's own navigation, so they are left to the 2D map.
    const { latitude } = this.Cesium.Cartographic.fromCartesian(viewer.camera.positionWC) ?? {
      latitude: 0,
    };
    const latDeg = this.Cesium.Math.toDegrees(latitude);
    const height = canvasHeight(viewer);
    const fovy = cameraFovy(viewer);
    // Remember the bounds so programmatic moves clamp to them the way
    // MapLibre's setMinZoom/setMaxZoom clamp its own camera API. Same coercion
    // as MapController.applyMapPreferences, including maxZoom never falling
    // below minZoom.
    this.minZoom = clampZoom(preferences.minZoom, 0);
    this.maxZoom = Math.max(this.minZoom, clampZoom(preferences.maxZoom, 24));
    const controller = viewer.scene.screenSpaceCameraController;
    if (Number.isFinite(preferences.maxZoom)) {
      controller.minimumZoomDistance = Math.max(
        zoomToRange(preferences.maxZoom, latDeg, height, fovy),
        1,
      );
    }
    if (Number.isFinite(preferences.minZoom)) {
      controller.maximumZoomDistance = Math.max(
        zoomToRange(preferences.minZoom, latDeg, height, fovy),
        1,
      );
    }
  }

  // ------------------------------------------------------------------- layers

  syncLayers(layers: GeoLibreLayer[]): void {
    this.layerSync.sync(layers);
  }

  /**
   * The globe has no style-swap window to wait out — `CesiumLayerSync` already
   * defers each layer's own async create — so this is `syncLayers`.
   */
  waitAndSyncLayers(layers: GeoLibreLayer[]): void {
    this.syncLayers(layers);
  }

  /**
   * The globe never holds features the store does not: `CesiumLayerSync` builds
   * its `GeoJsonDataSource`s *from* `layer.geojson`, so there is nothing to read
   * back that the caller cannot read from the store. Returns the layer's own
   * collection rather than `null` so callers that only need the features work.
   */
  getLayerGeoJson(layerId: string): Promise<FeatureCollection | null> {
    const layer = useAppStore.getState().layers.find((entry) => entry.id === layerId);
    return Promise.resolve(layer?.geojson ?? null);
  }

  getLayerRasterSource(layerId: string): Record<string, unknown> | null {
    const layer = useAppStore.getState().layers.find((entry) => entry.id === layerId);
    return layer?.source ? { ...layer.source } : null;
  }

  // ------------------------------------------------------------------ basemap

  /**
   * Basemap visibility and opacity are applied by `CesiumCanvas`, which holds
   * the imagery-layer handles the store's Background row drives. The engine
   * carries the members so callers stay engine-agnostic.
   */
  setBasemapVisible(_visible: boolean): void {}

  setBasemapOpacity(_opacity: number): void {}

  /**
   * No-op: the globe has no style document. It draws the basemap by translating
   * the store's `basemapStyleUrl` through `basemapToCesiumImagery()`, so a
   * basemap change reaches it through the store, not through this call.
   * Guarded by {@link MapEngineCapabilities.styleSpec}.
   */
  setStyle(_url: string): void {}

  /** Empty: there are no style layers to name without a style document. */
  getBasemapStyleLayerIds(): string[] {
    return [];
  }

  setBlankBackgroundColor(_color: string | null): void {}

  // ---------------------------------------------------------- story rendering

  /**
   * Story playback fades layers through their MapLibre paint properties, which
   * the globe does not have. `CesiumLayerSync` applies `layer.opacity` on sync,
   * so a story that writes opacity to the store still fades on the globe.
   */
  setStoryLayerOpacity(_layerId: string, _opacity: number, _durationMs?: number): void {}

  restoreLayerStyles(): void {}

  // ------------------------------------------------------------------ picking

  /** Empty until the globe can map a picked primitive back to a feature id. */
  identifyFeatures(_lngLat: [number, number], _layerId?: string): IdentifiedFeature[] {
    return [];
  }

  highlightFeature(
    _layer: GeoLibreLayer | undefined,
    _featureId: string | string[] | null,
    _options: { fit?: boolean } = {},
  ): void {}

  clearFeatureHighlight(): void {}

  /** Places nothing and returns a no-op teardown; see `onMapDrawing`. */
  startManualPlacement(_lngLat: [number, number], _options: ManualPlacementOptions): () => void {
    return () => {};
  }

  // ----------------------------------------------------------------- controls

  /**
   * Mount a control on the globe's control host.
   *
   * Only the **primary** globe has one. The host is a module-level singleton
   * keyed to whichever globe owns the primary map area, so delegating from a
   * grid pane's engine would mount the pane's control onto a different viewer
   * — or onto nothing at all when the primary renderer is MapLibre. A pane
   * reports `false`, the same answer every caller already reads as "this engine
   * has nowhere to host it".
   */
  addControl(control: maplibregl.IControl, position?: maplibregl.ControlPosition): boolean {
    if (!this.isPrimary) return false;
    // Return the host's own result: it answers `false` for a control that is
    // already mounted, and a caller that reads `true` there would double-count
    // its registration.
    return getPrimaryCesiumControlHost()?.addControl(control, position) ?? false;
  }

  /** No-op for a grid pane, which never mounted a control. See {@link addControl}. */
  removeControl(control: maplibregl.IControl): void {
    if (!this.isPrimary) return;
    getPrimaryCesiumControlHost()?.removeControl(control);
  }

  /**
   * Put a control the canvas built under a built-in control id, so the app's
   * existing Controls menu can govern it (issue #2270).
   *
   * Only the fullscreen button uses this today. The globe's other two Cesium
   * widgets — home and scene mode — have no entry in that menu and stay
   * unconditional; the rest of the built-in controls are MapLibre's own and
   * have no globe counterpart at all, which is why
   * {@link setBuiltInControlVisible} still answers `false` for them.
   */
  registerBuiltInControl(control: BuiltInMapControl, instance: maplibregl.IControl): void {
    this.builtInControls.set(control, instance);
  }

  setBuiltInControlVisible(control: BuiltInMapControl, visible: boolean): boolean {
    const instance = this.builtInControls.get(control);
    if (!instance || !this.isPrimary) return false;
    const host = getPrimaryCesiumControlHost();
    if (!host) return false;
    // `addControl` is a no-op for a control already mounted and `removeControl`
    // for one already gone, so repeated calls (project restore replays every
    // control's visibility) settle rather than stacking duplicates.
    if (visible) host.addControl(instance, "top-right");
    else host.removeControl(instance);
    return true;
  }

  getBuiltInControlPosition(_control: BuiltInMapControl): maplibregl.ControlPosition {
    return "top-right";
  }

  setBuiltInControlPosition(
    _control: BuiltInMapControl,
    _position: maplibregl.ControlPosition,
  ): boolean {
    return false;
  }

  setCompassLabel(_label: string): void {}

  setBackgroundLabel(_label: string): void {}

  // ------------------------------------------------------------------ terrain

  isTerrainEnabled(): boolean {
    return this.terrainEnabled;
  }

  /**
   * Toggle Cesium World Terrain. Unlike MapLibre — where terrain is a raster-DEM
   * source added to the style — this swaps the globe's terrain provider, so the
   * relief is real geometry rather than a displacement of the basemap.
   *
   * Returns whether the toggle was accepted; the provider itself loads
   * asynchronously and is best-effort, matching how `CesiumCanvas` adds terrain
   * at mount.
   */
  setTerrainEnabled(enabled: boolean): boolean {
    const viewer = this.live();
    if (!viewer) return false;
    if (!enabled) {
      this.terrainEnabled = false;
      viewer.terrainProvider = new this.Cesium.EllipsoidTerrainProvider();
      return true;
    }
    void this.enableWorldTerrain();
    return true;
  }

  /**
   * Await-able form of `setTerrainEnabled(true)`, for the mount path.
   *
   * `CesiumCanvas` adds world terrain *before* it seeds the camera, because
   * ground height is what turns MapLibre's zoom into a camera distance — seeding
   * first would place the first frame against the ellipsoid and rely on the
   * terrain correction to fix it. The interface form cannot express that (it
   * returns `boolean`), so the mount path calls this and the interface delegates
   * to it fire-and-forget.
   */
  async enableWorldTerrain(): Promise<void> {
    this.terrainEnabled = true;
    try {
      const provider = await this.Cesium.createWorldTerrainAsync();
      const viewer = this.live();
      // The toggle may have been reversed, or the viewer destroyed, while the
      // provider loaded; applying it then would resurrect terrain the user just
      // turned off.
      if (viewer && this.terrainEnabled) viewer.terrainProvider = provider;
    } catch {
      // Terrain is best-effort; the globe still renders without it.
    }
  }

  getTerrainExaggeration(): number {
    return this.terrainExaggeration;
  }

  setTerrainExaggeration(exaggeration: number): void {
    const viewer = this.live();
    this.terrainExaggeration = exaggeration;
    if (viewer) viewer.scene.verticalExaggeration = exaggeration;
  }

  /** Cesium World Terrain is the only source the globe offers today. */
  getTerrainCogSource(): string | null {
    return null;
  }

  hasCustomTerrainSource(): boolean {
    return false;
  }

  setTerrainCogSource(_source: string | Blob | null, _band = 1): Promise<boolean> {
    return Promise.resolve(false);
  }

  setTerrainLabel(_label: string): void {}

  // ------------------------------------------------------------------- escape

  /** Always `null`: there is no MapLibre map behind the globe. */
  getMap(): maplibregl.Map | null {
    return null;
  }

  // ------------------------------------------------------------------ internal

  /**
   * Flag the camera move that follows as user-driven, so the `moveEnd` handler
   * marks the project dirty.
   *
   * Raw input only. Cesium's `moveEnd` carries no user-driven flag, so this
   * stands in for MapLibre's `moveend.originalEvent` — and, like it, is set by
   * the user's own gesture and nothing else. A programmatic move does *not*
   * raise it: see {@link animateTo}.
   */
  private markUserDriven(): void {
    this.userMoved = true;
    this.userOwnsCamera = true;
  }

  /**
   * Animate the camera to `view`. Never marks the project dirty.
   *
   * This matches the 2D map exactly, and the match is the point. `MapController`
   * drives MapLibre's own camera API with no `eventData`, so the resulting
   * `moveend` has no `originalEvent` and `MapCanvas` publishes it with
   * `markDirty=false` — clicking View → Zoom in, resetting the bearing, or
   * previewing a story chapter syncs the camera without flagging unsaved
   * changes. An engine that dirtied on the same actions would make identical
   * clicks behave differently depending on which renderer is drawing, which is
   * precisely what #2260 exists to prevent.
   */
  private animateTo(view: MapViewState, seconds?: number): void {
    const viewer = this.live();
    if (!viewer || this.isMorphing()) return;
    // Cesium has no "ease to a MapLibre view" primitive, so the flight is
    // expressed the same way applyView expresses a placement — a lookAt in the
    // target's local frame — with `flyTo`'s duration doing the animating.
    const [lng, lat] = view.center;
    const ground = groundHeightAt(this.Cesium, viewer, lng, lat);
    // Every programmatic camera move funnels through here, so this is where the
    // project's zoom bounds are enforced — the counterpart to MapLibre clamping
    // inside its own camera API.
    const zoom = Math.min(this.maxZoom, Math.max(this.minZoom, view.zoom));
    // Per scene mode: a camera distance in 3D and Columbus view, the width of
    // the orthographic box in 2D. `flyToBoundingSphere` reinterprets the offset
    // range exactly as `lookAt` does, so both paths agree on what a zoom means.
    const range = zoomToSceneRange(this.Cesium, viewer, { ...view, zoom });
    // The heading and pitch below are *not* flattened for 2D the way
    // `applyMapViewToCamera` flattens them (#2270 review). They do not need to
    // be: `lookAt` honours an offset's orientation in 2D — which is why the
    // instant path has to force it flat, or the map would sit visibly rotated
    // under a status bar reporting bearing 0 — but `flyToBoundingSphere` reads
    // the offset's orientation only when the scene is 3D, and passes no
    // direction/up at all in 2D *and Columbus view*. Mirroring the guard here
    // would be dead code.
    //
    // The Columbus half of that is a real limitation rather than a nicety: an
    // animated move cannot tilt or rotate a Columbus-view camera, so a story
    // chapter authored with a bearing plays back flat there. The instant path
    // (`applyView`) does honour both, and the readback
    // reports whatever ends up on screen, so nothing desynchronizes — the
    // animation is simply less expressive than in 3D.
    viewer.camera.flyToBoundingSphere(
      new this.Cesium.BoundingSphere(
        this.Cesium.Cartesian3.fromDegrees(lng, lat, ground),
        // A zero-radius sphere makes `offset.range` the whole distance, so the
        // arrival matches what applyView would have produced for this zoom.
        0,
      ),
      {
        // Same conversions applyMapViewToCamera uses, so an animated arrival and
        // an instant apply of the same view land in identical orientations.
        offset: new this.Cesium.HeadingPitchRange(
          this.Cesium.Math.toRadians(normalizeBearing(view.bearing)),
          this.Cesium.Math.toRadians(mapLibrePitchToCesiumDeg(view.pitch)),
          range,
        ),
        duration: seconds ?? EASE_SECONDS,
      },
    );
  }

  /**
   * Flag genuine camera-moving input on the globe so the `moveEnd` handler can
   * tell a real move from an autonomous settle. Only motion events count:
   * Cesium's `moveEnd` fires solely on actual camera movement, so a plain
   * click/tap that doesn't move the camera must NOT arm the flag — otherwise a
   * later autonomous settle (terrain, resize) would consume that stale flag and
   * dirty the project. A hover isn't a move either, so `pointermove` only counts
   * while a button is down.
   */
  private installInputTracking(): void {
    const viewer = this.live();
    if (!viewer) return;
    const canvas = viewer.canvas;
    const markMove = () => this.markUserDriven();
    const markDrag = (event: PointerEvent) => {
      if (event.buttons !== 0) this.markUserDriven();
    };
    const opts: AddEventListenerOptions = { passive: true };
    canvas.addEventListener("pointermove", markDrag, opts);
    canvas.addEventListener("wheel", markMove, opts);
    canvas.addEventListener("touchmove", markMove, opts);
    this.disposers.push(() => {
      canvas.removeEventListener("pointermove", markDrag, opts);
      canvas.removeEventListener("wheel", markMove, opts);
      canvas.removeEventListener("touchmove", markMove, opts);
    });
  }

  /**
   * Re-apply the last placement once terrain settles at a different height.
   *
   * Terrain arrives after the camera is placed, and the ground height is what
   * turns MapLibre's zoom into a camera distance. Until the tiles for the view
   * land, `groundHeightAt` reports 0 and the camera is positioned against the
   * ellipsoid — over Las Vegas that renders ~2x too close at zoom 15. The guard
   * makes this a no-op without terrain (height stays 0) and stops it recursing:
   * the re-apply's own load settles at the same height.
   *
   * It corrects a *programmatic* placement only. Navigating loads finer terrain,
   * which drains the queue at a new height mid-gesture; without the
   * `userOwnsCamera` guard that re-applied the last settled view and yanked the
   * camera back, so a wheel zoom over terrain snapped straight back to where it
   * started and the store never saw the move (the yank's own `moveEnd` read as
   * the suppressed echo). Once the user is driving, their camera is
   * authoritative and Cesium's own navigation already keeps it above terrain.
   */
  private installTerrainCorrection(): void {
    const viewer = this.live();
    if (!viewer) return;
    const onTileLoad = (queued: number) => {
      const live = this.live();
      const view = this.lastApplied;
      if (queued > 0 || !live || !view) return;
      if (this.userOwnsCamera) return;
      const height = groundHeightAt(this.Cesium, live, view.center[0], view.center[1]);
      if (Math.abs(height - this.lastGroundHeight) < 1) return;
      this.applyView(view);
    };
    viewer.scene.globe.tileLoadProgressEvent.addEventListener(onTileLoad);
    this.disposers.push(() => {
      const live = this.live();
      live?.scene.globe?.tileLoadProgressEvent.removeEventListener(onTileLoad);
    });
  }

  /** Follow Cesium's native morph endpoint without a second camera move. */
  private installMorphHandling(): void {
    const viewer = this.live();
    if (!viewer) return;
    const onMorphComplete = () => {
      // The native animation owns this camera, including any terrain settling.
      this.userOwnsCamera = true;
      this.publishCameraView();
    };
    viewer.scene.morphComplete.addEventListener(onMorphComplete);
    this.disposers.push(() => {
      const live = this.live();
      live?.scene.morphComplete.removeEventListener(onMorphComplete);
    });
  }

  /**
   * Mirror the globe's camera back into the shared store. Echoes of our own
   * {@link applyView} are filtered by the `isSameView` guard.
   */
  private installCameraPublisher(): void {
    const viewer = this.live();
    if (!viewer) return;
    const onMoveEnd = () => this.publishCameraView();
    viewer.camera.moveEnd.addEventListener(onMoveEnd);
    this.disposers.push(() => {
      const live = this.live();
      live?.camera.moveEnd.removeEventListener(onMoveEnd);
    });
  }

  /** Publish a settled camera, shared by navigation and projection changes. */
  private publishCameraView(): void {
    const live = this.live();
    if (!live || this.isMorphing()) return;
    // Nothing to publish until the camera has been seeded. A fresh
    // CesiumWidget starts on its own default camera and settles onto it, which
    // fires moveEnd before `CesiumCanvas` has applied the project's view —
    // with no `lastApplied` to recognize it by, that settle would look like a
    // real move and overwrite the stored camera with Cesium's default. The
    // listener is armed in the constructor (so it cannot miss a move) rather
    // than after the seed, so the guard lives here.
    if (!this.lastApplied) return;
    const view = readMapViewFromCamera(this.Cesium, live);
    if (isSameView(view, this.lastApplied)) return;
    this.lastApplied = view;
    // Only the moves that follow real user input dirty the project; an
    // autonomous settle still syncs the camera (markDirty=false) so the panes
    // stay in step without flipping isDirty on a freshly opened project.
    const userDriven = this.userMoved;
    this.userMoved = false;
    const store = useAppStore.getState();
    // Write only when the view actually differs from the stored camera:
    // `setMapView` has no same-camera guard in the store, and
    // `setSecondaryMapView`'s guard uses exact equality (which Cesium's lossy
    // readback never hits), so both are gated here with isSameView.
    if (this.isPrimary) {
      // The primary globe owns `mapView` outright (there is no pane record to
      // mirror into), so it writes regardless of the `syncView` toggle — that
      // toggle governs the secondary panes, and the primary map is the camera
      // they follow.
      if (!isSameView(view, store.mapView)) store.setMapView(view, userDriven);
      return;
    }
    if (store.mapLayout.syncView && !isSameView(view, store.mapView)) {
      store.setMapView(view, userDriven);
    }
    const paneId = this.viewId;
    if (paneId === undefined) return;
    const paneView = store.secondaryMapViews.find((pane) => pane.id === paneId)?.view;
    if (!paneView || !isSameView(view, paneView)) {
      store.setSecondaryMapView(paneId, view, userDriven);
    }
  }

  /**
   * The view last pushed into or read from the camera, for the canvas's own echo
   * guard. `CesiumCanvas` compares a store change against this before applying
   * it, so a view the globe itself just published is not re-applied.
   */
  getLastAppliedView(): MapViewState | null {
    return this.lastApplied;
  }
}
