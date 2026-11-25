import type { MapEngine } from "@geolibre/map";
import { mercatorFitZoom } from "@geolibre/map/globe-fit-bounds";
import type { NativeOfflinePackage } from "./native-offline-packages";

/** Frame a package without starting below its first available tile zoom. A
 * local archive may contain detailed tiles only, with no overview pyramid. */
export function frameNativeOfflinePackage(
  engine: Pick<MapEngine, "getRenderSurface" | "fitBounds" | "flyTo"> | null,
  entry: Pick<NativeOfflinePackage, "bbox" | "minZoom">,
): void {
  if (!engine) return;
  if (entry.minZoom === 0) {
    engine.fitBounds(entry.bbox);
    return;
  }
  const canvas = engine.getRenderSurface()?.getCanvas();
  const fittingZoom = canvas
    ? mercatorFitZoom(entry.bbox, { width: canvas.clientWidth, height: canvas.clientHeight }, 40)
    : null;
  const [west, south, east, north] = entry.bbox;
  const northing = (latitude: number) =>
    Math.asinh(Math.tan((Math.max(-85.051129, Math.min(85.051129, latitude)) * Math.PI) / 180));
  const centerLatitude =
    (Math.atan(Math.sinh((northing(south) + northing(north)) / 2)) * 180) / Math.PI;
  engine.flyTo({
    center: [(west + east) / 2, centerLatitude],
    zoom: Math.max(entry.minZoom, fittingZoom ?? entry.minZoom),
    bearing: 0,
    pitch: 0,
    duration: 800,
  });
}
