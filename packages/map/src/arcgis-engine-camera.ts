// ArcgisEngine layer: view, camera, navigation limits and fits.
// ArcgisEngine is split by concern across an inheritance chain, one layer per
// module: base <- terrain <- camera <- identify <- layers <- basemap <-
// ArcgisEngine; see arcgis-engine.ts.

import { boundsFillMinZoom, normalizeMapBounds } from "./map-bounds";
import type { GeoLibreLayer, MapViewState, StoryChapterLocation } from "@geolibre/core";
import type { FlyToCamera, MapExtent } from "./map-engine";
import { scaleToZoom, zoomToScale } from "./arcgis-layers";
import type { ArcgisSceneView, ArcgisView } from "./arcgis-sdk";
import { getLayerBounds } from "./geojson-loader";
import { safeProject, normalizeBearing } from "./arcgis-engine-base";
import { ArcgisEngineTerrain } from "./arcgis-engine-terrain";

/**
 * The view's zoom level. A MapView with no tiling scheme (the Blank basemap)
 * reports -1, so the level is derived from its scale there; a view with no
 * scale yet (before it is ready) reads as zoom 0 rather than a non-finite one.
 */
export function viewZoom(view: ArcgisView): number {
  if (view.zoom >= 0) return view.zoom;
  const zoom = view.scale > 0 ? scaleToZoom(view.scale) : Number.NaN;
  return Number.isFinite(zoom) ? zoom : 0;
}

/**
 * The view's scale at a zoom level. The SDK's levels follow the basemap's
 * tiling scheme (a 512 px vector basemap's level 6 is a 256 px scheme's level
 * 7), so the scale is taken from the view's own zoom-to-scale ratio; a view
 * with no levels (the Blank basemap) uses the standard scheme `viewZoom` reads.
 */
export function scaleForZoom(view: ArcgisView, zoom: number): number {
  return view.zoom >= 0 && view.scale > 0
    ? view.scale * 2 ** (view.zoom - zoom)
    : zoomToScale(zoom);
}

/**
 * A rejected `goTo` is worth a warning, not a render error: the SDK rejects
 * when a later move interrupts this one (routine) but also when a target is
 * malformed, and the second must not vanish silently.
 */
export function reportGoToFailure(error: unknown): void {
  const name = (error as { name?: string } | null)?.name;
  if (name === "view:goto-interrupted" || name === "AbortError") return;
  console.warn("[geolibre/arcgis] camera move failed", error);
}

/**
 * ArcgisEngine layer: reading and applying the view, zoom and rotation,
 * navigation limits, and fitting bounds and layers.
 */
export class ArcgisEngineCamera extends ArcgisEngineTerrain {
  /**
   * The last centre `readView` could convert to longitude/latitude. A view in
   * another projection can fail to convert a point outside the projection's
   * domain, and the shared camera must not jump to [0, 0] when it does.
   */
  private lastCenter: [number, number] = [0, 0];

  /** Whether the camera move in progress is a story chapter's or preview's. */
  protected storyMove = false;

  protected storyMoveLapse: ReturnType<typeof setTimeout> | undefined;

  // ------------------------------------------------------------------- camera

  readView(): MapViewState {
    const view = this.view;
    if (!view) return { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 };
    const center = this.lngLatOf(view.center) ?? this.lastCenter;
    this.lastCenter = center;
    const bounds = this.getViewBounds();
    return {
      center,
      zoom: viewZoom(view),
      bearing: this.bearing(),
      // A MapView has no pitch.
      pitch: view.type === "3d" ? (view.camera?.tilt ?? 0) : 0,
      ...(bounds ? { bbox: bounds } : {}),
    };
  }

