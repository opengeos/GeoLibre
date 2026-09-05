import type {
  GeoLibreLayer,
  MapPreferences,
  MapProjection,
  MapRendererKind,
  MapViewState,
  StoryChapterAnimation,
  StoryChapterLocation,
} from "@geolibre/core";
import type { FeatureCollection, Geometry } from "geojson";
import type * as maplibregl from "maplibre-gl";

/**
 * The renderer-neutral surface the app drives a map through (issue #2260).
 *
 * Historically there was no such seam: every panel, menu, and plugin reached
 * the map through `MapController`, a MapLibre-specific class, so the 3D globe
 * — which has no `MapController` — left ~681 call sites pointing at `null` and
 * the UI compensated with hardcoded `primaryRenderer === "cesium"` gates. This
 * interface is the extraction of that surface, so a second engine can satisfy
 * it and those gates can key off {@link MapEngineCapabilities} instead of the
 * engine's name.
 *
 * `init()` is deliberately absent: it constructs the underlying map and returns
 * an engine-specific handle, and only each engine's own canvas component calls
 * it (`MapCanvas`/`SecondaryMapCanvas` for MapLibre). Construction is where the
 * engines legitimately differ; everything after it is what this interface
 * covers.
 *
 * Members that only one engine can honor are still declared here rather than
 * being split into a second interface. Two reasons: the call sites already
 * handle the "no map yet" case (a `MapController` returns `null`/`false` before
 * `init` and after `destroy`), so an engine that never supports an operation is
 * shaped like a map that is not ready yet; and splitting would push a
 * discriminated union onto all ~681 call sites for no gain. Which members are
 * meaningful is instead declared by {@link capabilities} — read that, do not
 * branch on {@link kind}.
 */
export interface MapEngine {
  /** Which renderer backs this engine. Diagnostics and telemetry only. */
  readonly kind: MapRendererKind;
  /**
   * What this engine can actually do. Gate UI on these, not on {@link kind}:
   * a feature disabled because "the engine is Cesium" gets it wrong in both
   * directions — it hides camera and terrain work Cesium does natively, and it
   * silently stops describing reality the moment a third engine appears.
   */
  readonly capabilities: MapEngineCapabilities;

  // ---------------------------------------------------------------- lifecycle

  /** Tear the map down and release its GPU resources. Safe to call twice. */
  destroy(): void;

  // ------------------------------------------------------------------- camera

  /** Place the camera at `view` immediately, without animation. */
  applyView(view: MapViewState): void;
  /** Animate the camera to `view` with a short ease. */
  easeToView(view: MapViewState): void;
  /** The camera's current position, in the store's engine-neutral shape. */
  readView(): MapViewState;
  /**
   * Camera height above the ground in metres, or `null` when the engine cannot
   * report one (no map yet, or a projection with no metric altitude).
   */
  readCameraAltitude(): number | null;
  /** Animate to a partial camera description; omitted fields are left alone. */
  flyTo(camera: FlyToCamera): void;
  /** Animate to a story-chapter location. */
  flyToView(location: StoryChapterLocation): void;
  /** Apply a story chapter's camera, optionally animated and auto-rotating. */
  applyStoryChapterCamera(
    location: StoryChapterLocation,
    animation?: StoryChapterAnimation,
    rotate?: boolean,
  ): void;
  zoomIn(): void;
  zoomOut(): void;
  /** Reset bearing to north, keeping the current pitch. */
  resetNorth(): void;
  /** Reset bearing to north and pitch to nadir. */
  resetNorthPitch(): void;
  /** Reset pitch to nadir, keeping the current bearing. */
  resetPitch(): void;
  /** Frame `bounds` (`[west, south, east, north]`) with the standard padding. */
  fitBounds(bounds: [number, number, number, number]): void;
  /** Frame a layer's extent. No-op for a layer whose extent is unknown. */
  fitLayer(layer: GeoLibreLayer): void;
  /** The projection the map is currently drawing in. */
  readProjection(): MapProjection;
  /** Apply min/max zoom, max pitch, and bounds constraints from the project. */
  applyMapPreferences(preferences: MapPreferences): void;

  // ------------------------------------------------------------------- layers

