import { MinHeap } from "./heap";
import {
  getFeatureArea,
  isFeatureInBBox,
  computeRingAreaHectares,
  type FeatureLike,
} from "./geometry";

export interface RenderOptimizerOptions {
  /** Maximum number of features rendered in the active viewport (default: 500) */
  maxFeatures?: number;
  /** Primary property to sort by (default: 'area_ha') */
  sortProperty?: string;
  /** Sort direction: 'desc' (largest first) or 'asc' (smallest first). Default: 'desc' */
  sortOrder?: "desc" | "asc";
  /** Minimum area threshold (in hectares) below which micro-slivers are culled immediately (default: 0.0) */
  minAreaThreshold?: number;
  /** Debounce delay in milliseconds for map moveend events (default: 200ms) */
  debounceMs?: number;
  /** Callback fired whenever the limiter recalculates visible features */
  onLimitApplied?: (stats: LimiterStats) => void;
  /** Active viewport bounding box [minX, minY, maxX, maxY] */
  bbox?: [number, number, number, number] | null;
}

export interface LimiterStats {
  layerId?: string;
  totalInViewport: number;
  renderedCount: number;
  isCapped: boolean;
  maxFeatures: number;
  sortProperty: string;
  executionTimeMs: number;
}

export interface GeoJSONCollectionLike {
  type: string;
  features: FeatureLike[];
}

export interface OptimizeResult {
  optimizedGeoJSON: GeoJSONCollectionLike;
  stats: LimiterStats;
}

interface MapLibreSourceLike {
  setData?: (data: GeoJSONCollectionLike) => void;
}

interface MapLibreMapLike {
  on: (event: string, handler: () => void) => void;
  off: (event: string, handler: () => void) => void;
  getBounds: () => {
    getWest: () => number;
    getSouth: () => number;
    getEast: () => number;
    getNorth: () => number;
  };
  getSource: (id: string) => MapLibreSourceLike | undefined;
}

/**
 * Core Area-Priority Optimizer: Selects Top K features by surface area
 */
export function optimizeFeatureCollection(
  geojson: GeoJSONCollectionLike | null | undefined,
  options: RenderOptimizerOptions = {},
): OptimizeResult {
  const startTime =
    typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
  const maxFeatures = options.maxFeatures || 500;
  const sortProperty = options.sortProperty || "area_ha";
  const sortOrder = options.sortOrder || "desc";
  const minAreaThreshold = options.minAreaThreshold || 0.0;
  const bbox = options.bbox || null;

  if (!geojson || !geojson.features || !Array.isArray(geojson.features)) {
    return {
      optimizedGeoJSON: { type: "FeatureCollection", features: [] },
      stats: {
        totalInViewport: 0,
        renderedCount: 0,
        isCapped: false,
        maxFeatures,
        sortProperty,
        executionTimeMs: 0,
      },
    };
  }

  const allFeatures = geojson.features;
  const inViewportFeatures: Array<{ feature: FeatureLike; area: number }> = [];

  for (let i = 0; i < allFeatures.length; i++) {
    const feat = allFeatures[i];
    if (bbox && !isFeatureInBBox(feat, bbox)) {
      continue;
    }
    const area = getFeatureArea(feat, sortProperty);
    if (area >= minAreaThreshold) {
      inViewportFeatures.push({ feature: feat, area });
    }
  }

  const totalInViewport = inViewportFeatures.length;
  let finalFeatures: FeatureLike[] = [];
  const isCapped = totalInViewport > maxFeatures;

  if (!isCapped) {
    inViewportFeatures.sort((a, b) => (sortOrder === "desc" ? b.area - a.area : a.area - b.area));
    finalFeatures = inViewportFeatures.map((item) => item.feature);
  } else {
    if (sortOrder === "desc") {
      const heap = new MinHeap<{ feature: FeatureLike; area: number }>((a, b) => a.area - b.area);
      for (let i = 0; i < inViewportFeatures.length; i++) {
        const item = inViewportFeatures[i];
        if (heap.size() < maxFeatures) {
          heap.push(item);
        } else if (item.area > heap.peek()!.area) {
          heap.pop();
          heap.push(item);
        }
      }
      finalFeatures = heap.toArraySortedDescending().map((item) => item.feature);
    } else {
      const heap = new MinHeap<{ feature: FeatureLike; area: number }>((a, b) => b.area - a.area);
      for (let i = 0; i < inViewportFeatures.length; i++) {
        const item = inViewportFeatures[i];
        if (heap.size() < maxFeatures) {
          heap.push(item);
        } else if (item.area < heap.peek()!.area) {
          heap.pop();
          heap.push(item);
        }
      }
      finalFeatures = heap.toArraySortedDescending().map((item) => item.feature);
    }
  }

  const endTime =
    typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
  const stats: LimiterStats = {
    totalInViewport,
    renderedCount: finalFeatures.length,
    isCapped,
    maxFeatures,
    sortProperty,
    executionTimeMs: +(endTime - startTime).toFixed(2),
  };

  return {
    optimizedGeoJSON: {
      type: "FeatureCollection",
      features: finalFeatures,
    },
    stats,
  };
}

