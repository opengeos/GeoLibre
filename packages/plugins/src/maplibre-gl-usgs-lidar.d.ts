// maplibre-gl-usgs-lidar@0.11.0 ships complete declarations at dist/index.d.ts,
// but its package.json "types"/"exports" point to a nonexistent dist/types/
// path, so TypeScript resolves the module as `any`. This shim declares the
// subset of the API the USGS LiDAR plugin uses until the upstream pointer is
// fixed.
// TODO: delete this shim (and the maplibre-gl-lidar type-only dependency it
// pulls in below) once maplibre-gl-usgs-lidar ships a correct "types"/"exports"
// field — verify by removing it and running the type check.
declare module "maplibre-gl-usgs-lidar" {
  import type { IControl, Map as MapLibreMap } from "maplibre-gl";
  // `maplibre-gl-usgs-lidar`'s own types re-export `lidarControlOptions` typed
  // as `Partial<LidarControlOptions>` from `maplibre-gl-lidar`, so that package
  // must stay a direct dependency of @geolibre/plugins for this shim (the only
  // remaining consumer after the old LiDAR viewer was removed) to resolve.
  import type { LidarControlOptions, PointCloudInfo } from "maplibre-gl-lidar";

  /** A point cloud the control has loaded, named after its USGS item. */
  export interface LoadedItemInfo extends PointCloudInfo {
    name: string;
  }

  /** The subset of the control's state the layer sync reads. */
  export interface UsgsLidarState {
    /** Loaded point clouds, keyed by USGS item id. */
    loadedItems: Map<string, LoadedItemInfo>;
  }

  /**
   * Bridges the control's loaded items to a layer list: `add`/`remove` events
   * keyed by item id, and per-item visibility and opacity.
   */
  export class UsgsLidarLayerAdapter {
    constructor(usgsControl: UsgsLidarControl);
    getLayerIds(): string[];
    setVisibility(layerId: string, visible: boolean): void;
    setOpacity(layerId: string, opacity: number): void;
    onLayerChange(callback: (event: "add" | "remove", layerId: string) => void): () => void;
    destroy(): void;
  }

  export interface UsgsLidarControlOptions {
    /** Whether the control panel should start collapsed. @default true */
    collapsed?: boolean;
    /** Position of the control on the map. @default 'top-right' */
    position?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
    /** Title displayed in the control header. @default 'USGS 3DEP LiDAR' */
    title?: string;
    /** Width of the control panel in pixels. @default 380 */
    panelWidth?: number;
    /** Maximum height of the control panel in pixels. @default 600 */
    maxHeight?: number;
    /** Custom CSS class name. */
    className?: string;
    /** Maximum results per search. @default 50 */
    maxResults?: number;
    /** Show footprints on map when results are displayed. @default true */
    showFootprints?: boolean;
    /** Auto-zoom to footprints when showing results. @default true */
    autoZoomToResults?: boolean;
    /** Options forwarded to the internal LidarControl that renders points. */
    lidarControlOptions?: Partial<LidarControlOptions>;
  }

  /**
   * A MapLibre GL control for searching and visualizing USGS 3DEP LiDAR data.
   */
  export class UsgsLidarControl implements IControl {
    constructor(options?: Partial<UsgsLidarControlOptions>);
    onAdd(map: MapLibreMap): HTMLElement;
    onRemove(): void;
    /** Expands the panel. */
    expand(): void;
    /** Collapses the panel. */
    collapse(): void;
    /** Toggles the panel open/closed. */
    toggle(): void;
    /** The control's current state. */
    getState(): UsgsLidarState;
    /** Unloads one loaded item's point cloud. */
    unloadItem(itemId: string): void;
  }
}
