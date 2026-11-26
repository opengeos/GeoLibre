// MapController layer: map CRS, view constraints and style application.
// The MapController layer chain is documented in map-controller.ts.

import {
  normalizeMapCrs,
  type GeoLibreLayer,
  type MapPreferences,
  type MapProjection,
} from "@geolibre/core";
import * as maplibregl from "maplibre-gl";
import { getLayerMetadataBounds } from "./layer-control-host";
import { getLayerBounds } from "./geojson-loader";
import { loadedVectorTileFeatureBounds } from "./loaded-feature-bounds";
import { globeSafeMaxZoom } from "./globe-fit-bounds";
import { isMapboxStyleUrl, loadMapboxStyle, redactMapboxStyleUrl } from "./mapbox-style";
import {
  boundsFillMinZoom,
  latFromMercatorY,
  lngFromMercatorX,
  mercatorBoundsForLngLatBounds,
  mercatorXFromLng,
  mercatorYFromLat,
  normalizeMapBounds,
} from "./map-bounds";
import { resolveMapStyle } from "./basemap-style";
import { requestInitialMapCrsFrame, setActiveMapCrs, type ResolvedMapCrs } from "./active-map-crs";
import { createMapCrsStyle, registerMapCrs, resolveMapCrs } from "./map-crs";
import { cameraForMapCrsBox, placeExtentInMapCrs, type MapCrsConverter } from "./map-crs-fit";
import { MapControllerControls } from "./map-controller-controls";

const DEFAULT_PROJECTION: maplibregl.ProjectionSpecification = {
  type: "globe",
};

/** Edge margin, in CSS pixels, kept free when fitting the camera to an extent. */
export const FIT_BOUNDS_PADDING = 40;

export function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function createMapTransformConstraint(
  preferences: MapPreferences,
  map: maplibregl.Map,
  minZoom: number,
  maxZoom: number,
): Parameters<maplibregl.Map["setTransformConstrain"]>[0] {
  return (lngLat, zoom) => {
    const constrainedZoom = clampNumber(zoom, minZoom, maxZoom);
    const bounds = preferences.restrictBounds && normalizeMapBounds(preferences.bounds);
    if (!bounds) {
      return {
        center: new maplibregl.LngLat(
          preferences.renderWorldCopies ? lngLat.lng : clampNumber(lngLat.lng, -180, 180),
          clampNumber(lngLat.lat, -85, 85),
        ),
        zoom: constrainedZoom,
      };
    }

    return {
      center: constrainCenterToVisibleBounds(
        [lngLat.lng, lngLat.lat],
        bounds,
        map,
        constrainedZoom,
      ),
      zoom: constrainedZoom,
    };
  };
}

export function effectiveMinZoomForPreferences(
  preferences: MapPreferences,
  map: maplibregl.Map,
  requestedMinZoom: number,
): number {
  const canvas = map.getCanvas();
  return boundsFillMinZoom(preferences, canvas.clientWidth, canvas.clientHeight, requestedMinZoom);
}

function constrainCenterToVisibleBounds(
  center: [number, number],
  bounds: MapPreferences["bounds"],
  map: maplibregl.Map,
  zoom: number,
): maplibregl.LngLat {
  const mercatorBounds = mercatorBoundsForLngLatBounds(bounds);
  const worldSize = 512 * 2 ** zoom;
  const halfWidth = map.getCanvas().clientWidth / (2 * worldSize);
  const halfHeight = map.getCanvas().clientHeight / (2 * worldSize);
  const centerMercator = {
    x: mercatorXFromLng(center[0]),
    y: mercatorYFromLat(center[1]),
  };
  const minX = mercatorBounds.west + halfWidth;
  const maxX = mercatorBounds.east - halfWidth;
  const minY = mercatorBounds.north + halfHeight;
  const maxY = mercatorBounds.south - halfHeight;

  return new maplibregl.LngLat(
    lngFromMercatorX(
      minX <= maxX
        ? clampNumber(centerMercator.x, minX, maxX)
        : (mercatorBounds.west + mercatorBounds.east) / 2,
    ),
    latFromMercatorY(
      minY <= maxY
        ? clampNumber(centerMercator.y, minY, maxY)
        : (mercatorBounds.north + mercatorBounds.south) / 2,
    ),
  );
}

