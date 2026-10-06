import { shouldZoomToNewLayers } from "@geolibre/core";
import { addLidarLayerFromBytes } from "@geolibre/plugins/lidar";
import type { TFunction } from "i18next";

import { lidarOutputForMap } from "./lidar-export";

/** A point cloud file dropped on the map: a browser File, or bytes read from a desktop path. */
export interface DroppedPointCloud {
  name: string;
  data: File | Uint8Array;
}

/**
 * Whether a dropped file is a point cloud for the LiDAR control rather than
 * the vector/raster import pipeline: LAS, LAZ, or COPC (`.copc.laz`).
 *
 * @param name - The file name or path.
 * @returns True for `.las`/`.laz` files.
 */
export function isPointCloudFileName(name: string): boolean {
  return /\.la[sz]$/i.test(name.trim());
}

/**
 * Whether a point cloud load failed only because maplibre-gl-lidar reads whole
 * LAS/LAZ files no newer than LAS 1.3; such a file loads once converted to COPC.
 *
 * @param error - The load error.
 * @returns True for the LAS version error.
 */
export function isLasVersionError(error: unknown): boolean {
  return error instanceof Error && /file versions <= 1\.3/i.test(error.message);
}

/**
 * Add dropped point clouds to the map, one layer each. A COPC file streams
 * straight from the dropped file; a LAS 1.4 LAS/LAZ file the viewer cannot read
 * whole is converted to COPC in the browser and loaded from that instead.
 *
 * @param files - The dropped point clouds.
 * @param add - Loads one cloud (`addLidarLayerFromBytes` bound to the app);
 *   resolves to the new layer id, or null when the LiDAR control is unavailable.
 * @param onError - Reports a file that could not be added.
 * @returns How many layers were added.
 */
export async function addDroppedPointClouds(
  files: DroppedPointCloud[],
  add: (data: File | Uint8Array, name: string, fileName: string) => Promise<string | null>,
  onError: (name: string, error: unknown) => void,
): Promise<number> {
  let added = 0;
  for (const { name, data } of files) {
    const fileName = name.split(/[/\\]/).pop() || name;
    try {
      let id: string | null;
      try {
        id = await add(data, fileName, fileName);
      } catch (error) {
        if (!isLasVersionError(error)) throw error;
        const bytes = data instanceof File ? new Uint8Array(await data.arrayBuffer()) : data;
        const copc = await lidarOutputForMap(bytes, fileName);
        id = await add(copc.bytes, fileName, copc.fileName);
      }
      if (id !== null) added += 1;
    } catch (error) {
      onError(fileName, error);
    }
  }
  return added;
}

/**
 * Read point clouds dropped on the desktop app, which reports file paths. A
 * file that cannot be read is reported and skipped, so it does not cost the
 * rest of the drop.
 *
 * @param paths - The dropped LAS/LAZ/COPC paths.
 * @param read - Reads a local file's bytes.
 * @param onError - Reports a path that could not be read.
 * @returns The clouds that were read, named by path.
 */
export async function readDroppedPointClouds(
  paths: string[],
  read: (path: string) => Promise<Uint8Array>,
  onError: (name: string, error: unknown) => void,
): Promise<DroppedPointCloud[]> {
  const clouds: DroppedPointCloud[] = [];
  for (const path of paths) {
    try {
      clouds.push({ name: path, data: await read(path) });
    } catch (error) {
      onError(path.split(/[/\\]/).pop() || path, error);
    }
  }
  return clouds;
}

/**
 * The drop status line for a file that failed.
 *
 * @param name - The file name.
 * @param error - What went wrong.
 * @returns `name: message`.
 */
export function dropErrorMessage(name: string, error: unknown): string {
  return `${name}: ${error instanceof Error ? error.message : String(error)}`;
}

/** What {@link importPointCloudDrops} reports through and loads into. */
export interface PointCloudDropContext {
  app: Parameters<typeof addLidarLayerFromBytes>[0];
  setMessage: (message: string | null) => void;
  setError: (message: string) => void;
  t: TFunction;
}

/**
 * Add a drop's point clouds to the map with the drop status messages: a
 * loading note while they load, then how many layers were added, and one
 * error per file that failed.
 *
 * @param clouds - The dropped point clouds (none is a no-op).
 * @param context - The app to load into and the drop status setters.
 * @returns How many layers were added.
 */
export async function importPointCloudDrops(
  clouds: DroppedPointCloud[],
  { app, setMessage, setError, t }: PointCloudDropContext,
): Promise<number> {
  if (clouds.length === 0) return 0;
  setMessage(t("addData.lidar.dropLoading"));
  const added = await addDroppedPointClouds(
    clouds,
    (data, name, fileName) =>
      addLidarLayerFromBytes(app, data, { name, fileName, fit: shouldZoomToNewLayers() }),
    (name, error) => setError(dropErrorMessage(name, error)),
  );
  setMessage(added > 0 ? t("addData.lidar.dropAdded", { count: added }) : null);
  return added;
}
