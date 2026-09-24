import { useAppStore } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import type { Feature, Position } from "geojson";
import type { Map as MapLibreMap } from "maplibre-gl";
import { engineStyleMap } from "./engine-style-map";
import { clearAtlasFeatureMask, showAtlasFeatureMask } from "./print-atlas-mask";

/** `[west, south, east, north]` in degrees. */
export type AtlasCameraBounds = [number, number, number, number];

/** Pixels kept clear on each side when fitting a page, in CSS pixels. */
export interface AtlasCameraPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * The camera operations the Print Layout atlas drives for each page, on any
 * flat map. On a Style Spec engine they are the map's own (`fitBounds` with
 * padding, `idle`, the mask as a style layer); on another engine (ArcGIS)
 * they go through the {@link MapEngine} and its render surface, and the mask
 * is painted onto the capture instead of drawn on the map.
 */
export interface AtlasCamera {
  /** The canvas whose CSS size is the viewport the page is framed in. */
  canvas: HTMLCanvasElement;
  /** Device pixels per CSS pixel of {@link canvas}. */
  pixelRatio: number;
  /** A graticule labels the map edges, so pages fit with "contain". */
  containMap: boolean;
  /** Mask everything outside the page's polygon feature, or clear the mask. */
  showMask(feature: Feature | undefined): void;
  /** Frame `bounds` inside the viewport less `padding`, north up, at once. */
  fit(bounds: AtlasCameraBounds, padding: AtlasCameraPadding): Promise<void>;
  /** Resolve once the map has settled and drawn, or after a grace timeout. */
  settle(): Promise<void>;
  zoom(): number;
  minZoom(): number;
  maxZoom(): number;
  setZoom(zoom: number): Promise<void>;
  /** The geographic position under a viewport pixel, or `null` off the map. */
  unproject(x: number, y: number): [number, number] | null;
  /** The visible bounds. */
  bounds(): AtlasCameraBounds;
  /**
   * Paint what the live map does not show onto a capture of the whole
   * viewport (the mask, off a Style Spec engine). `scale` is capture pixels
   * per CSS pixel.
   */
  decorate?(context: CanvasRenderingContext2D, scale: number): void;
}

/** How long a page waits for the map to settle before capturing anyway. */
const SETTLE_TIMEOUT_MS = 2500;

/**
 * The atlas camera for the live map, or `null` when there is no flat map to
 * drive (no engine yet, or a globe-only engine).
 *
 * @param engine - The live map engine.
 * @param graticuleLabelLayerId - The graticule's label layer: when the map
 *   has it, pages fit with "contain" and the mask stays under it.
 * @returns The camera, or `null`.
 */
export function atlasCamera(
  engine: MapEngine | null | undefined,
  graticuleLabelLayerId?: string,
): AtlasCamera | null {
  if (!engine || !engine.capabilities.flatProjection) return null;
  const map = engineStyleMap(engine);
  if (map) return styleMapCamera(map, engine, graticuleLabelLayerId);
  // The engine camera frames pages on a flat Web Mercator map; a globe (the
  // ArcGIS SceneView) has no such fit.
  if (engine.readProjection() === "globe") return null;
  const surface = engine.getRenderSurface();
  return surface ? engineCamera(engine, surface) : null;
}