/** A 3D Tiles layer's advertised `[lng, lat]` center, or null. */
export function tilesetCenter(layer: GeoLibreLayer): [number, number] | null {
  const center = layer.metadata.center;
  return Array.isArray(center) &&
    typeof center[0] === "number" &&
    typeof center[1] === "number" &&
    Number.isFinite(center[0]) &&
    Number.isFinite(center[1])
    ? [center[0], center[1]]
    : null;
}

export function mapBoundsForPreferences(
  preferences: MapPreferences,
): maplibregl.LngLatBoundsLike | null {
  const bounds = preferences.restrictBounds && normalizeMapBounds(preferences.bounds);
  if (!bounds) return null;

  return [
    [bounds[0], bounds[1]],
    [bounds[2], bounds[3]],
  ];
}

/**
 * MapController layer: the map CRS (projection, constraints, fits within the
 * CRS) and applying basemap styles to the map.
 */
export class MapControllerStyle extends MapControllerControls {
  // Bumped on every style application so an asynchronously resolved style (the
  // Mapbox path in applyStyleToMap) can tell whether it is still the current one.
  private styleGeneration = 0;

  // Aborts the in-flight Mapbox descriptor request, so a superseded basemap
  // change (or destroy) does not leave the fetch running.
  private pendingMapboxStyleAbort: AbortController | null = null;

  /** The page-side converter for `activeCrs`, used to frame extents in it. */
  protected activeCrsConverter: MapCrsConverter | null = null;

  /** The normalized `mapCrs` the map is moving to, set before it resolves. */
  protected desiredCrsId: string | undefined;

  /** Bumped per CRS change so a slow resolution cannot overwrite a newer one. */
  protected crsGeneration = 0;

  /**
   * Whether the map still shows the blank style it was created with while its
   * CRS resolved (init), so a CRS that is cleared or fails before then must
   * apply the basemap itself.
   */
  protected crsStyleDeferred = false;

  /** A `mapCrs` that could not be drawn, not retried until the preference changes. */
  protected failedCrsId: string | undefined;

  /**
   * Whether the store set a view since the last CRS change began. Opening a
   * project applies its preferences and then its saved view in one commit, so
   * the CRS switch that follows must keep that view rather than frame its area.
   */
  protected storeViewSinceCrsChange = false;

  /** A link named a CRS and no view: the store's echo of the default view does not count. */
  protected initialCrsFrame = false;

  protected basemapOriginalPaintValues = new Map<string, Map<string, unknown>>();

  /**
   * Keep every `fitBounds` on `map` on the custom CRS's tile grid, including
   * the ones plugin controls make on the MapLibre map directly (the PMTiles
   * panel frames each archive it adds that way, #3516). MapLibre fits a box
   * off the grid and then clamps the camera to the grid edge, far from the
   * data; this skips such a fit, and frames only the on-grid part of a box
   * that straddles the edge. On the default map it is a pass-through.
   */
  protected guardMapCrsFits(map: maplibregl.Map): void {
    const fitBounds = map.fitBounds.bind(map);
    map.fitBounds = (...args: Parameters<maplibregl.Map["fitBounds"]>) => {
      if (this.map === map && this.activeCrs && this.activeCrsConverter) {
        const [bounds, options, eventData] = args;
        let box: [number, number, number, number] | null = null;
        try {
          const lngLat = maplibregl.LngLatBounds.convert(bounds);
          box = [lngLat.getWest(), lngLat.getSouth(), lngLat.getEast(), lngLat.getNorth()];
        } catch {
          // Not a box MapLibre reads either; let it report that.
        }
        // The caller's animation and zoom ceiling carry over to a clipped fit.
        const fit = {
          padding: typeof options?.padding === "number" ? options.padding : FIT_BOUNDS_PADDING,
          duration: options?.duration,
          animate: options?.animate,
          maxZoom: options?.maxZoom,
          eventData,
        };
        if (box && box.every(Number.isFinite) && this.fitInMapCrs(box, null, fit) !== null) {
          return map;
        }
      }
      return fitBounds(...args);
    };
  }

  /** The CRS the map is drawn in, or `null` on the default Web Mercator map or globe. */
  getMapCrs(): ResolvedMapCrs | null {
    return this.activeCrs;
  }