  async applyView(view: MapViewState): Promise<void> {
    const old = this.readView();
    const target = this.constrainView(view);
    const scene = this.view?.type === "3d";
    if (
      Math.abs(old.center[0] - target.center[0]) < 1e-8 &&
      Math.abs(old.center[1] - target.center[1]) < 1e-8 &&
      Math.abs(old.zoom - target.zoom) < 1e-8 &&
      Math.abs(normalizeBearing(old.bearing) - normalizeBearing(target.bearing)) < 1e-8 &&
      // A MapView reads pitch as 0 whatever the store holds.
      (!scene || Math.abs(old.pitch - this.clampPitch(target.pitch)) < 1e-8)
    )
      return;
    try {
      await this.view?.goTo(
        {
          center: target.center,
          ...this.zoomTarget(target.zoom),
          ...this.orientation(target.bearing, target.pitch),
        },
        { animate: false },
      );
    } catch (error) {
      reportGoToFailure(error);
    }
  }

  /**
   * Place the camera at `view` and resolve once it is there. A new view
   * reports `stationary` at its constructor's default camera before the first
   * move lands, and a `SceneView` cannot be constructed at a heading and tilt;
   * the canvas awaits this before it lets camera changes reach the store, or
   * that default (north-up, untilted) would overwrite the project's view.
   */
  async settleView(view: MapViewState): Promise<void> {
    const target = this.constrainView(view);
    try {
      await this.view?.goTo(
        {
          center: target.center,
          ...this.zoomTarget(target.zoom),
          ...this.orientation(target.bearing, target.pitch),
        },
        { animate: false },
      );
    } catch (error) {
      reportGoToFailure(error);
    } finally {
      // The stored camera has landed; from here a settle outside the limits
      // is corrected (it may itself be outside the bounds).
      this.placed = true;
      this.constrainSettledView();
    }
  }

  easeToView(view: MapViewState): void {
    const target = this.constrainView(view);
    void this.view
      ?.goTo(
        {
          center: target.center,
          ...this.zoomTarget(target.zoom),
          ...this.orientation(target.bearing, target.pitch),
        },
        { duration: 500 },
      )
      .catch(reportGoToFailure);
  }

  /** Clamp a view to the project's zoom and world-copy preferences, as the other engines do. */
  private constrainView(view: MapViewState): {
    center: [number, number];
    zoom: number;
    bearing: number;
    pitch: number;
  } {
    const p = this.preferences;
    const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
    const { minZoom, maxZoom } = this.zoomRange();
    return {
      center: [
        !p || p.renderWorldCopies ? view.center[0] : clamp(view.center[0], -180, 180),
        clamp(view.center[1], -85, 85),
      ],
      zoom: clamp(view.zoom, minZoom, maxZoom),
      bearing: view.bearing,
      pitch: Number.isFinite(view.pitch) ? view.pitch : 0,
    };
  }

  readCameraAltitude(): number | null {
    // A MapView has a scale, not a camera.
    const z = this.sceneView()?.camera?.position.z;
    return typeof z === "number" && Number.isFinite(z) ? z : null;
  }

  flyTo(camera: FlyToCamera): void {
    const view = this.view;
    if (!view) return;
    void view
      .goTo(
        {
          ...(camera.center ? { center: camera.center } : {}),
          ...(camera.zoom !== undefined ? this.zoomTarget(camera.zoom) : {}),
          ...this.orientation(camera.bearing, camera.pitch),
        },
        { duration: camera.duration ?? 800 },
      )
      .catch(reportGoToFailure);
  }

  flyToView(location: StoryChapterLocation): void {
    // A chapter preview is scripted, like a chapter's own move.
    this.markStoryMove();
    this.flyTo(location);
  }

  /**
   * Flag the camera move now starting as a story move, so the settle that
   * ends it reports `storyCamera`. An instant jump may never change
   * `stationary`, so the flag also lapses shortly after the move.
   */
  protected markStoryMove(): void {
    this.storyMove = true;
    clearTimeout(this.storyMoveLapse);
    this.storyMoveLapse = setTimeout(() => {
      if (this.view?.stationary !== false) this.storyMove = false;
    }, 1500);
  }

