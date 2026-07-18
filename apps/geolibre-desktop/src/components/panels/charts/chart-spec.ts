/**
 * Pure (no-React) chart specification and compute dispatch shared by the
 * attribute Charts dialog and the Dashboard panel. Turns a {@link ChartSpec}
 * (chart type plus the field(s) it plots) into a typed {@link ChartResult} by
 * delegating to the field-level helpers in `attribute-charts`. Kept free of any
 * rendering so it can be unit-tested in isolation; the SVG drawing lives in
 * `chart-view`.
 */
import {
  computeBar,
  computeBox,
  computeHistogram,
  computeLine,
  computePie,
  computeScatter,
  DEFAULT_HISTOGRAM_BINS,
  numericValues,
  type BarAggregation,
  type BarResult,
  type BoxResult,
  type ChartRow,
  type ChartType,
  type HistogramResult,
  type LineResult,
  type PieResult,
  type ScatterResult,
} from "../../../lib/attribute-charts";

/** A chart type plus the field(s)/options it needs. Which keys apply depends on
 * `type`; unused keys are ignored. This is the render-side shape a dashboard
 * widget or the Charts dialog builds before computing. */
export interface ChartSpec {
  type: ChartType;
  /** Value field for histogram/line/box. */
  field?: string;
  /** X/Y fields for scatter. */
  xField?: string;
  yField?: string;
  /** Histogram bin count. */
  bins?: number;
  /** Category field for bar. */
  category?: string;
  /** Bar aggregation (default `count`). */
  aggregation?: BarAggregation;
  /** Value field a bar's sum/mean reduces. */
  valueField?: string;
}

/** The computed, ready-to-draw result for each chart type. `result` is null
 * when the spec's fields produced nothing to plot (an empty state is shown). */
export type ChartResult =
  | { type: "histogram"; result: HistogramResult | null; field: string }
  | {
      type: "scatter";
      result: ScatterResult | null;
      xField: string;
      yField: string;
    }
  | {
      type: "bar";
      result: BarResult | null;
      aggregation: BarAggregation;
      category: string;
    }
  | { type: "line"; result: LineResult | null; field: string }
  | { type: "box"; result: BoxResult | null; field: string }
  | {
      type: "pie";
      result: PieResult | null;
      category: string;
      aggregation: BarAggregation;
    };

/**
 * Compute a chart from `rows` and a {@link ChartSpec}. Pure (no React); the
 * Charts dialog and dashboard widgets both memoize over it. Returns a typed
 * result whose `result` is null when the chosen fields yield nothing to draw.
 *
 * @param rows The attribute rows to chart.
 * @param spec The chart type and field selections.
 * @returns A typed result for the chart type, ready for `ChartView`.
 */
export function computeChart(rows: ChartRow[], spec: ChartSpec): ChartResult {
  switch (spec.type) {
    case "histogram": {
      const field = spec.field ?? "";
      return {
        type: "histogram",
        field,
        result: field
          ? computeHistogram(numericValues(rows, field), spec.bins ?? DEFAULT_HISTOGRAM_BINS)
          : null,
      };
    }
    case "scatter": {
      const xField = spec.xField ?? "";
      const yField = spec.yField ?? "";
      return {
        type: "scatter",
        xField,
        yField,
        result: xField && yField ? computeScatter(rows, xField, yField) : null,
      };
    }
    case "bar": {
      const category = spec.category ?? "";
      const aggregation = spec.aggregation ?? "count";
      return {
        type: "bar",
        category,
        aggregation,
        result: category
          ? computeBar(
              rows,
              category,
              aggregation,
              aggregation === "count" ? null : (spec.valueField ?? ""),
            )
          : null,
      };
    }
    case "line": {
      const field = spec.field ?? "";
      return {
        type: "line",
        field,
        result: field ? computeLine(rows, field) : null,
      };
    }
    case "box": {
      const field = spec.field ?? "";
      return {
        type: "box",
        field,
        result: field ? computeBox(numericValues(rows, field)) : null,
      };
    }
    case "pie": {
      const category = spec.category ?? "";
      const aggregation = spec.aggregation ?? "count";
      return {
        type: "pie",
        category,
        aggregation,
        result: category
          ? computePie(
              rows,
              category,
              aggregation,
              aggregation === "count" ? null : (spec.valueField ?? ""),
            )
          : null,
      };
    }
  }
}

/** Whether a computed chart actually produced something to draw (an `<svg>`). */
export function chartResultHasData(result: ChartResult): boolean {
  return result.result !== null;
}