  /** Reconcile the map against `layers`, adding, updating, and removing. */
  syncLayers(layers: GeoLibreLayer[]): void;
  /**
   * Like {@link syncLayers}, but deferred until the engine is ready to accept
   * layers (a style swap in flight, terrain still streaming).
   */
  waitAndSyncLayers(layers: GeoLibreLayer[]): void;
  /** A layer's features, read back from the map. `null` when unavailable. */
  getLayerGeoJson(layerId: string): Promise<FeatureCollection | null>;
  /** A raster layer's source description, or `null` when it has none. */
  getLayerRasterSource(layerId: string): Record<string, unknown> | null;

  // ------------------------------------------------------------------ basemap

  setBasemapVisible(visible: boolean): void;
  setBasemapOpacity(opacity: number): void;
  /**
   * Swap the basemap. Requires {@link MapEngineCapabilities.styleSpec} for a
   * style URL; engines without it draw the basemap from their own translation
   * of the project's `basemapStyleUrl` instead (`basemapToCesiumImagery`).
   */
  setStyle(url: string): void;
  /**
   * The style-layer ids belonging to the basemap rather than to project layers.
   * Empty without {@link MapEngineCapabilities.styleSpec}.
   */
  getBasemapStyleLayerIds(): string[];
  /** Background color for the Blank basemap; `null` restores the theme default. */
  setBlankBackgroundColor(color: string | null): void;

  // ---------------------------------------------------------- story rendering

  /** Fade a layer for story playback without touching its stored opacity. */
  setStoryLayerOpacity(layerId: string, opacity: number, durationMs?: number): void;
  /** Undo every {@link setStoryLayerOpacity} applied since the last restore. */
  restoreLayerStyles(): void;

  // ------------------------------------------------------------------ picking

  /**
   * Features under `lngLat`, optionally restricted to one layer. Empty without
   * {@link MapEngineCapabilities.picking}.
   */
  identifyFeatures(lngLat: [number, number], layerId?: string): IdentifiedFeature[];
  /** Highlight one or more features on `layer`; `null` clears the highlight. */
  highlightFeature(
    layer: GeoLibreLayer | undefined,
    featureId: string | string[] | null,
    options?: { fit?: boolean },
  ): void;
  clearFeatureHighlight(): void;
  /**
   * Drop a draggable pin for the user to position, returning a teardown
   * function. Requires {@link MapEngineCapabilities.onMapDrawing}; engines
   * without it return a no-op teardown and place nothing.
   */
  startManualPlacement(lngLat: [number, number], options: ManualPlacementOptions): () => void;

  // ----------------------------------------------------------------- controls

  /**
   * Mount a control. Returns whether it was added — `false` means this engine
   * has nowhere to host it, which callers already treat as "not available".
   */
  addControl(control: maplibregl.IControl, position?: maplibregl.ControlPosition): boolean;
  removeControl(control: maplibregl.IControl): void;
  setBuiltInControlVisible(control: BuiltInMapControl, visible: boolean): boolean;
  getBuiltInControlPosition(control: BuiltInMapControl): maplibregl.ControlPosition;
  setBuiltInControlPosition(
    control: BuiltInMapControl,
    position: maplibregl.ControlPosition,
  ): boolean;
  /** Translated tooltip for the on-map compass (reset pitch/bearing) control. */
  setCompassLabel(label: string): void;
  /** Translated label for the layer control's basemap ("Background") row. */
  setBackgroundLabel(label: string): void;

  // ------------------------------------------------------------------ terrain

  isTerrainEnabled(): boolean;
  setTerrainEnabled(enabled: boolean): boolean;
  getTerrainExaggeration(): number;
  setTerrainExaggeration(exaggeration: number): void;
  /** The COG URL currently backing terrain, or `null` for the default source. */
  getTerrainCogSource(): string | null;
  hasCustomTerrainSource(): boolean;
  setTerrainCogSource(source: string | Blob | null, band?: number): Promise<boolean>;
  /** Translated tooltip for the on-map terrain control. */
  setTerrainLabel(label: string): void;

  // ------------------------------------------------------------------- escape

  /**
   * The underlying MapLibre map, or `null` when this engine is not MapLibre.
   *
   * The escape hatch for code that genuinely needs the Style Spec — and the
   * reason every consumer already null-checks, which is what lets a non-MapLibre
   * engine satisfy this interface without breaking them. Prefer a typed member
   * above; reach for this only behind
   * {@link MapEngineCapabilities.nativeMapInstance}.
   */
  getMap(): maplibregl.Map | null;
}