  /**
   * One half turn at MapLibre's story pace (180° over 30 s), as the MapLibre
   * and Mapbox engines do; it stops there rather than orbiting forever.
   */
  protected rotate(): void {
    const view = this.view;
    if (!view) return;
    // MapLibre's story rotation turns the bearing forward; `rotation` runs
    // the other way to `heading`.
    const turn =
      view.type === "3d"
        ? { heading: (view.camera?.heading ?? 0) + 180 }
        : { rotation: view.rotation - 180 };
    this.markStoryMove();
    void view.goTo(turn, { duration: 30000, easing: "linear" }).catch(reportGoToFailure);
  }

  /**
   * A goTo zoom target. A view without a tiling scheme (the Blank basemap on
   * a MapView) reports `zoom` as -1 and cannot be sent to a zoom level, so
   * the level is given as the equivalent scale there.
   */
  protected zoomTarget(zoom: number): { zoom: number } | { scale: number } {
    return this.view && this.view.zoom < 0 ? { scale: zoomToScale(zoom) } : { zoom };
  }

  zoomIn(): void {
    const view = this.view;
    if (view)
      void view
        .goTo(this.zoomTarget(viewZoom(view) + 1), { duration: 500 })
        .catch(reportGoToFailure);
  }

  zoomOut(): void {
    const view = this.view;
    if (view)
      void view
        .goTo(this.zoomTarget(viewZoom(view) - 1), { duration: 500 })
        .catch(reportGoToFailure);
  }

  resetNorth(): void {
    void this.view
      ?.goTo(this.orientation(0, undefined), { duration: 1000 })
      .catch(reportGoToFailure);
  }

  resetNorthPitch(): void {
    void this.view?.goTo(this.orientation(0, 0), { duration: 1000 }).catch(reportGoToFailure);
  }

  resetPitch(): void {
    if (this.view?.type === "3d")
      void this.view.goTo({ tilt: 0 }, { duration: 1000 }).catch(reportGoToFailure);
  }

  fitBounds(bounds: MapExtent): void {
    const view = this.view;
    if (!view) return;
    if (bounds.some((value) => !Number.isFinite(value))) return;
    const [w, s, e, n] = bounds;
    // A point-sized extent cannot be fit; fly to the point at zoom 14 or
    // closer, as the MapLibre engine does. Any other extent is framed at
    // whatever zoom fits it.
    if (w === e && s === n) {
      void view
        .goTo(
          { center: [w, s], ...this.zoomTarget(Math.max(viewZoom(view), 14)) },
          { duration: 800 },
        )
        .catch(reportGoToFailure);
      return;
    }
    // The 2D map frames with 40 px padding; pad the extent by a tenth instead.
    const padX = Math.max((e - w) * 0.1, 1e-4);
    const padY = Math.max((n - s) * 0.1, 1e-4);
    const extent = new this.sdk.Extent({
      xmin: w - padX,
      ymin: Math.max(-85, s - padY),
      xmax: e + padX,
      ymax: Math.min(85, n + padY),
      spatialReference: { wkid: 4326 },
    });
    void view.goTo(extent, { duration: 800 }).catch(reportGoToFailure);
  }

