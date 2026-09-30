// The one place the annotator reaches into maplibre-gl-lidar's private state.
// The package exposes no API for editing loaded points (tracked upstream in
// opengeos/GeoLibre#2749, phase 1), so every private field read lives here,
// behind narrow functions that degrade to null when a field goes missing on a
// bump rather than throwing mid-edit.

import type { LidarControl } from "maplibre-gl-components";
import type { PointCloudData } from "maplibre-gl-lidar";
import type { ProjectionViewport } from "./selection";

/** A loaded cloud as the control's PointCloudManager stores it. */
interface ManagedPointCloud {
  id: string;
  data: PointCloudData;
}

interface PointCloudManagerInternals {
  _pointClouds?: Map<string, ManagedPointCloud>;
  getOptions?: () => { zOffset?: number; elevationRange?: [number, number] | null };
  updateStyle?: (options: { hiddenClassifications?: Set<number> }) => void;
}

interface ViewportManagerInternals {
  start?: () => void;
  stop?: () => void;
  forceUpdate?: () => void;
  isActive?: () => boolean;
}

interface LidarControlInternals {
  _pointCloudManager?: PointCloudManagerInternals;
  _viewportManagers?: Map<string, ViewportManagerInternals>;
  _streamingLoaders?: Map<string, { isLoading?: () => boolean }>;
  _eptStreamingLoaders?: Map<string, { isLoading?: () => boolean }>;
}

interface DeckOverlayInternals {
  _overlay?: { _deck?: { getViewports?: () => unknown[] } };
}

function internals(control: LidarControl): LidarControlInternals {
  return control as unknown as LidarControlInternals;
}

/**
 * The live point data of a loaded cloud. For a streamed COPC/EPT cloud the
 * arrays are views of the streaming loader's buffers, so edits persist while
 * streaming is paused (see {@link pauseStreaming}).
 *
 * @param control - The LiDAR control.
 * @param id - The point cloud id.
 * @returns The cloud's data, or null when it is not loaded.
 */
export function getCloudData(control: LidarControl, id: string): PointCloudData | null {
  return internals(control)._pointCloudManager?._pointClouds?.get(id)?.data ?? null;
}

/**
 * The display Z offset (e.g. auto Z offset) the renderer adds to every point.
 *
 * @param control - The LiDAR control.
 * @returns The offset in metres.
 */
export function getRenderZOffset(control: LidarControl): number {
  return internals(control)._pointCloudManager?.getOptions?.().zOffset ?? 0;
}

/**
 * The elevation filter the renderer applies (points outside are not drawn).
 *
 * @param control - The LiDAR control.
 * @returns `[min, max]` in metres, or null when unfiltered.
 */
export function getRenderElevationRange(control: LidarControl): [number, number] | null {
  return internals(control)._pointCloudManager?.getOptions?.().elevationRange ?? null;
}

/**
 * Recomputes point colours after classification codes changed in place.
 * Passing the hidden-class set is what makes the manager rebuild its colours.
 *
 * @param control - The LiDAR control.
 * @returns False when the manager is unavailable.
 */
export function refreshCloudColors(control: LidarControl): boolean {
  const manager = internals(control)._pointCloudManager;
  if (!manager?.updateStyle) return false;
  manager.updateStyle({ hiddenClassifications: new Set(control.getHiddenClassifications()) });
  return true;
}

/**
 * Stops level-of-detail streaming for a cloud so no node is evicted (which
 * would compact the buffers and drop edits) while an annotation session runs.
 *
 * @param control - The LiDAR control.
 * @param id - The point cloud id.
 * @returns A function that resumes streaming, or null for a non-streamed cloud.
 */
export function pauseStreaming(control: LidarControl, id: string): (() => void) | null {
  const manager = internals(control)._viewportManagers?.get(id);
  if (!manager?.stop || !manager.start) return null;
  manager.stop();
  return () => {
    manager.start?.();
    manager.forceUpdate?.();
  };
}

/**
 * Whether a streamed cloud still has node requests in flight.
 *
 * @param control - The LiDAR control.
 * @param id - The point cloud id.
 * @returns True while nodes are loading.
 */
export function isStreamingLoading(control: LidarControl, id: string): boolean {
  const own = internals(control);
  const loader = own._streamingLoaders?.get(id) ?? own._eptStreamingLoaders?.get(id);
  return Boolean(loader?.isLoading?.());
}

/**
 * The LiDAR overlay's current deck.gl viewport, which matches what is drawn.
 *
 * @param control - The LiDAR control.
 * @returns The viewport, or null before the overlay has rendered.
 */
export function getOverlayViewport(control: LidarControl): ProjectionViewport | null {
  const overlay = control.getDeckOverlay() as unknown as DeckOverlayInternals | undefined;
  const viewport = overlay?._overlay?._deck?.getViewports?.()[0];
  return (viewport as ProjectionViewport | undefined) ?? null;
}