  /**
   * Tears down the state that belongs to the outgoing style, immediately before
   * the incoming one is handed to MapLibre. `style.load` rebuilds all of it.
   *
   * Deliberately called per style application rather than at the top of
   * `setStyle`: the Mapbox path below only reaches `map.setStyle` after an
   * asynchronous fetch, and tearing down first would leave the controller
   * wedged if that fetch failed — `styleReady` stuck false with no `style.load`
   * coming to clear it, so layer syncing, basemap visibility/opacity and the
   * layer control would all stay disabled over a still-rendered old style.
   */
  private beginStyleSwap(): void {
    this.styleReady = false;
    this.basemapOriginalPaintValues.clear();
    this.removeLayerControl();
  }

  /**
   * Hands a basemap style URL to MapLibre.
   *
   * Everything except Mapbox resolves synchronously, so `setStyle` is handed the
   * URL (or the inline style a GeoLibre sentinel expands to) directly. Mapbox
   * style descriptors are Mapbox-flavored and must be fetched and rewritten
   * before MapLibre will accept them (see ./mapbox-style), which makes that path
   * asynchronous: a generation counter drops the result of a swap the user has
   * already superseded, so a slow descriptor can never overwrite a newer
   * basemap. Validation is off for those, matching how the basemap control
   * applies them — the descriptor is transformed to spec, not authored here.
   */
  protected applyStyleToMap(url: string): void {
    const map = this.map;
    if (!map) return;
    const generation = ++this.styleGeneration;
    // Drop any descriptor still in flight for the basemap this one replaces:
    // its result is already destined for the generation check below, so the
    // request is pure waste. Also covers a request that never settles, which
    // would otherwise keep its closure (and this controller) alive.
    this.abortPendingMapboxStyle();

    // A map in a custom CRS draws its own basemap (or none): Web Mercator
    // basemaps would land in the wrong place. The URL is kept for the way back.
    if (this.activeCrs) {
      this.beginStyleSwap();
      map.setStyle(createMapCrsStyle(this.activeCrs), { diff: false });
      return;
    }

    if (!isMapboxStyleUrl(url)) {
      this.beginStyleSwap();
      // GeoLibre deliberately rebuilds every style-owned control and layer in
      // style.load, so diffing cannot preserve any work for us. Disabling it
      // also avoids MapLibre's noisy fallback when a second basemap arrives
      // before the current style has finished loading.
      map.setStyle(resolveMapStyle(url), { diff: false });
      return;
    }

    const pending = new AbortController();
    this.pendingMapboxStyleAbort = pending;
    void loadMapboxStyle(url, pending.signal)
      .then((style) => {
        if (this.map !== map || this.styleGeneration !== generation) return;
        this.beginStyleSwap();
        map.setStyle(style, { diff: false, validate: false });
      })
      .catch((error: unknown) => {
        if (this.map !== map || this.styleGeneration !== generation) return;
        // Nothing was torn down (beginStyleSwap runs only on success), so the
        // controller stays fully live over the style it already had — better
        // than blanking the map. The basemap control watches its own parallel
        // setStyle and rolls the basemap back through the store when a provider
        // style fails, which arrives here as a newer generation.
        // The URL carries the user's access_token, so log the descriptor id only.
        console.warn(
          `Failed to load the Mapbox basemap style "${redactMapboxStyleUrl(url)}".`,
          error,
        );
      })
      .finally(() => {
        if (this.pendingMapboxStyleAbort === pending) {
          this.pendingMapboxStyleAbort = null;
        }
      });
  }

  /**
   * Cancels an in-flight Mapbox descriptor request, if any.
   *
   * An abort rejects the fetch with an `AbortError`, but that rejection always
   * lands on a superseded generation (this is only called after bumping it, or
   * from `destroy`, which nulls the map), so the handlers above return before
   * reaching the warning — no aborted request is ever reported as a failure.
   */
  protected abortPendingMapboxStyle(): void {
    this.pendingMapboxStyleAbort?.abort();
    this.pendingMapboxStyleAbort = null;
  }

