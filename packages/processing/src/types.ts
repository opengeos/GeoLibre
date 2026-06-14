import type { FeatureCollection } from "geojson";
import type { GeoLibreLayer } from "@geolibre/core";

export type ParameterType =
  | "layer"
  | "number"
  | "string"
  | "boolean"
  | "select"
  | "field"
  | "path";

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
  /**
   * For `type: "field"`: the id of the `type: "layer"` parameter whose selected
   * layer supplies the attribute-field options. Defaults to `"layer"`.
   */
  fieldSource?: string;
  /**
   * Show this parameter only when another parameter's current value is `in`
   * (or `notIn`) the given list — e.g. hide a value field for operators that
   * ignore it. A hidden parameter is also skipped during required validation.
   * `in` and `notIn` are mutually exclusive.
   */
  visibleWhen?:
    | { param: string; in: string[] }
    | { param: string; notIn: string[] };
  /** File-dialog filters for `type: "path"` (a native file picker field). */
  fileFilters?: { name: string; extensions: string[] }[];
}

/** A GeoJSON FeatureCollection registered as a queryable DuckDB source. */
export interface DuckDbGeoJsonSource {
  /**
   * FROM-able SQL expression; its geometry column is named `geom`.
   *
   * Trust boundary: this value is interpolated verbatim into SQL by the tools
   * (e.g. `FROM ${sql}`). Implementations MUST produce it from
   * host-controlled input only (the built-in capability uses
   * `ST_Read(<quoted temp file>)`); never embed user-supplied content here, or
   * the consuming tool becomes a SQL-injection vector.
   */
  sql: string;
  /** Drop the registered source. Safe to call once. */
  release: () => Promise<void>;
}

/** Minimal DuckDB-WASM surface a processing tool needs. Injected by the host. */
export interface DuckDbCapability {
  /** Install + load the named extensions (e.g. `["spatial", "h3"]`). */
  ensureExtensions: (names: string[]) => Promise<void>;
  /** Register a FeatureCollection and return a SQL source handle. */
  registerGeoJson: (geojson: FeatureCollection) => Promise<DuckDbGeoJsonSource>;
  /** Run a query and return plain rows. */
  query: (sql: string) => Promise<Record<string, unknown>[]>;
}

export interface ProcessingContext {
  layers: GeoLibreLayer[];
  parameters: Record<string, unknown>;
  log: (message: string) => void;
  fitBounds?: (bounds: [number, number, number, number]) => void;
  /** Add an algorithm result back to the map as a new GeoJSON layer. */
  addResultLayer?: (name: string, geojson: FeatureCollection) => void;
  /** DuckDB-WASM capability, when the host provides it (browser/desktop). */
  duckdb?: DuckDbCapability;
  /** Current map viewport as [west, south, east, north], when available. */
  viewportBounds?: () => [number, number, number, number] | null;
  /**
   * Abort signal for long-running or networked tools (e.g. Network analysis),
   * so in-flight requests can be cancelled when the host dialog closes.
   */
  signal?: AbortSignal;
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
  /**
   * Whether this algorithm can ONLY run on a Python engine (sidecar/Pyodide) —
   * its client `run` is a no-op that defers. The dialog defaults the engine
   * selector to "sidecar" so the tool produces a result on the first run.
   * Implies {@link supportsSidecar}.
   */
  requiresSidecar?: boolean;
  run: (ctx: ProcessingContext) => Promise<void> | void;
}
