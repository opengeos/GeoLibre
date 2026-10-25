/**
 * Audit and classification of geospatial algorithms for WebAssembly SIMD128
 * and multi-worker parallel execution.
 */

export type AlgorithmParallelPattern =
  | "tileable-stencil" // Neighborhood filters with halo border (embarrassingly parallel)
  | "pixel-independent" // Point-wise raster math and reclassification
  | "topological-dag" // Flow accumulation and routing (requires topological sort/graph)
  | "priority-queue" // Depression filling / breaching (priority flood)
  | "radial-raymarch" // Viewshed line of sight (radial or quadrant partitionable)
  | "vector-batch"; // Independent feature batching

export interface AlgorithmProfile {
  id: string;
  name: string;
  category: "raster" | "terrain" | "hydrology" | "lidar" | "vector";
  pattern: AlgorithmParallelPattern;
  /** Whether the algorithm supports tile-based or chunk-based worker parallelization. */
  supportsThreading: boolean;
  /** Whether the inner numerical loops benefit from SIMD128 vectorization. */
  supportsSimd: boolean;
  /** Halo overlap in pixels required when running in tiled parallel chunks. */
  haloPixels?: number;
  notes: string;
}

export const ALGORITHM_PROFILES: Record<string, AlgorithmProfile> = {
  // --- Raster Filters & Neighborhood ---
  slope: {
    id: "slope",
    name: "Slope",
    category: "terrain",
    pattern: "tileable-stencil",
    supportsThreading: true,
    supportsSimd: true,
    haloPixels: 1,
    notes:
      "Horn's 3x3 finite-difference gradient. Embarrassingly parallel with 1-pixel border halo.",
  },
  aspect: {
    id: "aspect",
    name: "Aspect",
    category: "terrain",
    pattern: "tileable-stencil",
    supportsThreading: true,
    supportsSimd: true,
    haloPixels: 1,
    notes:
      "Horn's 3x3 finite-difference gradient with trigonometric atan2. Parallel across strips.",
  },
  hillshade: {
    id: "hillshade",
    name: "Hillshade",
    category: "terrain",
    pattern: "tileable-stencil",
    supportsThreading: true,
    supportsSimd: true,
    haloPixels: 1,
    notes: "Shaded relief with solar illumination vector. Highly amenable to SIMD dot products.",
  },
  mean_filter: {
    id: "mean_filter",
    name: "Mean Filter",
    category: "raster",
    pattern: "tileable-stencil",
    supportsThreading: true,
    supportsSimd: true,
    haloPixels: 2,
    notes: "Box blur / moving average. Parallelizable across horizontal raster stripes.",
  },
  gaussian_filter: {
    id: "gaussian_filter",
    name: "Gaussian Filter",
    category: "raster",
    pattern: "tileable-stencil",
    supportsThreading: true,
    supportsSimd: true,
    haloPixels: 3,
    notes: "Separable convolution filter. Inner kernel loop vectorizes efficiently with SIMD.",
  },
  focal_statistics: {
    id: "focal_statistics",
    name: "Focal Statistics",
    category: "raster",
    pattern: "tileable-stencil",
    supportsThreading: true,
    supportsSimd: true,
    haloPixels: 3,
    notes: "Sliding window statistics. Strip-based worker partitioning with radius halo.",
  },
  raster_calculator: {
    id: "raster_calculator",
    name: "Raster Calculator",
    category: "raster",
    pattern: "pixel-independent",
    supportsThreading: true,
    supportsSimd: true,
    haloPixels: 0,
    notes: "Pure point-wise arithmetic. 100% embarrassingly parallel with zero halo requirement.",
  },

  // --- Hydrology & Flow Routing (Topological / Sequential) ---
  d8_flow_accumulation: {
    id: "d8_flow_accumulation",
    name: "D8 Flow Accumulation",
    category: "hydrology",
    pattern: "topological-dag",
    supportsThreading: false,
    supportsSimd: false,
    notes:
      "Requires in-degree topological ordering from drainage divides to stream outlets. Arbitrary tiling causes boundary artifacts.",
  },
  d_inf_flow_accumulation: {
    id: "d_inf_flow_accumulation",
    name: "D-Infinity Flow Accumulation",
    category: "hydrology",
    pattern: "topological-dag",
    supportsThreading: false,
    supportsSimd: false,
    notes:
      "Multiple flow direction dispersion on triangular facets. Requires topological DAG traversal.",
  },
  fill_depressions: {
    id: "fill_depressions",
    name: "Fill Depressions",
    category: "hydrology",
    pattern: "priority-queue",
    supportsThreading: false,
    supportsSimd: false,
    notes:
      "Wang & Liu priority-flood algorithm. Centered around global min-heap queue; sequential across water levels.",
  },

  // --- Terrain Visibility ---
  viewshed: {
    id: "viewshed",
    name: "Viewshed",
    category: "terrain",
    pattern: "radial-raymarch",
    supportsThreading: true,
    supportsSimd: true,
    notes:
      "Line-of-sight raymarching. Rays can be divided across workers by angular sector or quadrant. Single ray has sequential slope accumulation.",
  },

  // --- Vector Batch ---
  buffer_vector: {
    id: "buffer_vector",
    name: "Buffer Vector",
    category: "vector",
    pattern: "vector-batch",
    supportsThreading: true,
    supportsSimd: false,
    notes:
      "Independent polygon offset calculations. Feature chunks can be distributed across workers.",
  },
};

/**
 * Check if a specific tool algorithm safely supports multi-worker parallel partitioning.
 */
export function isAlgorithmParallelizable(toolId: string): boolean {
  const profile = ALGORITHM_PROFILES[toolId];
  return profile ? profile.supportsThreading : false;
}

/**
 * Retrieve the algorithm performance profile and parallelization metadata.
 */
export function auditAlgorithm(toolId: string): AlgorithmProfile | undefined {
  return ALGORITHM_PROFILES[toolId];
}

/**
 * Check if a specific tool algorithm benefits from SIMD vectorization.
 */
export function isAlgorithmSimdEligible(toolId: string): boolean {
  const profile = ALGORITHM_PROFILES[toolId];
  return profile ? profile.supportsSimd : false;
}
