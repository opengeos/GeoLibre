/// <reference path="../maplibre-gl-usgs-lidar.d.ts" />
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, useAppStore } from "@geolibre/core";
import type {
  LoadedItemInfo,
  UsgsLidarControl,
  UsgsLidarLayerAdapter,
} from "maplibre-gl-usgs-lidar";

/**
 * `metadata.sourceKind` of the Layers panel rows that mirror the USGS LiDAR
 * plugin's point clouds. Deliberately not the shared control's `lidar-url`:
 * `restoreLidarLayers` re-streams every `lidar-url` row through the shared
 * control, which would draw a USGS cloud a second time.
 */
export const USGS_LIDAR_SOURCE_KIND = "usgs-lidar";

// Not `usgs-lidar-*` or `lidar-*`: those prefixes are hidden from layer lists as
// internal helper layers (see internal-layers.ts).
const LAYER_ID_PREFIX = "usgs3dep-cloud:";

/**
 * The store layer id that mirrors one loaded USGS item.
 *
 * @param itemId - The USGS item id the control keys its loaded clouds by.
 * @returns The store layer id.
 */
export function usgsLidarLayerId(itemId: string): string {
  return `${LAYER_ID_PREFIX}${itemId}`;
}

function isUsgsLidarLayer(layer: GeoLibreLayer): boolean {
  return layer.type === "lidar" && layer.metadata.sourceKind === USGS_LIDAR_SOURCE_KIND;
}

function itemIdOf(layer: GeoLibreLayer): string | null {
  const itemId = layer.metadata.usgsItemId;
  return typeof itemId === "string" ? itemId : null;
}

/**
 * Build the store row for a loaded point cloud. It is `sessionOnly`: the cloud
 * lives in the control, which is gone once the panel closes, and STAC COPC
 * links are signed and expire, so the row is never written to a project.
 *
 * @param itemId - The USGS item id.
 * @param info - The loaded point cloud.
 * @returns The store layer.
 */
export function createUsgsLidarLayer(itemId: string, info: LoadedItemInfo): GeoLibreLayer {
  const id = usgsLidarLayerId(itemId);
  const { bounds } = info;
  return {
    id,
    name: info.name || itemId,
    type: "lidar",
    source: {
      type: "lidar",
      sourceId: id,
      bounds: [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY],
    },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      customLayerType: "lidar",
      externalNativeLayer: true,
      sessionOnly: true,
      identifiable: false,
      sourceKind: USGS_LIDAR_SOURCE_KIND,
      usgsItemId: itemId,
      pointCount: info.pointCount,
      hasClassification: info.hasClassification,
      hasIntensity: info.hasIntensity,
      hasRGB: info.hasRGB,
    },
  };
}

/**
 * Mirror the USGS LiDAR control's loaded point clouds into the store so they
 * show in the Layers panel, and keep the two in step: loading or unloading a
 * cloud in the panel adds or removes its row, and toggling, fading, or removing
 * the row acts on the cloud.
 *
 * @param control - The mounted USGS LiDAR control.
 * @param adapter - The layer adapter built on that control.
 * @returns A dispose function that stops syncing and removes the rows.
 */
export function bindUsgsLidarLayerSync(
  control: UsgsLidarControl,
  adapter: UsgsLidarLayerAdapter,
): () => void {
  const addRow = (itemId: string) => {
    const info = control.getState().loadedItems.get(itemId);
    if (!info) return;
    const store = useAppStore.getState();
    if (store.layers.some((layer) => layer.id === usgsLidarLayerId(itemId))) return;
    store.addLayer(createUsgsLidarLayer(itemId, info));
  };

  const stopAdapter = adapter.onLayerChange((event, itemId) => {
    if (event === "add") {
      addRow(itemId);
      return;
    }
    const store = useAppStore.getState();
    const id = usgsLidarLayerId(itemId);
    if (store.layers.some((layer) => layer.id === id)) store.removeLayer(id);
  });

  const stopStore = useAppStore.subscribe((state, previous) => {
    if (state.layers === previous.layers) return;
    const loaded = control.getState().loadedItems;
    // A row that reappears without its cloud (undoing a removal unloaded it)
    // has nothing behind it, so drop it rather than show a dead entry.
    const previousIds = new Set(previous.layers.map((layer) => layer.id));
    const orphans = state.layers.filter((layer) => {
      if (!isUsgsLidarLayer(layer) || previousIds.has(layer.id)) return false;
      const itemId = itemIdOf(layer);
      return !itemId || !loaded.has(itemId);
    });
    for (const orphan of orphans) useAppStore.getState().removeLayer(orphan.id);
    const currentById = new Map(state.layers.map((layer) => [layer.id, layer]));
    for (const layer of previous.layers) {
      if (!isUsgsLidarLayer(layer)) continue;
      const itemId = itemIdOf(layer);
      if (!itemId) continue;
      const current = currentById.get(layer.id);
      if (!current) {
        // Removed from the Layers panel (or undone): unload the cloud too. The
        // control's own unload event finds the row already gone.
        if (loaded.has(itemId)) control.unloadItem(itemId);
        continue;
      }
      if (current.visible !== layer.visible) adapter.setVisibility(itemId, current.visible);
      if (current.opacity !== layer.opacity) adapter.setOpacity(itemId, current.opacity);
    }
  });

  return () => {
    stopStore();
    stopAdapter();
    adapter.destroy();
    const store = useAppStore.getState();
    for (const layer of store.layers.filter(isUsgsLidarLayer)) store.removeLayer(layer.id);
  };
}
