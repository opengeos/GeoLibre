import { useCallback, useMemo } from "react";
import type { TFunction } from "i18next";
import type { PrintLayoutConfig } from "@geolibre/core";
import type { LayoutOptions } from "../../../lib/print-layout";
import {
  buildChartBlock,
  buildTableBlock,
  DEFAULT_TABLE_COLUMNS,
  layerRows,
  MAX_TABLE_ROWS,
  rowForAtlasFeature,
  rowsIntersectingBounds,
  rowsWithinBounds,
  type PageFilterMode,
} from "../../../lib/print-data-blocks";
import {
  categoryColumnOptions,
  coerceNumericStringRows,
  numericColumns,
  type ChartRow,
} from "../../../lib/attribute-charts";
import {
  collectAtlasFeatures,
  expandBounds,
  listAtlasFields,
  type AtlasBounds,
  type AtlasFeatureInfo,
  type AtlasPage,
} from "../../../lib/print-atlas";
import type { AtlasSeries } from "./useAtlasSeries";

interface UseDataBlocksArgs {
  layout: PrintLayoutConfig;
  atlas: AtlasSeries;
  /** The atlas setting, AND-ed with the renderer being able to drive it. */
  atlasEnabled: boolean;
  atlasViewBounds: { index: number; bounds: AtlasBounds } | null;
  t: TFunction;
}

/**
 * The attribute table and chart blocks composed on the page (GH #1324): their
 * layers and fields, the rows after the optional page-extent filter, and the
 * drawable block specs for the current preview page.
 *
 * @returns The derived block data, plus the row filter and block builder the
 *   atlas export re-runs per page.
 */