  fitLayer(layer: GeoLibreLayer): boolean {
    const center = layer.metadata.center;
    const hasCenter =
      Array.isArray(center) &&
      center.length >= 2 &&
      center.slice(0, 2).every((v) => typeof v === "number" && Number.isFinite(v));
    // A tileset exposes only its center; look at it in perspective from a
    // conservative floor, as the MapLibre engine does (a scene only: a flat
    // view has no tilt).
    if (layer.type === "3d-tiles" && hasCenter && this.view) {
      this.flyTo({
        center: [center[0] as number, center[1] as number],
        zoom: Math.max(viewZoom(this.view), 14),
        ...(this.view.type === "3d" ? { pitch: Math.max(this.view.camera?.tilt ?? 0, 60) } : {}),
      });
      return true;
    }
    const bounds = getLayerBounds(layer);
    if (bounds) {
      // A tile source carries data only from its `minzoom` up; fitting the
      // whole extent would land below it and draw nothing, so fly to the
      // extent's center at that zoom instead.
      const minRenderZoom = [layer.source.minzoom, layer.metadata.minzoom].find(
        (value): value is number =>
          typeof value === "number" && Number.isFinite(value) && value > 0,
      );
      const fit = this.fitZoom(bounds);
      if (minRenderZoom !== undefined && fit !== null && fit < minRenderZoom) {
        this.flyTo({
          center: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2],
          zoom: minRenderZoom,
        });
        return true;
      }
      this.fitBounds(bounds);
      return true;
    }
    if (hasCenter) {
      this.flyTo({
        center: [center[0] as number, center[1] as number],
        zoom: typeof layer.metadata.zoom === "number" ? layer.metadata.zoom : 16,
      });
      return true;
    }
    // A service layer knows its own extent once loaded.
    const native = this.natives.get(layer.id)?.layers[0];
    if (!native?.fullExtent) return false;
    void this.view?.goTo(native.fullExtent, { duration: 800 }).catch(reportGoToFailure);
    return true;
  }

  /**
   * The zoom at which `bounds` fills the view, in Web Mercator, or null before
   * the view has a size. `fitBounds` lets the SDK frame the extent; this only
   * compares a fit against a zoom floor before moving.
   */
  private fitZoom(bounds: MapExtent): number | null {
    const view = this.view;
    if (!view || !(view.width > 0) || !(view.height > 0)) return null;
    const mercatorY = (lat: number) => {
      const clamped = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
      return Math.log(Math.tan(Math.PI / 4 + clamped / 2));
    };
    // Fractions of the world's width and height the extent spans.
    const spanX = Math.max((bounds[2] - bounds[0]) / 360, 1e-12);
    const spanY = Math.max((mercatorY(bounds[3]) - mercatorY(bounds[1])) / (2 * Math.PI), 1e-12);
    return Math.min(Math.log2(view.width / 256 / spanX), Math.log2(view.height / 256 / spanY));
  }

  /**
   * Hold the view to the project's zoom range, pitch limit and bounds. Rerun
   * when the view is ready, resized or given another zoom-level scheme (a
   * basemap swap): the bounds' minimum zoom depends on the view's size, and a
   * flat view's limits are scales in its own scheme.
   */
  protected applyNavigationLimits(): void {
    const p = this.preferences;
    const view = this.view;
    if (!p || !view) return;
    const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
    const { minZoom, maxZoom } = this.zoomRange();
    if (view.type === "3d") {
      // A SceneView's constraints are about the camera: the pitch limit
      // becomes the tilt limit and, on a globe, the zoom range an altitude
      // range. The bounds (and a local scene's zoom) are held by
      // `constrainSettledView` once the camera settles.
      if (view.constraints.tilt) view.constraints.tilt.max = clamp(p.maxPitch, 0, 85);
      // An unsized view has no diagonal to measure yet; the size watch
      // applies the range once it has one.
      if (view.viewingMode === "global" && view.width > 0 && view.height > 0)
        view.constraints.altitude = {
          min: this.altitudeForZoom(view, maxZoom),
          max: this.altitudeForZoom(view, minZoom),
        };
      this.constrainSettledView();
      return;
    }
    view.constraints = {
      // No SDK zoom limits: with zoom snapping off (MapLibre's continuous
      // zoom), the SDK refuses a wheel step that would cross a limit instead
      // of stopping at it, which can stop the wheel well short of the limit
      // or at the current zoom. The zoom range is held by the wheel guard in
      // the constructor and by `constrainSettledView`.
      minZoom: -1,
      maxZoom: -1,
      minScale: 0,
      maxScale: 0,
      rotationEnabled: true,
      snapToZoom: false,
      // The bounds are held by `constrainSettledView`, not the SDK's lateral
      // `geometry`: with a zoom limit as well, the SDK refuses to zoom out by
      // wheel at all. The SDK always wraps around the antimeridian, so
      // `renderWorldCopies` is only honoured for the views the app applies.
      geometry: null,
    };
    this.constrainSettledView();
  }

  /**
   * The project's zoom range in MapLibre levels. With restricted bounds the
   * minimum rises until the bounds fill the view, as on the 2D map.
   */
  protected zoomRange(): { minZoom: number; maxZoom: number } {
    const p = this.preferences;
    const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
    if (!p) return { minZoom: 0, maxZoom: 24 };
    const requested = clamp(p.minZoom, 0, 24);
    const view = this.view;
    const minZoom =
      view && view.width > 0 && view.height > 0
        ? boundsFillMinZoom(p, view.width, view.height, requested)
        : requested;
    return { minZoom, maxZoom: Math.max(minZoom, clamp(p.maxZoom, 0, 24)) };
  }

  /**
   * The camera height a nadir `SceneView` has at a MapLibre zoom level: the
   * height at which the view's diagonal field of view spans the zoom's
   * ground resolution (the SDK's scale is measured over the diagonal).
   */
  private altitudeForZoom(view: ArcgisSceneView, zoom: number): number {
    const metresPerPixel = (scaleForZoom(view, zoom) * 0.0254) / 96;
    const diagonal = Math.hypot(view.width || 1, view.height || 1);
    const fov = ((view.camera?.fov ?? 55) * Math.PI) / 180;
    return (metresPerPixel * diagonal) / (2 * Math.tan(fov / 2));
  }

  /**
   * Bring a settled view back inside the project's zoom range and bounds,
   * which the SDK's constraints cannot hold: a scene's altitude limit only
   * approximates the zoom range, and neither view limits the extent (see
   * `applyNavigationLimits`). Like the SDK's own lateral limit, it holds the
   * centre inside the bounds, where MapLibre keeps the whole viewport.
   */
  protected constrainSettledView(): void {
    const view = this.view;
    const p = this.preferences;
    // Not before the stored camera is placed: the view's default camera would
    // start a correction that interrupts `settleView`'s own move.
    if (!view || !p || !this.placed || !view.ready || !view.stationary || this.storyMove) return;
    const { minZoom, maxZoom } = this.zoomRange();
    const zoom = viewZoom(view);
    const bounds = p.restrictBounds ? normalizeMapBounds(p.bounds) : null;
    const settled = this.lngLatOf(view.center);
    // No geographic centre to clamp; correcting towards a substitute would move the map.
    if (!settled) return;
    const [lng, lat] = settled;
    const center: [number, number] = bounds
      ? [
          Math.min(bounds[2], Math.max(bounds[0], lng)),
          Math.min(bounds[3], Math.max(bounds[1], lat)),
        ]
      : [lng, lat];
    // A little slack, so the SDK's own rounding never starts a correction.
    const targetZoom = zoom < minZoom - 0.05 ? minZoom : zoom > maxZoom + 0.05 ? maxZoom : null;
    // The SDK's projection round trip can leave a settled centre a hair past
    // the edge it was moved to; that must not start another correction.
    const moved = Math.abs(center[0] - lng) > 1e-6 || Math.abs(center[1] - lat) > 1e-6;
    if (targetZoom === null && !moved) return;
    void view
      .goTo(
        { center, ...(targetZoom === null ? {} : this.zoomTarget(targetZoom)) },
        { duration: 300 },
      )
      .catch(reportGoToFailure);
  }

  getViewBounds(): MapExtent | null {
    const view = this.view;
    if (!view?.extent) return null;
    const projectOperator = this.options.projectOperator;
    const extent = view.spatialReference?.isWebMercator
      ? this.sdk.webMercatorUtils.webMercatorToGeographic(view.extent)
      : projectOperator && !view.spatialReference?.isWGS84
        ? safeProject(projectOperator, view.extent)
        : view.extent;
    if (!extent) return null;
    const bounds: MapExtent = [extent.xmin, extent.ymin, extent.xmax, extent.ymax];
    return bounds.every(Number.isFinite) ? bounds : null;
  }
}