  /**
   * Install the bounds and transform constraint for the map as it is drawn now.
   * They are Web Mercator math, so a map in another CRS keeps MapLibre's own
   * constraint, which knows the CRS's edge. Keyed on the CRS actually applied,
   * not the preference, so a CRS still resolving (or one that failed) leaves
   * the default map constrained as usual.
   *
   * Args:
   *   minZoom: The effective minimum zoom.
   *   maxZoom: The effective maximum zoom.
   */
  protected applyViewConstraints(minZoom: number, maxZoom: number): void {
    if (!this.map) return;
    if (this.activeCrs) {
      this.map.setMaxBounds(null);
      this.map.setTransformConstrain(null);
      return;
    }
    this.map.setMaxBounds(mapBoundsForPreferences(this.mapPreferences));
    this.map.setTransformConstrain(
      createMapTransformConstraint(this.mapPreferences, this.map, minZoom, maxZoom),
    );
  }

  /**
   * Whether a layer's extent lies wholly off the tile grid of the custom CRS
   * the map is drawn in, so Zoom to layer has nowhere to go (#3516). False on
   * the default map, or when the extent is unknown.
   */
  isLayerOutsideMapCrs(layer: GeoLibreLayer): boolean {
    const crs = this.activeCrs;
    const converter = this.activeCrsConverter;
    if (!crs || !converter) return false;
    // A tileset with an on-grid center is framed by it (fitLayer); otherwise
    // by its bounds, when it has any.
    const center = layer.type === "3d-tiles" ? tilesetCenter(layer) : null;
    if (center && !this.isExtentOutsideMapCrs([center[0], center[1], center[0], center[1]])) {
      return false;
    }
    const bounds = this.resolveLayerBounds(layer);
    return bounds ? this.isExtentOutsideMapCrs(bounds) : center !== null;
  }

  /** Whether `bounds` lies wholly off the active custom CRS's tile grid. */
  protected isExtentOutsideMapCrs(bounds: [number, number, number, number]): boolean {
    const crs = this.activeCrs;
    const converter = this.activeCrsConverter;
    if (!crs || !converter) return false;
    return placeExtentInMapCrs(bounds, converter, crs.tileMatrixSet)?.kind === "outside";
  }

  /**
   * Frame `bounds` on a map in a custom CRS when it does not lie wholly on the
   * CRS's tile grid.
   *
   * Returns:
   *   null to let the ordinary fit run (the default map, or an extent on the
   *   grid); false, without moving, for an extent wholly off the grid; true
   *   after flying to the part of the extent that is on the grid.
   */
  protected fitInMapCrs(
    bounds: [number, number, number, number],
    minRenderZoom: number | null,
    options: {
      padding?: number;
      duration?: number;
      animate?: boolean;
      maxZoom?: number;
      /** Passed on to the camera move, as MapLibre's own fitBounds does. */
      eventData?: unknown;
    } = {},
  ): boolean | null {
    const map = this.map;
    const crs = this.activeCrs;
    const converter = this.activeCrsConverter;
    if (!map || !crs || !converter) return null;
    const placement = placeExtentInMapCrs(bounds, converter, crs.tileMatrixSet);
    if (!placement || placement.kind === "inside") return null;
    if (placement.kind === "outside") return false;
    // From here the extent straddles the grid edge, so an ordinary fit would
    // be clamped: when no camera can be worked out, stay put instead.
    const viewport = this.getViewportSize();
    if (!viewport) return false;
    const camera = cameraForMapCrsBox(
      placement.box,
      converter,
      crs.tileMatrixSet,
      viewport,
      options.padding ?? FIT_BOUNDS_PADDING,
    );
    if (!camera) return false;
    const zoom = Math.min(
      Math.max(camera.zoom, minRenderZoom ?? 0),
      typeof map.getMaxZoom === "function" ? map.getMaxZoom() : 24,
      options.maxZoom ?? Infinity,
    );
    map.flyTo(
      {
        center: camera.center,
        zoom,
        bearing: 0,
        duration: options.duration ?? 800,
        ...(options.animate === undefined ? {} : { animate: options.animate }),
      },
      options.eventData as Parameters<maplibregl.Map["flyTo"]>[1],
    );
    return true;
  }

  /**
   * A layer's extent: its own features or advertised bounds first, then its
   * live source's bounds (TileJSON), then, for a vector-tile layer with none of
   * those (a bare `{z}/{x}/{y}` template), the extent of the features loaded so
   * far.
   */
  protected resolveLayerBounds(layer: GeoLibreLayer): [number, number, number, number] | null {
    return (
      getLayerBounds(layer) ??
      getLayerMetadataBounds(layer) ??
      this.getLayerSourceBounds(layer) ??
      loadedVectorTileFeatureBounds(this.map, layer, this.getLayerSourceIds(layer))
    );
  }