/**
 * AreaPriorityLimiter Controller for MapLibre GL JS & GeoLibre
 */
export class AreaPriorityLimiter {
  private map: MapLibreMapLike | null;
  public sourceId?: string;
  public layerId?: string;
  public options: RenderOptimizerOptions;
  private rawGeoJSON: GeoJSONCollectionLike | null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private boundOnMoveEnd: () => void;
  private enabled: boolean = false;

  constructor(
    map: MapLibreMapLike | null,
    options: RenderOptimizerOptions & {
      sourceId?: string;
      layerId?: string;
      data?: GeoJSONCollectionLike;
    } = {},
  ) {
    this.map = map;
    this.sourceId = options.sourceId;
    this.layerId = options.layerId;
    this.options = {
      maxFeatures: options.maxFeatures || 500,
      sortProperty: options.sortProperty || "area_ha",
      sortOrder: options.sortOrder || "desc",
      minAreaThreshold: options.minAreaThreshold || 0.0,
      debounceMs: options.debounceMs || 200,
      onLimitApplied: options.onLimitApplied,
      ...options,
    };

    this.rawGeoJSON = options.data || null;
    this.boundOnMoveEnd = this.onMoveEnd.bind(this);
  }

  public setData(geojson: GeoJSONCollectionLike | null): void {
    this.rawGeoJSON = geojson;
    if (this.enabled) {
      this.apply();
    }
  }

  public setMaxFeatures(count: number): void {
    this.options.maxFeatures = count;
    if (this.enabled) {
      this.apply();
    }
  }

  public enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    if (this.map) {
      this.map.on("moveend", this.boundOnMoveEnd);
      this.map.on("zoomend", this.boundOnMoveEnd);
    }
    this.apply();
  }

  public disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    if (this.map) {
      this.map.off("moveend", this.boundOnMoveEnd);
      this.map.off("zoomend", this.boundOnMoveEnd);
    }
    if (this.sourceId && this.map && this.rawGeoJSON) {
      const src = this.map.getSource(this.sourceId);
      if (src && src.setData) {
        src.setData(this.rawGeoJSON);
      }
    }
  }

  private onMoveEnd(): void {
    if (!this.enabled) return;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => this.apply(), this.options.debounceMs);
  }

  public apply(): OptimizeResult | null {
    if (!this.rawGeoJSON || !this.map) return null;

    const bounds = this.map.getBounds();
    const bbox: [number, number, number, number] = [
      bounds.getWest(),
      bounds.getSouth(),
      bounds.getEast(),
      bounds.getNorth(),
    ];

    const result = optimizeFeatureCollection(this.rawGeoJSON, {
      ...this.options,
      bbox,
    });

    if (this.sourceId) {
      const src = this.map.getSource(this.sourceId);
      if (src && src.setData) {
        src.setData(result.optimizedGeoJSON);
      }
    }

    if (typeof this.options.onLimitApplied === "function") {
      this.options.onLimitApplied({
        layerId: this.layerId || this.sourceId,
        ...result.stats,
      });
    }

    return result;
  }
}

export { MinHeap, getFeatureArea, isFeatureInBBox, computeRingAreaHectares, type FeatureLike };
