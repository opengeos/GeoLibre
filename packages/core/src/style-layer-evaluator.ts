import {
  Color,
  featureFilter,
  latest,
  normalizePropertyExpression,
} from "@maplibre/maplibre-gl-style-spec";

/** The geometry kinds a MapLibre style expression tells apart (`["geometry-type"]`). */
export type StyleGeometryKind = "Point" | "LineString" | "Polygon";

/** A feature as a style layer's expressions read it. */
export interface StyleFeatureInput {
  id?: string | number;
  properties: Record<string, unknown> | null | undefined;
  kind: StyleGeometryKind;
}

/** A style layer's filter and property values, evaluated as MapLibre would. */
export interface StyleLayerEvaluator {
  /** Whether the layer's `filter` keeps the feature at `zoom`. */
  passes: (zoom: number, feature: StyleFeatureInput) => boolean;
  /**
   * A paint or layout property's value for a feature at `zoom`: the layer's
   * value (a literal, a legacy function or an expression) or the spec's
   * default. A color comes back as `[r, g, b, a]` with channels 0-255 and
   * alpha 0-1; formatted text as its plain string. `undefined` for a property
   * the spec does not know or an expression that does not compile.
   */
  value: (
    group: "paint" | "layout",
    name: string,
    zoom: number,
    feature: StyleFeatureInput,
  ) => unknown;
}

interface StyleLayerInput {
  id?: string;
  type: string;
  filter?: unknown;
  paint?: Record<string, unknown>;
  layout?: Record<string, unknown>;
}

const GEOMETRY_TYPE: Record<StyleGeometryKind, number> = { Point: 1, LineString: 2, Polygon: 3 };

type Evaluate = (globals: { zoom: number }, feature: unknown) => unknown;

/**
 * Compile a MapLibre style layer's filter and properties for evaluation
 * outside MapLibre, for a renderer that draws the layer itself (the ArcGIS
 * renderer drawing a plugin's own GeoJSON overlay, say). Uses the style spec's
 * own evaluator, so data-driven and zoom expressions, legacy functions and
 * defaults behave as they do on MapLibre. Each property compiles once.
 *
 * @param layer - The style layer (its `type`, `filter`, `paint`, `layout`).
 * @returns The layer's evaluator.
 */
export function createStyleLayerEvaluator(layer: StyleLayerInput): StyleLayerEvaluator {
  const root = `layers[${layer.id ?? ""}]`;
  let filter: ((zoom: number, feature: unknown) => boolean) | null;
  try {
    const compiled = featureFilter(layer.filter as never, `${root}.filter`);
    filter = (zoom, feature) => compiled.filter({ zoom } as never, feature as never);
  } catch {
    // MapLibre refuses the layer outright; draw nothing rather than everything.
    filter = () => false;
  }
  const compiled = new Map<string, Evaluate | null>();
  const compile = (group: "paint" | "layout", name: string): Evaluate | null => {
    const key = `${group}/${name}`;
    if (compiled.has(key)) return compiled.get(key)!;
    const spec = (latest as unknown as Record<string, Record<string, unknown>>)[
      `${group}_${layer.type}`
    ]?.[name] as { default?: unknown } | undefined;
    let evaluate: Evaluate | null = null;
    if (spec) {
      const raw = layer[group]?.[name];
      try {
        const expression = normalizePropertyExpression(
          (raw ?? spec.default) as never,
          `${root}.${group}.${name}`,
          spec as never,
        );
        evaluate = (globals, feature) => expression.evaluate(globals as never, feature as never);
      } catch {
        evaluate = null;
      }
    }
    compiled.set(key, evaluate);
    return evaluate;
  };
  const input = (feature: StyleFeatureInput) => ({
    type: GEOMETRY_TYPE[feature.kind],
    id: feature.id,
    properties: feature.properties ?? {},
  });
  return {
    passes: (zoom, feature) => {
      try {
        return filter(zoom, input(feature));
      } catch {
        return false;
      }
    },
    value: (group, name, zoom, feature) => {
      const evaluate = compile(group, name);
      if (!evaluate) return undefined;
      let result: unknown;
      try {
        result = evaluate({ zoom }, input(feature));
      } catch {
        return undefined;
      }
      if (result instanceof Color) {
        const [r, g, b, a] = result.rgb;
        return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), a];
      }
      if (result && typeof result === "object" && "sections" in result) return String(result);
      return result;
    },
  };
}