  /**
   * The map viewport in CSS pixels, or null when the canvas has not been laid
   * out yet (a fresh or detached container reports zero) and any size-derived
   * calculation would be nonsense.
   */
  protected getViewportSize(): { width: number; height: number } | null {
    const canvas = typeof this.map?.getCanvas === "function" ? this.map.getCanvas() : undefined;
    const width = canvas?.clientWidth ?? 0;
    const height = canvas?.clientHeight ?? 0;
    return width > 0 && height > 0 ? { width, height } : null;
  }

  fitBounds(bounds: [number, number, number, number]): void {
    if (!this.map) return;
    if (bounds.some((value) => !Number.isFinite(value))) return;
    // A plugin's own fit (the PMTiles header bounds, #3516) comes through here
    // rather than fitLayer: keep it on the custom CRS's grid too.
    if (this.fitInMapCrs(bounds, null) !== null) return;
    // A degenerate point-sized box cannot be fit; fly to the point instead.
    if (bounds[0] === bounds[2] && bounds[1] === bounds[3]) {
      this.map.flyTo({
        center: [bounds[0], bounds[1]],
        zoom: Math.max(this.map.getZoom(), 14),
        duration: 800,
      });
      return;
    }
    // An extent wider than the hemisphere a globe can show has no camera that
    // contains it, and MapLibre's globe fit answers one of those by zooming *in*,
    // leaving the data behind the horizon. Cap those at the flat-map zoom so they
    // settle on a whole-globe view instead; narrower fits are untouched.
    const maxZoom = globeSafeMaxZoom(bounds, this.getViewportSize(), FIT_BOUNDS_PADDING);
    this.map.fitBounds(
      [
        [bounds[0], bounds[1]],
        [bounds[2], bounds[3]],
      ],
      {
        padding: FIT_BOUNDS_PADDING,
        duration: 800,
        ...(maxZoom === null ? {} : { maxZoom }),
      },
    );
  }

  /** Current map projection, normalized to the two values we persist. */
  readProjection(): MapProjection {
    // A custom CRS is flat, like Mercator; it is persisted as `mapCrs`.
    if (this.activeCrs) return "mercator";
    return this.map?.getProjection()?.type === "mercator" ? "mercator" : "globe";
  }

  /**
   * Move the map into the CRS `preferences.map.mapCrs` names, or back to the
   * default map, when that preference changed.
   *
   * Resolving an EPSG code loads the EPSG tables and proj4, so it is
   * asynchronous; a generation counter drops a result the user has already
   * superseded. Entering or leaving a CRS re-applies the style (see
   * applyStyleToMap), which rebuilds every layer in the new grid.
   *
   * Args:
   *   frame: Fit the view to the CRS's area when the current center lies
   *     outside it. Off for the CRS a map is created in, which keeps the
   *     project's saved view.
   */
  protected syncMapCrs(frame: boolean): void {
    const map = this.map;
    if (!map) return;
    const desired = normalizeMapCrs(this.mapPreferences.mapCrs);
    if (desired === this.desiredCrsId || (desired !== undefined && desired === this.failedCrsId)) {
      return;
    }
    this.failedCrsId = undefined;
    this.desiredCrsId = desired;
    this.storeViewSinceCrsChange = false;
    const generation = ++this.crsGeneration;
    if (desired === undefined) {
      this.showDefaultMap(frame);
      return;
    }
    const current = () => this.map === map && this.crsGeneration === generation;
    // A CRS that cannot be drawn leaves the default map, with its projection,
    // rather than the blank style or the previous CRS.
    const fallBack = () => {
      requestInitialMapCrsFrame(false);
      this.initialCrsFrame = false;
      this.failedCrsId = desired;
      this.desiredCrsId = undefined;
      this.showDefaultMap(false);
      this.enforceProjection();
    };
    void resolveMapCrs(desired)
      .then(async (crs) => {
        if (!current()) return;
        if (!crs) {
          console.warn(`Map CRS "${desired}" could not be resolved; drawing the default map.`);
          fallBack();
          return;
        }
        const converter = await registerMapCrs(crs);
        if (current()) this.applyMapCrs(crs, frame, converter);
      })
      .catch((error: unknown) => {
        if (!current()) return;
        console.warn(`Failed to switch the map to CRS "${desired}".`, error);
        fallBack();
      });
  }