function cssPixelRatio(canvas: HTMLCanvasElement, reported?: number): number {
  // An unlaid-out canvas (clientWidth 0) has no ratio to read, so fall back
  // to the device's.
  const ratio =
    reported ??
    (canvas.clientWidth > 0 ? canvas.width / canvas.clientWidth : window.devicePixelRatio || 1);
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

function styleMapCamera(
  map: MapLibreMap,
  engine: MapEngine,
  graticuleLabelLayerId: string | undefined,
): AtlasCamera {
  const canvas = map.getCanvas();
  const containMap = Boolean(graticuleLabelLayerId && map.getLayer(graticuleLabelLayerId));
  const settle = () =>
    new Promise<void>((resolve) => {
      // With a grace timeout: browsers may throttle the occluded canvas behind
      // the dialog and delay "idle" indefinitely (same failure mode as GH
      // #743); the capture forces a redraw, so proceeding is safe.
      let done = false;
      let timer = 0;
      const finish = () => {
        if (done) return;
        done = true;
        map.off("idle", finish);
        window.clearTimeout(timer);
        resolve();
      };
      map.on("idle", finish);
      timer = window.setTimeout(finish, SETTLE_TIMEOUT_MS);
    });
  return {
    canvas,
    // mapbox-gl has no getPixelRatio; the canvas carries the same ratio.
    pixelRatio: cssPixelRatio(
      canvas,
      typeof map.getPixelRatio === "function" ? map.getPixelRatio() : undefined,
    ),
    containMap,
    showMask(feature) {
      if (!feature) {
        clearAtlasFeatureMask(map);
        return;
      }
      showAtlasFeatureMask(map, feature, containMap ? graticuleLabelLayerId : undefined, {
        mapbox: engine.kind === "mapbox",
      });
    },
    async fit([w, s, e, n], padding) {
      map.fitBounds(
        [
          [w, s],
          [e, n],
        ],
        { animate: false, padding },
      );
    },
    settle,
    zoom: () => map.getZoom(),
    minZoom: () => map.getMinZoom(),
    maxZoom: () => map.getMaxZoom(),
    async setZoom(zoom) {
      map.setZoom(zoom);
    },
    unproject(x, y) {
      const point = map.unproject([x, y]);
      return [point.lng, point.lat];
    },
    bounds() {
      const b = map.getBounds();
      return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    },
  };
}

function engineCamera(
  engine: MapEngine,
  surface: NonNullable<ReturnType<MapEngine["getRenderSurface"]>>,
): AtlasCamera {
  const canvas = surface.getCanvas();
  let mask: Feature | null = null;
  const settle = () =>
    engine.whenDrawn
      ? engine.whenDrawn(SETTLE_TIMEOUT_MS)
      : new Promise<void>((resolve) => {
          let done = false;
          let stop = () => {};
          let timer = 0;
          const finish = () => {
            if (done) return;
            done = true;
            stop();
            window.clearTimeout(timer);
            resolve();
          };
          // Either may answer at once, before the other is set up.
          timer = window.setTimeout(finish, SETTLE_TIMEOUT_MS);
          stop = engine.onCameraIdle(finish);
          if (done) stop();
        });
  const viewport = () => {
    const container = surface.getContainer();
    return {
      width: container.clientWidth || canvas.clientWidth,
      height: container.clientHeight || canvas.clientHeight,
    };
  };
  return {
    canvas,
    pixelRatio: cssPixelRatio(canvas),
    containMap: false,
    showMask(feature) {
      mask =
        feature?.geometry?.type === "Polygon" || feature?.geometry?.type === "MultiPolygon"
          ? feature
          : null;
    },
    async fit(bounds, padding) {
      const { width, height } = viewport();
      const camera = fitCamera(bounds, width, height, padding);
      await engine.applyView({ ...camera, bearing: 0, pitch: 0 });
    },
    settle,
    zoom: () => engine.readView().zoom,
    // The project's limits, which `applyMapPreferences` gives the engine.
    minZoom: () => clampZoom(useAppStore.getState().preferences.map.minZoom, 0),
    maxZoom: () => clampZoom(useAppStore.getState().preferences.map.maxZoom, 24),
    async setZoom(zoom) {
      await engine.applyView({ ...engine.readView(), zoom });
    },
    unproject(x, y) {
      const point = surface.unproject([x, y]);
      return point ? [point.lng, point.lat] : null;
    },
    bounds() {
      const extent = engine.getViewBounds();
      return extent ? [extent[0], extent[1], extent[2], extent[3]] : [-180, -85, 180, 85];
    },
    decorate(context, scale) {
      if (mask) paintAtlasMask(context, mask, (position) => surface.project(position), scale);
    },
  };
}

function clampZoom(zoom: number, fallback: number): number {
  return Number.isFinite(zoom) ? Math.min(24, Math.max(0, zoom)) : fallback;
}

function mercatorX(lng: number): number {
  return (lng + 180) / 360;
}

function mercatorY(lat: number): number {
  const radians = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  return (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2;
}

/**
 * The north-up camera that frames `bounds` inside a `width` × `height`
 * viewport less `padding`, as MapLibre's `fitBounds` computes it (Web
 * Mercator, a 512 px world at zoom 0). A zero-size box (a point page) frames
 * at zoom 22.
 *
 * @param bounds - `[west, south, east, north]` in degrees.
 * @param width - The viewport width in CSS pixels.
 * @param height - The viewport height in CSS pixels.
 * @param padding - Pixels kept clear on each side.
 * @returns The camera's centre and zoom.
 */
export function fitCamera(
  [west, south, east, north]: AtlasCameraBounds,
  width: number,
  height: number,
  padding: AtlasCameraPadding,
): { center: [number, number]; zoom: number } {
  const x0 = mercatorX(west);
  // A box across the antimeridian has its east edge past 180 degrees.
  const x1 = mercatorX(east < west ? east + 360 : east);
  const y0 = mercatorY(north);
  const y1 = mercatorY(south);
  const availableWidth = Math.max(1, width - padding.left - padding.right);
  const availableHeight = Math.max(1, height - padding.top - padding.bottom);
  const spanX = Math.max(1e-12, x1 - x0);
  const spanY = Math.max(1e-12, y1 - y0);
  const zoom = Math.min(
    22,
    Math.max(
      0,
      Math.log2(Math.min(availableWidth / (512 * spanX), availableHeight / (512 * spanY))),
    ),
  );
  // The box sits at the centre of the padded frame, not of the viewport.
  const worldSize = 512 * 2 ** zoom;
  const cx = (x0 + x1) / 2 - (padding.left - padding.right) / 2 / worldSize;
  const cy = (y0 + y1) / 2 - (padding.top - padding.bottom) / 2 / worldSize;
  const lng = cx * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * cy))) * 180) / Math.PI;
  return { center: [lng > 180 ? lng - 360 : lng < -180 ? lng + 360 : lng, lat], zoom };
}

