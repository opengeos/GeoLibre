// How the annotator reads and edits the LiDAR control's loaded points, through
// the point-editing API maplibre-gl-lidar added in 0.18 (opengeos/GeoLibre#2749,
// phase 1). Kept as one small module so the annotator depends on these
// functions, not on the control's surface.

import type { LidarControl } from "maplibre-gl-components";
import type { PointCloudData } from "maplibre-gl-lidar";
import type { ProjectionViewport } from "./selection";

/**
 * The live point data of a loaded cloud. Its arrays are the ones the layers
 * render from (for a streamed cloud, views of the loader's buffers), and its
 * `nodeRanges` give each point a stable identity.
 *
 * @param control - The LiDAR control.
 * @param id - The point cloud id.
 * @returns The cloud's data, or null when it is not loaded.
 */
export function getCloudData(control: LidarControl, id: string): PointCloudData | null {
  return control.getPointCloudData(id);
}

/**
 * The display Z offset (e.g. auto Z offset) the renderer adds to every point.
 *
 * @param control - The LiDAR control.
 * @returns The offset in metres.
 */
export function getRenderZOffset(control: LidarControl): number {
  return control.getRenderSettings().zOffset;
}

/**
 * The elevation filter the renderer applies (points outside are not drawn).
 *
 * @param control - The LiDAR control.
 * @returns `[min, max]` in metres, or null when unfiltered.
 */
export function getRenderElevationRange(control: LidarControl): [number, number] | null {
  return control.getRenderSettings().elevationRange;
}

/**
 * Recomputes point colours (and the control's class list) after
 * classification codes changed in place.
 *
 * @param control - The LiDAR control.
 */
export function refreshCloudColors(control: LidarControl): void {
  control.refreshPointColors();
}

/**
 * Pauses level-of-detail streaming for a cloud so no node is requested or
 * evicted (which would compact the buffers under an edit) during a session.
 *
 * @param control - The LiDAR control.
 * @param id - The point cloud id.
 * @returns A function that resumes streaming, or null for a non-streamed cloud.
 */
export function pauseStreaming(control: LidarControl, id: string): (() => void) | null {
  return control.pauseStreaming(id) ? () => control.resumeStreaming(id) : null;
}

/**
 * Whether a streamed cloud still has node requests queued or in flight.
 *
 * @param control - The LiDAR control.
 * @param id - The point cloud id.
 * @returns True while nodes are loading.
 */
export function isStreamingLoading(control: LidarControl, id: string): boolean {
  return control.isStreamingLoading(id);
}

/**
 * The LiDAR overlay's current deck.gl viewport, which matches what is drawn.
 *
 * @param control - The LiDAR control.
 * @returns The viewport, or null before the overlay has rendered.
 */
export function getOverlayViewport(control: LidarControl): ProjectionViewport | null {
  return (control.getDeckOverlay()?.getViewport() as ProjectionViewport | null | undefined) ?? null;
}

/**
 * Loads a streamed COPC cloud at full resolution inside `bounds` and pins it,
 * so a session can label the data's full density rather than the level of
 * detail the view happened to load.
 *
 * @param control - The LiDAR control.
 * @param id - The point cloud id.
 * @param bounds - `[west, south, east, north]` in degrees.
 * @param maxPoints - Largest region to load.
 * @returns The region's node and point counts.
 * @throws Error for a cloud that is not a streamed COPC, or a region too large.
 */
export function loadFullDetail(
  control: LidarControl,
  id: string,
  bounds: [number, number, number, number],
  maxPoints?: number,
): Promise<{ nodes: number; points: number }> {
  return control.loadRegion(id, bounds, maxPoints === undefined ? {} : { maxPoints });
}

/**
 * Unpins a region loaded by {@link loadFullDetail}.
 *
 * @param control - The LiDAR control.
 * @param id - The point cloud id.
 */
export function releaseFullDetail(control: LidarControl, id: string): void {
  control.clearPinnedRegion(id);
}
