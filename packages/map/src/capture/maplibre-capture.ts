import type maplibregl from "maplibre-gl";
import { isFullViewportMapCanvas } from "./canvas-surfaces";
import type { BBox, MapCaptureResult } from "../engine/types";

interface CaptureRect {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

function projectBounds(map: maplibregl.Map, bounds: BBox): CaptureRect {
  const [west, south, east, north] = bounds;
  const corners: Array<[number, number]> = [
    [west, north],
    [east, north],
    [east, south],
    [west, south],
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const corner of corners) {
    const point = map.project(corner);
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { minX, minY, maxX, maxY };
}

function cropCanvas(source: HTMLCanvasElement, rect: CaptureRect, dpr: number): HTMLCanvasElement {
  const x0 = Math.max(0, Math.floor(rect.minX * dpr));
  const y0 = Math.max(0, Math.floor(rect.minY * dpr));
  const x1 = Math.min(source.width, Math.ceil(rect.maxX * dpr));
  const y1 = Math.min(source.height, Math.ceil(rect.maxY * dpr));
  const width = x1 - x0;
  const height = y1 - y0;
  if (width < 1 || height < 1) {
    throw new Error("The requested capture bounds are outside the map viewport.");
  }
  const cropped = document.createElement("canvas");
  cropped.width = width;
  cropped.height = height;
  const context = cropped.getContext("2d");
  if (!context) throw new Error("Could not acquire a 2D context for the map crop.");
  context.drawImage(source, x0, y0, width, height, 0, 0, width, height);
  return cropped;
}

function haversineMeters(
  a: { readonly lng: number; readonly lat: number },
  b: { readonly lng: number; readonly lat: number },
): number {
  const radius = 6_371_008.8;
  const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
  const latitudeDelta = toRadians(b.lat - a.lat);
  const longitudeDelta = toRadians(b.lng - a.lng);
  const firstLatitude = toRadians(a.lat);
  const secondLatitude = toRadians(b.lat);
  const h =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
}

function groundResolution(
  map: maplibregl.Map,
  base: HTMLCanvasElement,
  rect: CaptureRect | null,
  dpr: number,
): number {
  const cssWidth = base.clientWidth || base.width;
  const cssHeight = base.clientHeight || base.height;
  let centerX = cssWidth / 2;
  let centerY = cssHeight / 2;
  if (rect) {
    centerX = (Math.max(0, rect.minX) + Math.min(cssWidth, rect.maxX)) / 2;
    centerY = (Math.max(0, rect.minY) + Math.min(cssHeight, rect.maxY)) / 2;
  }
  const span = Math.min(100, cssWidth / 2);
  if (!(span > 0)) return 0;
  const left = map.unproject([centerX - span / 2, centerY]);
  const right = map.unproject([centerX + span / 2, centerY]);
  const metersPerCssPixel = haversineMeters(left, right) / span;
  return dpr > 0 ? metersPerCssPixel / dpr : metersPerCssPixel;
}

/** Capture all full-viewport MapLibre/deck surfaces into one origin-clean canvas. */
export function captureMapLibreViewport(
  map: maplibregl.Map,
  options: { readonly bounds?: BBox } = {},
): MapCaptureResult {
  try {
    map.redraw();
  } catch {
    // A stale buffer is preferable to failing before attempting the capture.
  }

  const base = map.getCanvas();
  const composite = document.createElement("canvas");
  composite.width = base.width;
  composite.height = base.height;
  const context = composite.getContext("2d");
  if (!context) throw new Error("Could not acquire a 2D context for map capture.");

  for (const canvas of map.getContainer().querySelectorAll("canvas")) {
    if (canvas.classList.contains("geolibre-effects-canvas")) continue;
    if (!isFullViewportMapCanvas(canvas, base)) continue;
    try {
      context.drawImage(canvas, 0, 0, composite.width, composite.height);
    } catch (error) {
      if (canvas === base) throw error;
    }
  }

  const cssWidth = base.clientWidth || base.width;
  const dpr = cssWidth > 0 ? composite.width / cssWidth : 1;
  const rect = options.bounds ? projectBounds(map, options.bounds) : null;
  const metersPerPixel = groundResolution(map, base, rect, dpr);
  const canvas = rect ? cropCanvas(composite, rect, dpr) : composite;
  return {
    canvas,
    width: canvas.width,
    height: canvas.height,
    metersPerPixel,
    bearing: map.getBearing(),
  };
}
