import type { BBox, LngLat, MapCaptureResult, ScreenPoint } from "../engine/types";

export interface ArcGISScreenshot {
  readonly data: ImageData;
}

export interface ArcGISScreenshotView {
  readonly container: HTMLElement | null;
  takeScreenshot(options?: {
    readonly area?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  }): Promise<ArcGISScreenshot>;
  toScreen(point: { readonly longitude: number; readonly latitude: number }): ScreenPoint | null;
  toMap(point: ScreenPoint): { readonly longitude?: number; readonly latitude?: number } | null;
}

interface CaptureArea {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function haversineMeters(a: LngLat, b: LngLat): number {
  const radius = 6_371_008.8;
  const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
  const latitudeDelta = toRadians(b[1] - a[1]);
  const longitudeDelta = toRadians(b[0] - a[0]);
  const firstLatitude = toRadians(a[1]);
  const secondLatitude = toRadians(b[1]);
  const h =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
}

function screenshotArea(view: ArcGISScreenshotView, bounds: BBox | undefined): CaptureArea | null {
  if (!bounds) return null;
  const [west, south, east, north] = bounds;
  const corners = [
    view.toScreen({ longitude: west, latitude: north }),
    view.toScreen({ longitude: east, latitude: north }),
    view.toScreen({ longitude: east, latitude: south }),
    view.toScreen({ longitude: west, latitude: south }),
  ];
  if (corners.some((corner) => !corner)) {
    throw new Error("The requested capture bounds are outside the ArcGIS viewport.");
  }
  const points = corners as ScreenPoint[];
  const minX = Math.min(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxX = Math.max(...points.map((point) => point.x));
  const maxY = Math.max(...points.map((point) => point.y));
  if (!(maxX > minX && maxY > minY)) {
    throw new Error("The requested capture bounds have no visible ArcGIS viewport area.");
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function metersPerPixel(
  view: ArcGISScreenshotView,
  area: CaptureArea | null,
  imageWidth: number,
): number {
  const rect = view.container?.getBoundingClientRect();
  const cssWidth = area?.width ?? rect?.width ?? 0;
  if (!(cssWidth > 0) || !(imageWidth > 0)) return 0;
  const centerX = area ? area.x + area.width / 2 : cssWidth / 2;
  const centerY = area ? area.y + area.height / 2 : (rect?.height ?? 0) / 2;
  const span = Math.min(100, cssWidth / 2);
  if (!(span > 0)) return 0;
  const left = view.toMap({ x: centerX - span / 2, y: centerY });
  const right = view.toMap({ x: centerX + span / 2, y: centerY });
  if (
    typeof left?.longitude !== "number" ||
    typeof left.latitude !== "number" ||
    typeof right?.longitude !== "number" ||
    typeof right.latitude !== "number"
  ) {
    return 0;
  }
  const devicePixelsPerCssPixel = imageWidth / cssWidth;
  return haversineMeters([left.longitude, left.latitude], [right.longitude, right.latitude]) /
    span /
    devicePixelsPerCssPixel;
}

/** Convert the documented ArcGIS screenshot image data into the neutral capture result. */
export async function captureArcGISViewport(
  view: ArcGISScreenshotView,
  options: { readonly bounds?: BBox; readonly bearing?: number } = {},
): Promise<MapCaptureResult> {
  const area = screenshotArea(view, options.bounds);
  const screenshot = await view.takeScreenshot(area ? { area } : undefined);
  const document = view.container?.ownerDocument ?? globalThis.document;
  if (!document) throw new Error("Cannot create an ArcGIS capture canvas without a document.");
  const canvas = document.createElement("canvas");
  canvas.width = screenshot.data.width;
  canvas.height = screenshot.data.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not acquire a 2D context for the ArcGIS capture.");
  context.putImageData(screenshot.data, 0, 0);
  return {
    canvas,
    width: canvas.width,
    height: canvas.height,
    metersPerPixel: metersPerPixel(view, area, canvas.width),
    bearing: options.bearing ?? 0,
  };
}
