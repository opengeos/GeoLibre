import type { FeatureCollection } from "geojson";
import type { GeoLibreLayer } from "@geolibre/core";

export type ParameterType = "layer" | "number" | "string" | "boolean" | "select";

/** A single geometry family used to filter layer pickers. */
export type GeometryFamily = "point" | "line" | "polygon";

export interface ParameterOption {
  value: string;
  label: string;
}

export interface AlgorithmParameter {
  id: string;
  label: string;
  type: ParameterType;
  required?: boolean;
  default?: unknown;
  /** Help text shown beneath the field. */
  description?: string;
  /** Options for `type: "select"`. */
  options?: ParameterOption[];
  /** Numeric bounds/step for `type: "number"`. */
  min?: number;
  max?: number;
  step?: number;
  /** Restrict a `type: "layer"` picker to layers with these geometry families. */
  geometryFilter?: GeometryFamily[];
}

export interface ProcessingContext {
  layers: GeoLibreLayer[];
  parameters: Record<string, unknown>;
  log: (message: string) => void;
  fitBounds?: (bounds: [number, number, number, number]) => void;
  /** Add an algorithm result back to the map as a new GeoJSON layer. */
  addResultLayer?: (name: string, geojson: FeatureCollection) => void;
}

export interface ProcessingAlgorithm {
  id: string;
  name: string;
  description: string;
  parameters: AlgorithmParameter[];
  /** Optional grouping label for menus/lists (e.g. "Geometry", "Overlay"). */
  group?: string;
  /** Whether this algorithm can also run on the Python (GeoPandas) sidecar. */
  supportsSidecar?: boolean;
  run: (ctx: ProcessingContext) => Promise<void> | void;
}