  /** Leave a custom CRS, or replace the blank style a CRS map was created with. */
  private showDefaultMap(frame: boolean): void {
    if (this.activeCrs) {
      this.applyMapCrs(null, frame);
    } else if (this.crsStyleDeferred) {
      this.crsStyleDeferred = false;
      this.applyStyleToMap(this.basemapStyleUrl);
    }
  }

  /**
   * Draw the map in `crs` (or the default map for `null`) from a fresh style.
   *
   * Zoom levels of different grids are different scales, so a switch frames
   * the area the new map shows: a preset's own box, or an EPSG CRS's whole tile
   * grid, on the way in, and on the way out the box of the CRS being left (Web
   * Mercator stops at ±85°). Skipped when the store set a view meanwhile (a
   * project opening with its saved view).
   */
  private applyMapCrs(
    crs: ResolvedMapCrs | null,
    frame: boolean,
    converter: MapCrsConverter | null = null,
  ): void {
    const map = this.map;
    if (!map) return;
    const previous = this.activeCrs;
    this.activeCrs = crs;
    this.activeCrsConverter = crs ? converter : null;
    this.crsStyleDeferred = false;
    setActiveMapCrs(map, crs);
    const requestedMinZoom = clampNumber(this.mapPreferences.minZoom, 0, 24);
    const minZoom = effectiveMinZoomForPreferences(this.mapPreferences, map, requestedMinZoom);
    this.applyViewConstraints(
      minZoom,
      Math.max(minZoom, clampNumber(this.mapPreferences.maxZoom, 0, 24)),
    );
    // The globe toggle has nothing to switch to in a custom CRS.
    if (crs) this.removeGlobeControl();
    else this.addGlobeControl();
    this.applyStyleToMap(this.basemapStyleUrl);
    this.scaleControl?.refresh();
    if (!frame) return;
    let frameView: (() => void) | undefined;
    const box = crs ? crs.bounds : previous?.bounds;
    if (box) {
      const maxLat = crs ? 90 : 85;
      frameView = () =>
        map.fitBounds(
          [
            [box[0], Math.max(box[1], -maxLat)],
            [box[2], Math.min(box[3], maxLat)],
          ],
          { padding: FIT_BOUNDS_PADDING, animate: false },
        );
    } else if (crs?.gridCenter) {
      const center = crs.gridCenter;
      // Zoom 0 draws the grid's square 512 px wide; fit it to the canvas.
      frameView = () => {
        const canvas = map.getCanvas();
        const side = Math.max(1, Math.min(canvas.clientWidth, canvas.clientHeight));
        map.jumpTo({ center, zoom: Math.max(0, Math.log2(side / 512)), bearing: 0, pitch: 0 });
      };
    }
    if (!frameView) {
      this.initialCrsFrame = false;
      requestInitialMapCrsFrame(false);
      return;
    }
    const run = frameView;
    // After the style has set the projection: before it, the view would be
    // fitted in the outgoing one.
    map.once("style.load", () => {
      if (this.map !== map || this.activeCrs !== crs) return;
      const keepView = this.storeViewSinceCrsChange && !this.initialCrsFrame;
      this.initialCrsFrame = false;
      if (keepView) return;
      requestInitialMapCrsFrame(false);
      run();
    });
  }

  protected enforceProjection(): void {
    if (!this.map) return;
    if (this.desiredCrsId !== undefined) {
      // The CRS style carries its projection; this only reverts a stray
      // setProjection (a plugin, a script). Nothing to do while it resolves.
      const code = this.activeCrs?.code;
      if (!code || this.map.getProjection()?.type === code) return;
      try {
        this.map.setProjection({ type: code });
      } catch {
        this.map.once("idle", () => this.enforceProjection());
      }
      return;
    }
    const desired = this.mapPreferences.projection ?? DEFAULT_PROJECTION.type;
    try {
      if (this.map.getProjection()?.type === desired) return;
      this.map.setProjection({ type: desired });
    } catch {
      this.map.once("idle", () => this.enforceProjection());
    }
  }
}