/**
 * What an engine can do, so UI gates describe a capability rather than name an
 * engine.
 *
 * Each flag exists because something in the app branches on it today. Adding a
 * flag without a consumer makes the set harder to reason about, not richer.
 *
 * The fields are `readonly` because an engine's capabilities are a fact about
 * that engine, not a setting: a capability object is shared by every instance of
 * an engine (see {@link MAPLIBRE_CAPABILITIES}), so one write would rewrite it
 * for all of them.
 */
export interface MapEngineCapabilities {
  /**
   * The Mapbox Style Spec is live: `setStyle`, paint-property edits, style
   * layer ids, and the style import/export paths (Mapbox, QML, SLD) work.
   * Cesium has no analogue — it draws imagery and primitives, not a style
   * document — so these are the operations that stay MapLibre-only.
   */
  readonly styleSpec: boolean;
  /**
   * {@link MapEngine.getMap} returns a live MapLibre map. Gates the features
   * that read the MapLibre canvas or drive MapLibre directly: AI object
   * detection, segment-everything, and plugins written against `maplibre-gl`.
   */
  readonly nativeMapInstance: boolean;
  /**
   * The engine hosts MapLibre `CustomLayerInterface` layers and deck.gl
   * overlays — layers whose pixels something other than the engine draws.
   */
  readonly customLayers: boolean;
  /** 3D terrain can be enabled and exaggerated. */
  readonly terrain: boolean;
  /** {@link MapEngine.identifyFeatures} can return features. */
  readonly picking: boolean;
  /**
   * The user can draw or drag on the map surface: {@link
   * MapEngine.startManualPlacement}, and the raster-subset extract box.
   */
  readonly onMapDrawing: boolean;
  /**
   * The engine can host `IControl` DOM controls, so plugin controls and the
   * built-in on-map controls have somewhere to mount.
   */
  readonly domControls: boolean;
}

/**
 * Capabilities of the MapLibre engine: everything, by construction.
 *
 * Frozen, not merely `readonly`. Every `MapController` — the primary map and
 * each split-view pane — exposes this one object, and `readonly` is erased at
 * runtime, so it stops a typed write but not an untyped one. External plugins
 * load from zips and manifests as plain JavaScript and reach the engine through
 * the plugin API, which is exactly the caller TypeScript cannot check.
 */
export const MAPLIBRE_CAPABILITIES: MapEngineCapabilities = Object.freeze({
  styleSpec: true,
  nativeMapInstance: true,
  customLayers: true,
  terrain: true,
  picking: true,
  onMapDrawing: true,
  domControls: true,
});

/** One feature returned by {@link MapEngine.identifyFeatures}. */
export interface IdentifiedFeature {
  layerId: string;
  featureId: string | null;
  properties: Record<string, unknown>;
  geometry: Geometry | null;
}

/** A partial camera description; omitted fields keep their current value. */
export interface FlyToCamera {
  center?: [number, number];
  zoom?: number;
  bearing?: number;
  pitch?: number;
  duration?: number;
}

/** Options for {@link MapEngine.startManualPlacement}. */
export interface ManualPlacementOptions {
  /** Instruction shown in the pin's popup while it is draggable. */
  hint: string;
  /** Label for the button that finishes placement. */
  doneLabel: string;
  /** Called with `[lng, lat]` on every drag of the pin. */
  onMove: (lngLat: [number, number]) => void;
  /** Called once when the user clicks the "Done" button. */
  onDone?: () => void;
}

/**
 * The on-map controls GeoLibre owns, as opposed to the ones plugins add.
 *
 * Lives here rather than in `map-controller.ts` because {@link MapEngine}
 * references it and every engine has to speak the same set; `map-controller.ts`
 * re-exports it so existing importers are unaffected.
 */
export type BuiltInMapControl =
  | "navigation"
  | "fullscreen"
  | "compass"
  | "geolocate"
  | "globe"
  | "terrain"
  | "scale"
  | "attribution"
  | "logo"
  | "maptoolkit-logo"
  | "layer-control";
