import type { GeoLibreLayer } from "@geolibre/core";

export type ParameterType = "layer" | "number" | "string" | "boolean";

export interface AlgorithmParameter {
  id: string;
  label: string;
  type: ParameterType;
  required?: boolean;
  default?: unknown;
}

export interface ProcessingContext {
  layers: GeoLibreLayer[];
  parameters: Record<string, unknown>;
  log: (message: string) => void;
  fitBounds?: (bounds: [number, number, number, number]) => void;
}

export interface ProcessingAlgorithm {
  id: string;
  name: string;
  description: string;
  parameters: AlgorithmParameter[];
  run: (ctx: ProcessingContext) => Promise<void> | void;
}
