// Keeps the LiDAR measure mirror pointed at the current Measure and LiDAR
// controls.
// Split out of maplibre-components.ts (opengeos/GeoLibre#2633).

import type { LidarControl, MeasureControl } from "maplibre-gl-components";
import type { GeoLibreAppAPI } from "../../types";
import { syncLidarMeasureMirror } from "../lidar-measure-mirror";

// The Measure and LiDAR modules each register a reader for their current
// singleton here instead of importing each other, which keeps the dependency
// graph between the control modules acyclic.
let readLidarControl: () => LidarControl | null = () => null;
let readMeasureControl: () => MeasureControl | null = () => null;

/** Register how to read the current LiDAR control (called once by `./lidar`). */
export function setLidarControlReader(read: () => LidarControl | null): void {
  readLidarControl = read;
}

/** Register how to read the current Measure control (called once by `./measure`). */
export function setMeasureControlReader(read: () => MeasureControl | null): void {
  readMeasureControl = read;
}

/**
 * Re-point the LiDAR measure mirror at whatever the two singletons currently
 * are. Called from every path that mounts or tears down either control, so the
 * mirror follows the Measure panel and the LiDAR panel being opened, closed, or
 * rebuilt for another renderer (see `lidar-measure-mirror.ts`).
 */
export function refreshLidarMeasureMirror(app: GeoLibreAppAPI): void {
  syncLidarMeasureMirror({
    // The LiDAR panel runs on both 2D engines, and the mirror only needs the
    // source and event surface both maps share.
    map: app.getMap?.() ?? app.getMapboxMap?.() ?? null,
    overlay: readLidarControl()?.getDeckOverlay() ?? null,
    control: readMeasureControl(),
  });
}