/**
 * Paint the atlas mask, a translucent white over everything outside a
 * polygon feature (the style-layer mask's `#ffffff` at 0.7), onto a capture.
 *
 * @param context - The capture's 2D context.
 * @param feature - A Polygon or MultiPolygon feature.
 * @param project - Geographic position to viewport CSS pixels.
 * @param scale - Capture pixels per CSS pixel.
 */
export function paintAtlasMask(
  context: CanvasRenderingContext2D,
  feature: Feature,
  project: (position: [number, number]) => { x: number; y: number },
  scale: number,
): void {
  const geometry = feature.geometry;
  const polygons =
    geometry?.type === "Polygon"
      ? [geometry.coordinates]
      : geometry?.type === "MultiPolygon"
        ? geometry.coordinates
        : [];
  if (!polygons.length) return;
  const { width, height } = context.canvas;
  context.save();
  context.beginPath();
  context.rect(0, 0, width, height);
  // Even-odd: the feature's rings cut it out, and its holes stay masked.
  for (const polygon of polygons)
    for (const ring of polygon as Position[][]) {
      // Each ring starts its own subpath at its first vertex that projects.
      let started = false;
      for (const position of ring) {
        let point: { x: number; y: number };
        try {
          point = project([position[0], position[1]]);
        } catch {
          continue;
        }
        if (started) context.lineTo(point.x * scale, point.y * scale);
        else context.moveTo(point.x * scale, point.y * scale);
        started = true;
      }
      if (started) context.closePath();
    }
  context.fillStyle = "rgba(255, 255, 255, 0.7)";
  context.fill("evenodd");
  context.restore();
}