export function useDataBlocks({
  layout,
  atlas,
  atlasEnabled,
  atlasViewBounds,
  t,
}: UseDataBlocksArgs) {
  const {
    captureMode,
    extentBbox,
    showDataTable,
    tableLayerId,
    tableTitle,
    tableColumns,
    tableSortField,
    tableSortDesc,
    tableMaxRows,
    tableFitRows,
    tablePosition,
    tablePageFilter,
    tableFilterToAtlasFeature,
    showDataChart,
    chartLayerId,
    chartTitle,
    chartType,
    chartCategoryField,
    chartAggregation,
    chartValueField,
    chartPosition,
    chartPageFilter,
  } = layout;
  const { atlasLayers, atlasLayer, currentAtlasPage, clampedAtlasIndex, atlasFitMarginPct } = atlas;
  // Any layer with loaded features qualifies (the same eligibility as an atlas
  // coverage layer: the extent filter needs per-feature geometry).
  const tableLayer = useMemo(
    () => atlasLayers.find((l) => l.id === tableLayerId) ?? null,
    [atlasLayers, tableLayerId],
  );
  const chartLayer = useMemo(
    () => atlasLayers.find((l) => l.id === chartLayerId) ?? null,
    [atlasLayers, chartLayerId],
  );
  const tableUsesAtlasLayer = Boolean(
    atlasEnabled && atlasLayer && tableLayer?.id === atlasLayer.id,
  );
  const tableFields = useMemo(
    () => (tableLayer?.geojson ? listAtlasFields(tableLayer.geojson.features) : []),
    [tableLayer],
  );
  const chartFields = useMemo(
    () => (chartLayer?.geojson ? listAtlasFields(chartLayer.geojson.features) : []),
    [chartLayer],
  );
  const tableAllRows = useMemo(
    () => (tableLayer?.geojson ? layerRows(tableLayer.geojson) : []),
    [tableLayer],
  );
  const chartAllRows = useMemo(() => {
    if (!chartLayer?.geojson) return [];
    // GeoJSON properties can also encode measurements as strings (for
    // example, data exported from a GIS form or database). Analyze a guarded
    // copy so those fields remain available as chart values without mutating
    // the layer or converting identifiers and leading-zero codes.
    return coerceNumericStringRows(layerRows(chartLayer.geojson));
  }, [chartLayer]);
  // Per-feature bounds for the page-extent filter, walked once per layer so
  // stepping/exporting an N-page atlas does not redo the vertex walk N times
  // (the same precompute pattern the atlas page builder uses).
  const tableFeatureInfos = useMemo(
    () => (tableLayer?.geojson ? collectAtlasFeatures(tableLayer.geojson) : []),
    [tableLayer],
  );
  const chartFeatureInfos = useMemo(
    () => (chartLayer?.geojson ? collectAtlasFeatures(chartLayer.geojson) : []),
    [chartLayer],
  );
  const chartCategoryOptions = useMemo(
    () => categoryColumnOptions(chartAllRows, chartFields),
    [chartAllRows, chartFields],
  );
  const chartNumericFields = useMemo(
    () => numericColumns(chartAllRows, chartFields),
    [chartAllRows, chartFields],
  );
  // Effective selections: the first suitable field stands in until the user
  // picks one, so enabling a block gives instant feedback.
  const effectiveCategoryField =
    chartCategoryField && chartFields.includes(chartCategoryField)
      ? chartCategoryField
      : (chartCategoryOptions[0] ?? "");
  const effectiveValueField =
    chartValueField && chartNumericFields.includes(chartValueField)
      ? chartValueField
      : (chartNumericFields[0] ?? "");
  const chartNeedsValueField = chartType === "line" || chartAggregation !== "count";
  const effectiveTableColumns = useMemo(() => {
    const chosen = tableColumns.filter((c) => tableFields.includes(c));
    return chosen.length > 0 ? chosen : tableFields.slice(0, DEFAULT_TABLE_COLUMNS);
  }, [tableColumns, tableFields]);

  // The extent a data block's "only features on the page" filter tests
  // against, before the page's real capture is available: the atlas page's
  // fitted bounds, or the drawn print extent when that is what the capture
  // clips to. Plain viewport captures don't filter. Once a page has actually
  // been captured, the map's true visible bounds override this approximation
  // (the viewBounds handed to rowsForBlock/buildBlocksFromRows) — the fit
  // expands the box on one axis for the page aspect, and fixed-scale mode
  // re-zooms after fitting.
  const dataFilterBounds = useCallback(
    (page: AtlasPage | null): AtlasBounds | null => {
      if (page) return expandBounds(page.bounds, atlasFitMarginPct);
      if (captureMode === "extent" && extentBbox) return extentBbox;
      return null;
    },
    [atlasFitMarginPct, captureMode, extentBbox],
  );

  // One block's rows after the optional page-extent filter. This is the
  // O(features) geometry walk, kept apart from the formatting step below so
  // it only re-runs when the layer, filter toggle, or bounds change.
  const rowsForBlock = useCallback(
    (
      features: readonly AtlasFeatureInfo[],
      allRows: ChartRow[],
      filterMode: PageFilterMode,
      bounds: AtlasBounds | null,
    ): ChartRow[] => {
      if (!bounds || filterMode === "all") return allRows;
      return filterMode === "contained"
        ? rowsWithinBounds(features, bounds)
        : rowsIntersectingBounds(features, bounds);
    },
    [],
  );

  // Formatting-only step: turn already-filtered rows into the drawable specs.
  // Cosmetic inputs (headings, positions, sort, chart type) only invalidate
  // this cheap step, not the extent scans above (per-keystroke lag review).
  const buildBlocksFromRows = useCallback(
    (
      tableRows: ChartRow[],
      chartRows: ChartRow[],
    ): Pick<LayoutOptions, "dataTable" | "dataChart"> => {
      let dataTable: LayoutOptions["dataTable"] = null;
      let dataChart: LayoutOptions["dataChart"] = null;
      if (showDataTable) {
        const data = buildTableBlock(tableRows, {
          columns: effectiveTableColumns,
          sortField: tableSortField || undefined,
          sortDescending: tableSortDesc,
          maxRows: tableFitRows ? MAX_TABLE_ROWS : tableMaxRows,
        });
        if (data) {
          dataTable = {
            title: tableTitle.trim() || undefined,
            columns: data.columns,
            rows: data.rows,
            truncated: data.truncated,
            // The final hidden-row count depends on how many rows fit the
            // page, which only the renderer knows; hand it the translation.
            formatNote: (count) => t("printLayout.dataTable.moreRows", { count }),
            position: tablePosition,
          };
        }
      }
      if (showDataChart) {
        const data = buildChartBlock(chartRows, {
          type: chartType,
          categoryField: effectiveCategoryField || undefined,
          aggregation: chartAggregation,
          valueField: effectiveValueField || undefined,
        });
        if (data) {
          dataChart = {
            title: chartTitle.trim() || undefined,
            position: chartPosition,
            data,
            // Translated "+N more" for bar categories past the top-N cap.
            formatNote: (count) => t("printLayout.dataTable.moreRows", { count }),
          };
        }
      }
      return { dataTable, dataChart };
    },
    [
      showDataTable,
      effectiveTableColumns,
      tableSortField,
      tableSortDesc,
      tableMaxRows,
      tableFitRows,
      tableTitle,
      tablePosition,
      showDataChart,
      chartType,
      effectiveCategoryField,
      chartAggregation,
      effectiveValueField,
      chartTitle,
      chartPosition,
      t,
    ],
  );

  // Bounds the display path filters against: the current page's captured view
  // bounds when they belong to it (while a newly selected page is still
  // capturing, fall back to its nominal bounds until the auto-drive refresh
  // lands), or the drawn print extent outside atlas mode.
  const displayFilterBounds = useMemo<AtlasBounds | null>(() => {
    const vb =
      atlasViewBounds && atlasViewBounds.index === clampedAtlasIndex
        ? atlasViewBounds.bounds
        : null;
    return (currentAtlasPage && vb) || dataFilterBounds(currentAtlasPage);
  }, [atlasViewBounds, clampedAtlasIndex, currentAtlasPage, dataFilterBounds]);
  const displayTableRows = useMemo(
    () =>
      showDataTable
        ? tableFilterToAtlasFeature && tableUsesAtlasLayer
          ? currentAtlasPage
            ? rowForAtlasFeature(tableAllRows, currentAtlasPage.sourceIndex)
            : []
          : rowsForBlock(tableFeatureInfos, tableAllRows, tablePageFilter, displayFilterBounds)
        : [],
    [
      showDataTable,
      rowsForBlock,
      tableFeatureInfos,
      tableAllRows,
      tablePageFilter,
      tableFilterToAtlasFeature,
      tableUsesAtlasLayer,
      currentAtlasPage,
      displayFilterBounds,
    ],
  );
  const displayChartRows = useMemo(
    () =>
      showDataChart
        ? rowsForBlock(chartFeatureInfos, chartAllRows, chartPageFilter, displayFilterBounds)
        : [],
    [
      showDataChart,
      rowsForBlock,
      chartFeatureInfos,
      chartAllRows,
      chartPageFilter,
      displayFilterBounds,
    ],
  );
  const displayDataBlocks = useMemo(
    () => buildBlocksFromRows(displayTableRows, displayChartRows),
    [buildBlocksFromRows, displayTableRows, displayChartRows],
  );

  return {
    tableLayer,
    chartLayer,
    tableUsesAtlasLayer,
    tableFields,
    tableAllRows,
    chartAllRows,
    tableFeatureInfos,
    chartFeatureInfos,
    chartCategoryOptions,
    chartNumericFields,
    effectiveCategoryField,
    effectiveValueField,
    chartNeedsValueField,
    effectiveTableColumns,
    rowsForBlock,
    buildBlocksFromRows,
    displayDataBlocks,
  };
}

/** The derived data blocks, as returned by {@link useDataBlocks}. */
export type DataBlocks = ReturnType<typeof useDataBlocks>;
